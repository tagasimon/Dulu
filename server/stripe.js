// "Buy me a Rolex" for players outside Uganda — Stripe Checkout (card,
// Apple Pay, Google Pay). 1 Rolex = $1.99 = PASS_HOURS of online play; more
// Rolexes stack, same as Mobile Money in Uganda.
//
// Flow:
//   1. POST /stripe/checkout { rolexes, guestId } → we create a Checkout
//      Session (row saved first) and return its URL; the game opens it.
//   2. The player pays on Stripe's page; card details never touch DULU.
//   3. Stripe calls POST /stripe/webhook (signed). We also verify on return
//      and while the game polls GET /stripe/status. Whichever sees "paid"
//      first grants the time — exactly once.
//
// Only the REST API is used (no SDK). Never log STRIPE_SECRET_KEY.

import crypto from 'node:crypto';
import { HttpError } from './payments.js';

const TIMEOUT_MS = 30_000;
const MAX_ROLEXES = 10;
const SIGNATURE_TOLERANCE_S = 300;
const MAX_BODY_BYTES = 256 * 1024; // Stripe events can be a few KB

function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const t = Date.now();
    let e = hits.get(key);
    if (!e || t - e.start > windowMs) { e = { start: t, n: 0 }; hits.set(key, e); }
    e.n++;
    if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.start > windowMs) hits.delete(k);
    return e.n <= max;
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req, max = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new HttpError(413, 'Body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** Flatten { a: { b: 1 } } → "a[b]=1" for Stripe's form-encoded API. */
export function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}

/**
 * Verify a Stripe-Signature header ("t=…,v1=…") over the raw body.
 * @returns {boolean}
 */
export function verifyStripeSignature(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !header) return false;
  const parts = String(header).split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length) return false;
  if (Math.abs(nowSec - Number(t)) > SIGNATURE_TOLERANCE_S) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

/**
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   env?: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 *   onPassGranted?: (guestId: string, expiresAt: number) => void,
 *   log?: (...a: any[]) => void,
 *   now?: () => number,
 * }} opts
 */
export function createStripe(opts) {
  const { db } = opts;
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const onPassGranted = opts.onPassGranted ?? (() => {});
  const log = opts.log ?? ((...a) => console.log(new Date().toISOString(), ...a));
  const now = opts.now ?? (() => Date.now());
  const nowIso = () => new Date(now()).toISOString();

  const SECRET = env.STRIPE_SECRET_KEY || '';
  const WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET || '';
  const PRICE_CENTS = Number(env.ROLEX_PRICE_USD_CENTS) || 199;
  const CURRENCY = (env.ROLEX_CURRENCY || 'usd').toLowerCase();
  const PASS_HOURS = Number(env.PASS_HOURS) || 24;
  const PASS_MS = PASS_HOURS * 3600_000;
  const PUBLIC_URL = (env.PUBLIC_URL || '').replace(/\/$/, '');
  const STRIPE_API = (env.STRIPE_API_BASE || 'https://api.stripe.com/v1').replace(/\/$/, ''); // override only for tests

  const enabled = !!SECRET;
  const checkoutPerIp = limiter(10, 10 * 60_000);
  const restorePerIp = limiter(10, 60 * 60_000);

  const q = {
    insert: db.prepare(`INSERT INTO stripe_payments
      (id, session_id, guest_id, rolexes, amount_cents, currency, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`),
    bySession: db.prepare(`SELECT * FROM stripe_payments WHERE session_id = ?`),
    finalize: db.prepare(`UPDATE stripe_payments SET status = ?, confirmed_at = ?, email = COALESCE(?, email),
        raw_response = COALESCE(?, raw_response), updated_at = ?
      WHERE session_id = ? AND status = 'PENDING'`),
    passGet: db.prepare(`SELECT * FROM passes WHERE guest_id = ?`),
    passUpsert: db.prepare(`INSERT INTO passes (guest_id, msisdn, email, expires_at, updated_at) VALUES (?, NULL, ?, ?, ?)
      ON CONFLICT(guest_id) DO UPDATE SET email = COALESCE(excluded.email, passes.email),
        expires_at = excluded.expires_at, updated_at = excluded.updated_at`),
    passBestForEmail: db.prepare(`SELECT MAX(expires_at) AS expires_at FROM passes WHERE email = ?`),
  };

  function passFor(guestId) {
    const row = guestId ? q.passGet.get(guestId) : null;
    const exp = row ? Number(row.expires_at) : 0;
    return { active: exp > now(), expiresAt: exp > now() ? exp : null };
  }

  async function api(method, path, form) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(STRIPE_API + path, {
        method,
        signal: ac.signal,
        headers: {
          Authorization: `Bearer ${SECRET}`,
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: form ? formEncode(form) : undefined,
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      return { ok: res.ok, status: res.status, data };
    } finally {
      clearTimeout(t);
    }
  }

  /** Mark a session paid/failed exactly once and grant the Rolex time. */
  function finalize(sessionId, newStatus, session) {
    const email = session?.customer_details?.email ? String(session.customer_details.email).toLowerCase().slice(0, 200) : null;
    let grant = null;
    let applied = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = q.finalize.run(newStatus, newStatus === 'SUCCESS' ? nowIso() : null, email,
        session ? JSON.stringify({ id: session.id, payment_status: session.payment_status, amount_total: session.amount_total, currency: session.currency }) : null,
        nowIso(), sessionId);
      applied = Number(r.changes) === 1;
      if (applied && newStatus === 'SUCCESS') {
        const p = q.bySession.get(sessionId);
        // Grant for what was actually charged (never more than ordered).
        const paidCents = Number.isFinite(Number(session?.amount_total)) ? Number(session.amount_total) : Number(p.amount_cents);
        const rolexes = Math.min(Number(p.rolexes), Math.floor(paidCents / PRICE_CENTS));
        if (rolexes > 0) {
          const row = q.passGet.get(p.guest_id);
          const base = Math.max(now(), row ? Number(row.expires_at) : 0);
          const expiresAt = base + rolexes * PASS_MS;
          q.passUpsert.run(p.guest_id, email, expiresAt, now());
          grant = { guestId: p.guest_id, expiresAt, rolexes };
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    if (applied) {
      log('stripe', sessionId.slice(0, 18) + '…', newStatus, grant ? `+${grant.rolexes} Rolex(es)` : '');
      if (grant) { try { onPassGranted(grant.guestId, grant.expiresAt); } catch (e) { log('onPassGranted error', e); } }
    }
    return applied;
  }

  function baseUrl(req) {
    if (PUBLIC_URL) return PUBLIC_URL;
    const proto = String(req?.headers?.['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || 'localhost');
    return `${proto}://${host}`;
  }

  // ----- handlers (exported for tests)

  async function checkout(body, ip, req) {
    if (!enabled) throw new HttpError(503, 'Card payments are not set up yet.');
    if (!checkoutPerIp(ip || 'unknown')) throw new HttpError(429, 'Too many attempts. Please wait a few minutes.');
    const guestId = String(body?.guestId ?? '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(guestId)) throw new HttpError(400, 'Missing player ID. Reload the page and try again.');
    const rolexes = Number(body?.rolexes);
    if (!Number.isInteger(rolexes) || rolexes < 1 || rolexes > MAX_ROLEXES) {
      throw new HttpError(400, `Choose between 1 and ${MAX_ROLEXES} Rolexes.`);
    }
    const base = baseUrl(req);
    const r = await api('POST', '/checkout/sessions', {
      mode: 'payment',
      client_reference_id: guestId,
      success_url: `${base}/?rolex=paid&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/?rolex=cancelled`,
      line_items: {
        0: {
          quantity: rolexes,
          price_data: {
            currency: CURRENCY,
            unit_amount: PRICE_CENTS,
            product_data: {
              name: 'Rolex for DULU 🌯',
              description: `${PASS_HOURS} hours of online play per Rolex. Thanks for keeping the lights on!`,
            },
          },
        },
      },
      metadata: { guestId, rolexes, app: 'dulu' },
      payment_intent_data: { description: `DULU ${rolexes} Rolex${rolexes > 1 ? 'es' : ''}`, metadata: { guestId, app: 'dulu' } },
      allow_promotion_codes: 'false',
    }).catch((e) => {
      log('stripe checkout create failed', e?.name || e);
      throw new HttpError(502, 'Could not reach the payment service. Please try again.');
    });
    if (!r.ok || !r.data?.id || !r.data?.url) {
      const msg = r.data?.error?.message || 'The payment could not be started.';
      log('stripe checkout error', r.status, msg);
      throw new HttpError(400, msg);
    }
    const ts = nowIso();
    q.insert.run(crypto.randomUUID(), r.data.id, guestId, rolexes, rolexes * PRICE_CENTS, CURRENCY, ts, ts);
    return { sessionId: r.data.id, url: r.data.url, amountCents: rolexes * PRICE_CENTS, currency: CURRENCY };
  }

  async function status(sessionId) {
    const p = sessionId ? q.bySession.get(String(sessionId)) : null;
    if (!p) throw new HttpError(404, 'Payment not found.');
    if (p.status === 'PENDING' && enabled) {
      try {
        const r = await api('GET', `/checkout/sessions/${encodeURIComponent(p.session_id)}`);
        const s = r.data;
        if (r.ok && s) {
          if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') finalize(p.session_id, 'SUCCESS', s);
          else if (s.status === 'expired') finalize(p.session_id, 'FAILED', s);
        }
      } catch (e) {
        log('stripe status check failed', e?.name || e);
      }
    }
    const fresh = q.bySession.get(p.session_id);
    return { status: String(fresh.status).toLowerCase(), rolexes: Number(fresh.rolexes), pass: passFor(fresh.guest_id) };
  }

  /** @returns {{ status: number, body: object }} */
  function webhook(rawBody, signatureHeader) {
    if (!WEBHOOK_SECRET) {
      log('stripe webhook: STRIPE_WEBHOOK_SECRET is not set — rejecting');
      return { status: 400, body: { error: 'Webhook not configured' } };
    }
    if (!verifyStripeSignature(rawBody, signatureHeader, WEBHOOK_SECRET, Math.floor(now() / 1000))) {
      log('stripe webhook: bad signature');
      return { status: 400, body: { error: 'Bad signature' } };
    }
    let event;
    try { event = JSON.parse(rawBody.toString('utf8')); } catch { return { status: 400, body: { error: 'Bad JSON' } }; }
    const s = event?.data?.object;
    if (!s || s.object !== 'checkout.session' || s.metadata?.app !== 'dulu') {
      return { status: 200, body: { received: true, ignored: true } }; // other apps on the same Stripe account
    }
    const row = q.bySession.get(String(s.id));
    if (!row) { log('stripe webhook: unknown session'); return { status: 200, body: { received: true, processed: false } }; }
    let applied = false;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') applied = finalize(s.id, 'SUCCESS', s);
        break;
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed':
        applied = finalize(s.id, 'FAILED', s);
        break;
    }
    return { status: 200, body: { received: true, applied } };
  }

  function restore(body, ip) {
    if (!restorePerIp(ip || 'unknown')) throw new HttpError(429, 'Too many attempts. Please wait a while.');
    const guestId = String(body?.guestId ?? '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(guestId)) throw new HttpError(400, 'Missing player ID.');
    const email = String(body?.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter the email you paid with.');
    const best = Number(q.passBestForEmail.get(email)?.expires_at || 0);
    if (best <= now()) throw new HttpError(404, 'No active Rolex found for that email.');
    const mine = q.passGet.get(guestId);
    if (!mine || Number(mine.expires_at) < best) q.passUpsert.run(guestId, email, best, now());
    const pass = passFor(guestId);
    if (pass.active) onPassGranted(guestId, pass.expiresAt);
    return { pass };
  }

  function config() {
    return { enabled, priceCents: PRICE_CENTS, currency: CURRENCY, passHours: PASS_HOURS, maxRolexes: MAX_ROLEXES };
  }

  async function route(req, res, ip) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (!p.startsWith('/stripe/')) return false;
    try {
      if (req.method === 'POST' && p === '/stripe/checkout') {
        const body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}');
        sendJson(res, 200, await checkout(body, ip, req));
      } else if (req.method === 'GET' && p === '/stripe/status') {
        sendJson(res, 200, await status(url.searchParams.get('session_id')));
      } else if (req.method === 'POST' && p === '/stripe/webhook') {
        const out = webhook(await readBody(req), req.headers['stripe-signature']);
        sendJson(res, out.status, out.body);
      } else if (req.method === 'POST' && p === '/stripe/restore') {
        const body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}');
        sendJson(res, 200, restore(body, ip));
      } else {
        sendJson(res, 404, { error: 'Not found' });
      }
    } catch (e) {
      if (e instanceof HttpError) sendJson(res, e.status, { error: e.message });
      else if (e instanceof SyntaxError) sendJson(res, 400, { error: 'Bad JSON' });
      else { log('stripe route error', e); sendJson(res, 500, { error: 'Something went wrong.' }); }
    }
    return true;
  }

  return { enabled, passFor, config, checkout, status, webhook, restore, finalize, route };
}
