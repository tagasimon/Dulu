// "Buy me a Rolex" — inbound Relworx mobile-money collections.
// (A Rolex is Uganda's chapati-and-egg street food, ~2,000 UGX. Internally the
// code still calls the unit a "coffee"; players only ever see "Rolex".)
//
// One job: the player enters a phone number + how many coffees; Relworx pushes
// a Mobile Money PIN prompt to that phone; the money lands in the shared
// Relworx float. When a payment is confirmed (webhook or status poll) the
// player's anonymous guest ID gets online-play time (1 coffee = PASS_HOURS).
//
// NO payouts, NO wallet balance, NO cashout — that happens in Jukila.
// The PIN is NEVER entered here; the telco prompts the phone directly.

import crypto from 'node:crypto';

const DEFAULT_RELWORX_BASE = 'https://payments.relworx.com';
const RELWORX_TIMEOUT_MS = 30_000;
const MIN_AMOUNT_UGX = 500; // Relworx practical floor
const MAX_COFFEES = 10;
const MAX_BODY_BYTES = 16 * 1024;

// ---------------------------------------------------------------- helpers

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Uganda numbers → E.164 "+256XXXXXXXXX", or null if invalid. */
export function normalizePhone(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const s = String(input).replace(/\s+/g, '').replace(/[^\d+]/g, '');
  let out;
  if (s.startsWith('+256')) out = s;
  else if (s.startsWith('256')) out = '+' + s;
  else if (s.startsWith('0')) out = '+256' + s.slice(1);
  else if (/^\d{9}$/.test(s)) out = '+256' + s;
  else return null;
  return /^\+256\d{9}$/.test(out) ? out : null;
}


function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); } catch { return false; }
}

/** Tiny fixed-window rate limiter. */
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || now - e.start > windowMs) { e = { start: now, n: 0 }; hits.set(key, e); }
    e.n++;
    if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    return e.n <= max;
  };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------- service

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
export function createPayments(opts) {
  const { db } = opts;
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const onPassGranted = opts.onPassGranted ?? (() => {});
  const log = opts.log ?? ((...a) => console.log(new Date().toISOString(), ...a));
  const now = opts.now ?? (() => Date.now());
  const nowIso = () => new Date(now()).toISOString();

  const API_KEY = env.RELWORX_API_KEY || '';
  const ACCOUNT_NO = env.RELWORX_ACCOUNT_NO || '';
  const WEBHOOK_SECRET = env.RELWORX_WEBHOOK_SECRET || '';
  const REF_PREFIX = env.APP_REF_PREFIX || '';
  const PRICE_UGX = Number(env.ROLEX_PRICE_UGX || env.COFFEE_PRICE_UGX) || 2000;
  const PASS_HOURS = Number(env.PASS_HOURS) || 24;
  const PASS_MS = PASS_HOURS * 3600_000;
  const RELWORX_BASE = (env.RELWORX_BASE_URL || DEFAULT_RELWORX_BASE).replace(/\/$/, '');

  if (REF_PREFIX && /^JKP?-/i.test(REF_PREFIX)) {
    throw new Error('APP_REF_PREFIX must not start with "JK-"/"JKP-" (reserved by Jukila)');
  }

  /** Payments are live only when Relworx is configured; otherwise online play is free. */
  const enabled = !!(API_KEY && ACCOUNT_NO && REF_PREFIX);

  const collectPerIp = limiter(6, 10 * 60_000);      // stop prompt-spamming strangers' phones
  const restorePerIp = limiter(10, 60 * 60_000);

  // ----- prepared statements
  const q = {
    insert: db.prepare(`INSERT INTO payments
      (id, reference, msisdn, amount_ugx, description, status, guest_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`),
    setInternalRef: db.prepare(`UPDATE payments SET internal_ref = ?, raw_response = ?, updated_at = ? WHERE reference = ?`),
    setRaw: db.prepare(`UPDATE payments SET raw_response = ?, error_message = ?, updated_at = ? WHERE reference = ? AND status = 'PENDING'`),
    byRef: db.prepare(`SELECT * FROM payments WHERE reference = ?`),
    recentForMsisdn: db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE msisdn = ? AND created_at > ?`),
    // FINALIZE: compare-and-set — only a PENDING row can be claimed.
    finalize: db.prepare(`UPDATE payments SET
        status = ?, confirmed_at = ?, raw_response = COALESCE(?, raw_response),
        internal_ref = COALESCE(?, internal_ref), error_message = ?, updated_at = ?
      WHERE reference = ? AND status = 'PENDING'`),
    passGet: db.prepare(`SELECT * FROM passes WHERE guest_id = ?`),
    passUpsert: db.prepare(`INSERT INTO passes (guest_id, msisdn, expires_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(guest_id) DO UPDATE SET msisdn = COALESCE(excluded.msisdn, passes.msisdn),
        expires_at = excluded.expires_at, updated_at = excluded.updated_at`),
    passBestForMsisdn: db.prepare(`SELECT MAX(expires_at) AS expires_at FROM passes WHERE msisdn = ?`),
    // Background reconciler: PENDING payments Relworx accepted, oldest-checked first.
    pendingSince: db.prepare(`SELECT reference, created_at FROM payments
      WHERE status = 'PENDING' AND internal_ref IS NOT NULL AND created_at > ?
      ORDER BY updated_at ASC LIMIT ?`),
    touch: db.prepare(`UPDATE payments SET updated_at = ? WHERE reference = ? AND status = 'PENDING'`),
  };

  // ----- passes

  function passFor(guestId) {
    const row = guestId ? q.passGet.get(guestId) : null;
    const expiresAt = row ? Number(row.expires_at) : 0;
    return { active: expiresAt > now(), expiresAt: expiresAt > now() ? expiresAt : null };
  }

  function hasPass(guestId) {
    return !enabled || passFor(guestId).active;
  }

  /** Extend a pass by `ms`, stacking on any time left. Returns the new expiry. */
  function extendPass(guestId, msisdn, ms) {
    const row = q.passGet.get(guestId);
    const base = Math.max(now(), row ? Number(row.expires_at) : 0);
    const expiresAt = base + ms;
    q.passUpsert.run(guestId, msisdn, expiresAt, now());
    return expiresAt;
  }

  // ----- Relworx HTTP

  async function relworx(method, pathAndQuery, body) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), RELWORX_TIMEOUT_MS);
    try {
      const res = await fetchImpl(RELWORX_BASE + pathAndQuery, {
        method,
        signal: ac.signal,
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Accept: 'application/vnd.relworx.v2',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      let data = null;
      const text = await res.text();
      try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 300) }; }
      return { ok: res.ok, status: res.status, data };
    } finally {
      clearTimeout(t);
    }
  }

  // ----- FINALIZE (idempotent; webhook and poll may race)

  /**
   * @returns {boolean} true only for the single call that moved PENDING → final.
   */
  function finalize(reference, newStatus, reportedAmount, raw) {
    const rawJson = raw ? JSON.stringify(raw) : null;
    const internalRef = raw?.internal_reference ?? null;
    const errorMessage = newStatus === 'FAILED' ? (raw?.message ?? null) : null;
    const confirmedAt = newStatus === 'SUCCESS' ? nowIso() : null;

    let applied = false;
    let grant = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = q.finalize.run(newStatus, confirmedAt, rawJson, internalRef, errorMessage, nowIso(), reference);
      applied = Number(r.changes) === 1;
      if (applied && newStatus === 'SUCCESS') {
        const p = q.byRef.get(reference);
        // Grant for what was actually paid (never more than was requested).
        const paid = Number.isFinite(Number(reportedAmount)) && Number(reportedAmount) > 0
          ? Math.min(Number(reportedAmount), Number(p.amount_ugx))
          : Number(p.amount_ugx);
        const coffees = Math.floor(paid / PRICE_UGX);
        if (coffees > 0) {
          grant = { guestId: p.guest_id, expiresAt: extendPass(p.guest_id, p.msisdn, coffees * PASS_MS), coffees };
        } else {
          log('payment', reference, 'confirmed but amount', paid, 'is below one Rolex — no pass granted');
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    if (applied) {
      log('payment', reference, newStatus, grant ? `+${grant.coffees} Rolex(es)` : '');
      if (grant) {
        try { onPassGranted(grant.guestId, grant.expiresAt); } catch (e) { log('onPassGranted error', e); }
      }
    }
    return applied;
  }

  function mapStatus(s) {
    const v = String(s ?? '').toLowerCase();
    if (v === 'success' || v === 'successful' || v === 'completed') return 'SUCCESS';
    if (v === 'failed' || v === 'rejected' || v === 'cancelled' || v === 'canceled' || v === 'expired') return 'FAILED';
    return null;
  }

  function publicStatus(p) {
    return {
      reference: p.reference,
      status: String(p.status).toLowerCase(),
      amountUgx: Number(p.amount_ugx),
      confirmedAt: p.confirmed_at ?? null,
      message: p.status === 'FAILED' ? (p.error_message || 'Payment was not completed.') : undefined,
    };
  }

  // ----- route handlers (exported for tests)

  async function collect(body, ip) {
    if (!enabled) throw new HttpError(503, 'Payments are not set up yet.');
    if (!collectPerIp(ip || 'unknown')) throw new HttpError(429, 'Too many attempts. Please wait a few minutes.');

    const guestId = String(body?.guestId ?? '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(guestId)) throw new HttpError(400, 'Missing player ID. Reload the page and try again.');

    // Accept either a coffee count (what the game sends) or a raw amount.
    const count = body?.rolexes ?? body?.coffees;
    let amountUgx = count !== undefined ? Number(count) * PRICE_UGX : Number(body?.amountUgx);
    if (!Number.isInteger(amountUgx) || amountUgx < MIN_AMOUNT_UGX) {
      throw new HttpError(400, `Amount must be a whole number of at least ${MIN_AMOUNT_UGX} UGX.`);
    }
    if (amountUgx % PRICE_UGX !== 0 || amountUgx / PRICE_UGX > MAX_COFFEES) {
      throw new HttpError(400, `Choose between 1 and ${MAX_COFFEES} Rolexes.`);
    }

    const phone = normalizePhone(body?.phone);
    if (!phone) throw new HttpError(400, 'Enter a valid Ugandan mobile number, e.g. 0772 123456.');

    const tenMinAgo = new Date(now() - 10 * 60_000).toISOString();
    if (Number(q.recentForMsisdn.get(phone, tenMinAgo).n) >= 3) {
      throw new HttpError(429, 'Several requests were just sent to this number. Please wait a few minutes.');
    }

    const coffees = amountUgx / PRICE_UGX;
    const description = String(body?.description || `DULU ${coffees} Rolex${coffees > 1 ? 'es' : ''}`).slice(0, 60);
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    const reference = `${REF_PREFIX}${now().toString(36).toUpperCase()}${rand}`;
    if (reference.length < 8 || reference.length > 36) throw new HttpError(500, 'Bad APP_REF_PREFIX length.');

    // Rule: pre-create the row BEFORE calling Relworx.
    const ts = nowIso();
    q.insert.run(crypto.randomUUID(), reference, phone, amountUgx, description, guestId, ts, ts);

    let r;
    try {
      r = await relworx('POST', '/api/mobile-money/request-payment', {
        account_no: ACCOUNT_NO,
        msisdn: phone,
        amount: amountUgx,
        currency: 'UGX',
        reference,
        description,
      });
    } catch (e) {
      // Network/timeout: row stays PENDING — a late webhook can still resolve it.
      log('relworx request-payment failed', reference, e?.name || e);
      q.setRaw.run(null, 'Could not reach Relworx', nowIso(), reference);
      throw new HttpError(502, 'Could not reach the payment service. Please try again.');
    }

    if (!r.ok) {
      const msg = r.data?.message || r.data?.error || 'The payment could not be started.';
      q.setRaw.run(JSON.stringify(r.data), String(msg), nowIso(), reference);
      throw new HttpError(400, String(msg));
    }

    const internalRef = r.data?.internal_reference ?? r.data?.data?.internal_reference ?? null;
    q.setInternalRef.run(internalRef, JSON.stringify(r.data), nowIso(), reference);
    return {
      reference,
      internalReference: internalRef,
      amountUgx,
      coffees,
      msisdn: phone,
      message: 'Approve the prompt on your phone.',
    };
  }

  async function status(reference) {
    const p = reference ? q.byRef.get(String(reference)) : null;
    if (!p) throw new HttpError(404, 'Payment not found.');

    if (p.status !== 'PENDING' || !p.internal_ref || !enabled) {
      return { ...publicStatus(p), pass: passFor(p.guest_id) };
    }

    let r;
    try {
      const qs = new URLSearchParams({ internal_reference: p.internal_ref, account_no: ACCOUNT_NO });
      r = await relworx('GET', `/api/mobile-money/check-request-status?${qs}`);
    } catch (e) {
      log('relworx check-request-status failed', reference, e?.name || e);
      return { ...publicStatus(p), pass: passFor(p.guest_id) };
    }
    const d = r.data?.data && typeof r.data.data === 'object' ? { ...r.data, ...r.data.data } : (r.data || {});
    const mapped = r.ok ? mapStatus(d.request_status ?? d.status) : null;
    if (mapped === 'SUCCESS') finalize(p.reference, 'SUCCESS', d.amount, d);
    else if (mapped === 'FAILED') finalize(p.reference, 'FAILED', null, d);

    const fresh = q.byRef.get(p.reference);
    return { ...publicStatus(fresh), pass: passFor(fresh.guest_id) };
  }

  /**
   * @returns {{ status: number, body: object }}
   */
  function webhook(rawBody, signature) {
    if (!WEBHOOK_SECRET) {
      log('relworx webhook: RELWORX_WEBHOOK_SECRET is not set — rejecting');
      return { status: 401, body: { error: 'Unauthorized' } };
    }
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return { status: 400, body: { error: 'Bad JSON' } }; }

    // Spec: HMAC over JSON.stringify(parsed). Also accept HMAC over the raw
    // bytes in case serialisation differs.
    const sig = String(signature || '').trim().toLowerCase();
    const viaParsed = crypto.createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(payload)).digest('hex');
    const viaRaw = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
    if (!safeEqualHex(sig, viaParsed) && !safeEqualHex(sig, viaRaw)) {
      log('relworx webhook: signature mismatch');
      return { status: 401, body: { error: 'Unauthorized' } };
    }

    const reference = payload?.reference ?? payload?.customer_reference;
    const p = reference ? q.byRef.get(String(reference)) : null;
    if (!p) {
      log('relworx webhook: unknown reference', reference);
      return { status: 200, body: { processed: false } };
    }
    const mapped = mapStatus(payload.status ?? payload.request_status);
    if (!mapped) return { status: 200, body: { processed: false, reason: 'status not final' } };
    const applied = finalize(p.reference, mapped, payload.amount, payload);
    return { status: 200, body: { processed: true, applied } };
  }

  function restore(body, ip) {
    if (!enabled) return { pass: { active: true, expiresAt: null } };
    if (!restorePerIp(ip || 'unknown')) throw new HttpError(429, 'Too many attempts. Please wait a while.');
    const guestId = String(body?.guestId ?? '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(guestId)) throw new HttpError(400, 'Missing player ID.');
    const phone = normalizePhone(body?.phone);
    if (!phone) throw new HttpError(400, 'Enter the number you paid with, e.g. 0772 123456.');
    const best = Number(q.passBestForMsisdn.get(phone)?.expires_at || 0);
    if (best <= now()) throw new HttpError(404, 'No active Rolex found for that number.');
    const mine = q.passGet.get(guestId);
    if (!mine || Number(mine.expires_at) < best) q.passUpsert.run(guestId, phone, best, now());
    const pass = passFor(guestId);
    if (pass.active) onPassGranted(guestId, pass.expiresAt);
    return { pass };
  }

  function config(guestId) {
    return { enabled, priceUgx: PRICE_UGX, passHours: PASS_HOURS, maxCoffees: MAX_COFFEES, pass: enabled ? passFor(guestId) : { active: true, expiresAt: null } };
  }

  /** HTTP router. Returns true if the request was handled. */
  async function route(req, res, ip) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (!p.startsWith('/relworx/') && !p.startsWith('/api/coffee')) return false;
    try {
      if (req.method === 'POST' && p === '/relworx/collect') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        sendJson(res, 200, await collect(body, ip));
      } else if (req.method === 'GET' && p === '/relworx/status') {
        sendJson(res, 200, await status(url.searchParams.get('reference')));
      } else if (req.method === 'POST' && p === '/relworx/webhook') {
        const raw = await readBody(req);
        const out = webhook(raw, req.headers['x-relworx-signature']);
        sendJson(res, out.status, out.body);
      } else if (req.method === 'GET' && p === '/api/coffee') {
        sendJson(res, 200, config(url.searchParams.get('guestId')));
      } else if (req.method === 'POST' && p === '/api/coffee/restore') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        sendJson(res, 200, restore(body, ip));
      } else {
        sendJson(res, 404, { error: 'Not found' });
      }
    } catch (e) {
      if (e instanceof HttpError) sendJson(res, e.status, { error: e.message });
      else if (e instanceof SyntaxError) sendJson(res, 400, { error: 'Bad JSON' });
      else { log('payments route error', e); sendJson(res, 500, { error: 'Something went wrong.' }); }
    }
    return true;
  }

  // ----- background reconciler
  //
  // The Relworx account is shared with Jukila and has a single "request
  // payment webhook" URL, which points at Jukila. So DULU can't rely on the
  // webhook: the server polls Relworx itself for every payment still PENDING.
  // A player who approves the prompt after closing the page still gets their
  // coffee, and the game unlocks live if they're online.
  //   - payments younger than 15 min: checked every tick (~20 s)
  //   - 15 min – 24 h old: checked about every 5 min
  //   - older than 24 h: left alone (stay PENDING for manual review)
  const FRESH_MS = 15 * 60_000;
  const MAX_AGE_MS = 24 * 3600_000;
  const SLOW_EVERY_MS = 5 * 60_000;
  const lastSlowCheck = new Map();

  async function reconcileOnce(limit = 25) {
    if (!enabled) return 0;
    const t = now();
    const rows = q.pendingSince.all(new Date(t - MAX_AGE_MS).toISOString(), limit);
    let checked = 0;
    for (const r of rows) {
      const age = t - Date.parse(r.created_at);
      if (age > FRESH_MS) {
        const last = lastSlowCheck.get(r.reference) || 0;
        if (t - last < SLOW_EVERY_MS) continue;
        lastSlowCheck.set(r.reference, t);
      }
      q.touch.run(nowIso(), r.reference); // rotate through the queue fairly
      try { await status(r.reference); } catch (e) { log('reconcile error', r.reference, e?.message || e); }
      checked++;
    }
    if (lastSlowCheck.size > 5000) lastSlowCheck.clear();
    return checked;
  }

  /** Start polling in the background. Returns a stop function. */
  function startReconciler(everyMs = 20_000) {
    if (!enabled) return () => {};
    let running = false;
    const timer = setInterval(async () => {
      if (running) return; // never overlap (each Relworx call can take up to 30 s)
      running = true;
      try { await reconcileOnce(); } finally { running = false; }
    }, everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { enabled, priceUgx: PRICE_UGX, passHours: PASS_HOURS, hasPass, passFor, config, collect, status, webhook, restore, finalize, route, reconcileOnce, startReconciler };
}
