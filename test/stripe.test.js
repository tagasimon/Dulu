// Stripe Checkout tests (Stripe is mocked — no real calls). Run: npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../server/db.js';
import { createStripe, verifyStripeSignature, formEncode } from '../server/stripe.js';
import { HttpError } from '../server/payments.js';

const ENV = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', PUBLIC_URL: 'https://dulu.example.com' };
const GUEST = 'guest_abcdef123456';
const HOUR = 3600_000;

function setup({ env = ENV, handler } = {}) {
  const db = openDb(':memory:');
  const calls = [];
  const sessions = new Map();
  let n = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const out = handler ? await handler(url, init, sessions) : null;
    if (out) return { ok: out.status < 300, status: out.status, text: async () => JSON.stringify(out.json) };
    if (url.endsWith('/checkout/sessions') && init.method === 'POST') {
      const id = `cs_test_${++n}`;
      const body = new URLSearchParams(init.body);
      const s = { id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}`, payment_status: 'unpaid', status: 'open',
        amount_total: Number(body.get('line_items[0][price_data][unit_amount]')) * Number(body.get('line_items[0][quantity]')),
        currency: body.get('line_items[0][price_data][currency]'), metadata: { app: 'dulu', guestId: body.get('metadata[guestId]') } };
      sessions.set(id, s);
      return { ok: true, status: 200, text: async () => JSON.stringify(s) };
    }
    const m = url.match(/\/checkout\/sessions\/([^/?]+)$/);
    if (m) return { ok: true, status: 200, text: async () => JSON.stringify(sessions.get(decodeURIComponent(m[1]))) };
    return { ok: false, status: 404, text: async () => '{}' };
  };
  const granted = [];
  let clock = Date.parse('2026-10-15T00:00:00Z');
  const stripe = createStripe({ db, env, fetchImpl, log: () => {}, now: () => clock, onPassGranted: (g, e) => granted.push({ g, e }) });
  return { db, stripe, calls, sessions, granted, now: () => clock, advance: (ms) => { clock += ms; } };
}

function signed(event, secret = ENV.STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.parse('2026-10-15T00:00:00Z') / 1000)) {
  const raw = Buffer.from(JSON.stringify(event));
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return { raw, header: `t=${t},v1=${sig}` };
}

describe('stripe checkout', () => {
  test('creates a $1.99-per-Rolex Checkout Session and saves it', async () => {
    const ctx = setup();
    const out = await ctx.stripe.checkout({ rolexes: 3, guestId: GUEST }, 'ip');
    assert.match(out.url, /^https:\/\/checkout\.stripe\.com\//);
    assert.equal(out.amountCents, 597);
    const call = ctx.calls[0];
    assert.equal(call.url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(call.init.headers.Authorization, 'Bearer sk_test_x');
    assert.equal(call.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const body = new URLSearchParams(call.init.body);
    assert.equal(body.get('mode'), 'payment');
    assert.equal(body.get('line_items[0][price_data][unit_amount]'), '199');
    assert.equal(body.get('line_items[0][price_data][currency]'), 'usd');
    assert.equal(body.get('line_items[0][quantity]'), '3');
    assert.equal(body.get('metadata[guestId]'), GUEST);
    assert.equal(body.get('metadata[app]'), 'dulu');
    assert.equal(body.get('client_reference_id'), GUEST);
    assert.equal(body.get('success_url'), 'https://dulu.example.com/?rolex=paid&session_id={CHECKOUT_SESSION_ID}');
    const row = ctx.db.prepare('SELECT * FROM stripe_payments').get();
    assert.equal(row.status, 'PENDING');
    assert.equal(row.amount_cents, 597);
  });

  test('validates input and is off without a key', async () => {
    const ctx = setup();
    await assert.rejects(ctx.stripe.checkout({ rolexes: 0, guestId: GUEST }, 'ip'), /Rolexes/);
    await assert.rejects(ctx.stripe.checkout({ rolexes: 11, guestId: GUEST }, 'ip'), /Rolexes/);
    await assert.rejects(ctx.stripe.checkout({ rolexes: 1, guestId: 'x' }, 'ip'), /player ID/);
    const off = setup({ env: {} });
    assert.equal(off.stripe.enabled, false);
    await assert.rejects(off.stripe.checkout({ rolexes: 1, guestId: GUEST }, 'ip'), (e) => e instanceof HttpError && e.status === 503);
  });

  test('surfaces Stripe errors', async () => {
    const ctx = setup({ handler: () => ({ status: 400, json: { error: { message: 'Invalid API Key provided' } } }) });
    await assert.rejects(ctx.stripe.checkout({ rolexes: 1, guestId: GUEST }, 'ip'), /Invalid API Key/);
  });
});

describe('stripe webhook', () => {
  test('checkout.session.completed (paid) grants 24h per Rolex, once', async () => {
    const ctx = setup();
    const { sessionId } = await ctx.stripe.checkout({ rolexes: 2, guestId: GUEST }, 'ip');
    const s = { ...ctx.sessions.get(sessionId), payment_status: 'paid', customer_details: { email: 'Fan@Example.com' } };
    const { raw, header } = signed({ type: 'checkout.session.completed', data: { object: s } });
    const out = ctx.stripe.webhook(raw, header);
    assert.equal(out.status, 200);
    assert.equal(out.body.applied, true);
    assert.equal(ctx.granted.length, 1);
    assert.equal(ctx.granted[0].e, ctx.now() + 48 * HOUR);
    // Stripe retries: no double grant
    assert.equal(ctx.stripe.webhook(raw, header).body.applied, false);
    assert.equal(ctx.granted.length, 1);
    const row = ctx.db.prepare('SELECT * FROM stripe_payments').get();
    assert.equal(row.status, 'SUCCESS');
    assert.equal(row.email, 'fan@example.com');
  });

  test('rejects bad / stale signatures and ignores other apps', async () => {
    const ctx = setup();
    const ev = { type: 'checkout.session.completed', data: { object: { id: 'cs_x', object: 'checkout.session', metadata: { app: 'dulu' } } } };
    assert.equal(ctx.stripe.webhook(Buffer.from(JSON.stringify(ev)), 't=1,v1=deadbeef').status, 400);
    const stale = signed(ev, ENV.STRIPE_WEBHOOK_SECRET, Math.floor(Date.parse('2026-10-14T00:00:00Z') / 1000));
    assert.equal(ctx.stripe.webhook(stale.raw, stale.header).status, 400);
    const other = signed({ type: 'checkout.session.completed', data: { object: { id: 'cs_y', object: 'checkout.session', metadata: { app: 'jukila' } } } });
    assert.equal(ctx.stripe.webhook(other.raw, other.header).body.ignored, true);
  });

  test('expired session is marked failed and grants nothing', async () => {
    const ctx = setup();
    const { sessionId } = await ctx.stripe.checkout({ rolexes: 1, guestId: GUEST }, 'ip');
    const { raw, header } = signed({ type: 'checkout.session.expired', data: { object: { ...ctx.sessions.get(sessionId), status: 'expired' } } });
    ctx.stripe.webhook(raw, header);
    assert.equal(ctx.db.prepare('SELECT status FROM stripe_payments').get().status, 'FAILED');
    assert.equal(ctx.granted.length, 0);
  });
});

describe('stripe status (return page / polling)', () => {
  test('verifies with Stripe and is idempotent with the webhook', async () => {
    const ctx = setup();
    const { sessionId } = await ctx.stripe.checkout({ rolexes: 1, guestId: GUEST }, 'ip');
    assert.equal((await ctx.stripe.status(sessionId)).status, 'pending');
    ctx.sessions.get(sessionId).payment_status = 'paid';
    const st = await ctx.stripe.status(sessionId);
    assert.equal(st.status, 'success');
    assert.equal(st.pass.active, true);
    const { raw, header } = signed({ type: 'checkout.session.completed', data: { object: ctx.sessions.get(sessionId) } });
    assert.equal(ctx.stripe.webhook(raw, header).body.applied, false);
    assert.equal(ctx.granted.length, 1);
  });

  test('404 for unknown session', async () => {
    const ctx = setup();
    await assert.rejects(ctx.stripe.status('cs_nope'), (e) => e.status === 404);
  });
});

describe('stripe restore + helpers', () => {
  test('restore by email copies an active pass to a new device', async () => {
    const ctx = setup();
    const { sessionId } = await ctx.stripe.checkout({ rolexes: 1, guestId: GUEST }, 'ip');
    ctx.stripe.finalize(sessionId, 'SUCCESS', { ...ctx.sessions.get(sessionId), payment_status: 'paid', customer_details: { email: 'fan@example.com' } });
    const out = ctx.stripe.restore({ email: ' FAN@example.com ', guestId: 'new_device_1234' }, 'ip');
    assert.equal(out.pass.active, true);
    assert.throws(() => ctx.stripe.restore({ email: 'nobody@example.com', guestId: 'another_device_1' }, 'ip'), (e) => e.status === 404);
  });

  test('signature helper and form encoding', () => {
    const raw = Buffer.from('{"a":1}');
    const t = 1_800_000_000;
    const sig = crypto.createHmac('sha256', 's').update(`${t}.${raw}`).digest('hex');
    assert.equal(verifyStripeSignature(raw, `t=${t},v1=${sig}`, 's', t + 10), true);
    assert.equal(verifyStripeSignature(raw, `t=${t},v1=${sig}`, 'wrong', t + 10), false);
    assert.equal(formEncode({ a: { b: { 0: { c: 1 } } }, d: 'x y' }), 'a%5Bb%5D%5B0%5D%5Bc%5D=1&d=x%20y');
  });
});
