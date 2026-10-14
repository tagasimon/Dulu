// Run: npm test   (Node's built-in test runner; Relworx is mocked — no real calls)
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../server/db.js';
import { createPayments, normalizePhone, HttpError } from '../server/payments.js';

const ENV = {
  RELWORX_API_KEY: 'test-key',
  RELWORX_ACCOUNT_NO: 'REL123',
  RELWORX_WEBHOOK_SECRET: 'whsec',
  APP_REF_PREFIX: 'DULU-',
};
const GUEST = 'guest_abcdef123456';
const HOUR = 3600_000;

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const { status = 200, json = {} } = await handler(url, init);
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) };
  };
  fn.calls = calls;
  return fn;
}

function setup({ fetchHandler, env = ENV } = {}) {
  const db = openDb(':memory:');
  const granted = [];
  const fetchImpl = mockFetch(fetchHandler ?? (() => ({ json: { success: true, internal_reference: 'INT-1' } })));
  let clock = Date.parse('2026-10-14T12:00:00Z');
  const pay = createPayments({
    db, env, fetchImpl, log: () => {},
    now: () => clock,
    onPassGranted: (g, e) => granted.push({ g, e }),
  });
  return { db, pay, fetchImpl, granted, advance: (ms) => { clock += ms; }, now: () => clock };
}

function sign(payload, secret = ENV.RELWORX_WEBHOOK_SECRET) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

const row = (db, ref) => db.prepare('SELECT * FROM payments WHERE reference = ?').get(ref);

describe('normalizePhone', () => {
  test('accepts Ugandan formats', () => {
    assert.equal(normalizePhone('+256772123456'), '+256772123456');
    assert.equal(normalizePhone('256772123456'), '+256772123456');
    assert.equal(normalizePhone('0772 123 456'), '+256772123456');
    assert.equal(normalizePhone('772123456'), '+256772123456');
    assert.equal(normalizePhone('(0772) 123-456'), '+256772123456');
  });
  test('rejects junk', () => {
    for (const bad of ['', '12345', '+254712345678', '07721234', 'abc', null, undefined]) {
      assert.equal(normalizePhone(bad), null, String(bad));
    }
  });
});

describe('collect', () => {
  test('rejects invalid phone with 400', async () => {
    const { pay } = setup();
    await assert.rejects(pay.collect({ phone: '123', coffees: 1, guestId: GUEST }, 'ip'), (e) => e instanceof HttpError && e.status === 400);
  });

  test('rejects amount below 500 and non-coffee amounts', async () => {
    const { pay } = setup();
    await assert.rejects(pay.collect({ phone: '0772123456', amountUgx: 400, guestId: GUEST }, 'ip'), /at least 500/);
    await assert.rejects(pay.collect({ phone: '0772123456', amountUgx: 2500, guestId: GUEST }, 'ip'), /coffees/);
    await assert.rejects(pay.collect({ phone: '0772123456', coffees: 11, guestId: GUEST }, 'ip'), /coffees/);
    await assert.rejects(pay.collect({ phone: '0772123456', coffees: 0, guestId: GUEST }, 'ip'), /at least 500/);
  });

  test('pre-creates a PENDING row, calls Relworx correctly and stores internalRef', async () => {
    let rowSeenDuringCall = null;
    const ctx = setup({
      fetchHandler: (url, init) => {
        const ref = JSON.parse(init.body).reference;
        rowSeenDuringCall = ctx.db.prepare('SELECT status FROM payments WHERE reference = ?').get(ref);
        return { json: { success: true, internal_reference: 'INT-777', message: 'Request accepted' } };
      },
    });
    const out = await ctx.pay.collect({ phone: '0772 123456', coffees: 3, guestId: GUEST }, 'ip');

    assert.equal(rowSeenDuringCall?.status, 'PENDING', 'row must exist before the Relworx call');
    assert.match(out.reference, /^DULU-[0-9A-Z]+$/);
    assert.ok(out.reference.length >= 8 && out.reference.length <= 36);
    assert.equal(out.amountUgx, 6000);
    assert.equal(out.msisdn, '+256772123456');
    assert.equal(out.internalReference, 'INT-777');

    const call = ctx.fetchImpl.calls[0];
    assert.equal(call.url, 'https://payments.relworx.com/api/mobile-money/request-payment');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Authorization, 'Bearer test-key');
    assert.equal(call.init.headers.Accept, 'application/vnd.relworx.v2');
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.ok(call.init.signal, 'uses an AbortController');
    assert.deepEqual(
      { ...call.body, description: undefined },
      { account_no: 'REL123', msisdn: '+256772123456', amount: 6000, currency: 'UGX', reference: out.reference, description: undefined },
    );
    assert.equal('pin' in call.body, false);

    const r = row(ctx.db, out.reference);
    assert.equal(r.status, 'PENDING');
    assert.equal(r.internal_ref, 'INT-777');
    assert.equal(r.amount_ugx, 6000);
    assert.equal(r.guest_id, GUEST);
  });

  test('surfaces the Relworx error message on non-2xx and leaves the row PENDING', async () => {
    const { pay, db } = setup({ fetchHandler: () => ({ status: 422, json: { success: false, message: 'Insufficient balance on subscriber account' } }) });
    await assert.rejects(
      pay.collect({ phone: '0772123456', coffees: 1, guestId: GUEST }, 'ip'),
      (e) => e.status === 400 && /Insufficient balance/.test(e.message),
    );
    const r = db.prepare('SELECT * FROM payments').get();
    assert.equal(r.status, 'PENDING');
    assert.match(r.error_message, /Insufficient balance/);
  });

  test('is disabled (503) when Relworx env vars are missing', async () => {
    const { pay } = setup({ env: {} });
    assert.equal(pay.enabled, false);
    assert.equal(pay.hasPass('anyone12345'), true, 'online play is free when payments are off');
    await assert.rejects(pay.collect({ phone: '0772123456', coffees: 1, guestId: GUEST }, 'ip'), (e) => e.status === 503);
  });

  test('refuses a Jukila reference prefix', () => {
    assert.throws(() => setup({ env: { ...ENV, APP_REF_PREFIX: 'JK-' } }), /JK/);
  });

  test('rate-limits prompts to the same number', async () => {
    const { pay } = setup();
    for (let i = 0; i < 3; i++) await pay.collect({ phone: '0772123456', coffees: 1, guestId: GUEST }, `ip${i}`);
    await assert.rejects(pay.collect({ phone: '0772123456', coffees: 1, guestId: GUEST }, 'ip9'), (e) => e.status === 429);
  });
});

describe('webhook', () => {
  test('401 on a bad signature (and when no secret is configured)', async () => {
    const { pay } = setup();
    const body = { reference: 'X', status: 'success' };
    assert.equal(pay.webhook(Buffer.from(JSON.stringify(body)), 'deadbeef').status, 401);
    const noSecret = setup({ env: { ...ENV, RELWORX_WEBHOOK_SECRET: '' } });
    assert.equal(noSecret.pay.webhook(Buffer.from(JSON.stringify(body)), sign(body)).status, 401);
  });

  test('200 on unknown reference', () => {
    const { pay } = setup();
    const body = { reference: 'DULU-NOPE', status: 'success', amount: 2000 };
    const out = pay.webhook(Buffer.from(JSON.stringify(body)), sign(body));
    assert.equal(out.status, 200);
    assert.equal(out.body.processed, false);
  });

  test('200 and no change on a non-final status', async () => {
    const { pay, db } = setup();
    const { reference } = await pay.collect({ phone: '0772123456', coffees: 1, guestId: GUEST }, 'ip');
    const body = { reference, status: 'pending' };
    assert.equal(pay.webhook(Buffer.from(JSON.stringify(body)), sign(body)).status, 200);
    assert.equal(row(db, reference).status, 'PENDING');
  });

  test('success grants 24h per coffee and notifies once', async () => {
    const { pay, db, granted, now } = setup();
    const { reference } = await pay.collect({ phone: '0772123456', coffees: 2, guestId: GUEST }, 'ip');
    const body = { reference, status: 'SUCCESS', amount: 4000, internal_reference: 'INT-1', message: 'ok' };
    const out = pay.webhook(Buffer.from(JSON.stringify(body)), sign(body));
    assert.equal(out.status, 200);
    assert.equal(out.body.applied, true);
    assert.equal(row(db, reference).status, 'SUCCESS');
    assert.ok(row(db, reference).confirmed_at);
    assert.equal(granted.length, 1);
    assert.equal(granted[0].e, now() + 48 * HOUR);
    assert.equal(pay.hasPass(GUEST), true);

    // Relworx retries the same webhook: still 200, nothing granted twice.
    const again = pay.webhook(Buffer.from(JSON.stringify(body)), sign(body));
    assert.equal(again.status, 200);
    assert.equal(again.body.applied, false);
    assert.equal(granted.length, 1);
  });

  test('accepts a signature over the raw bytes too', async () => {
    const { pay } = setup();
    const { reference } = await pay.collect({ phone: '0772123456', coffees: 1, guestId: GUEST }, 'ip');
    const raw = Buffer.from(`{ "reference": "${reference}", "status": "success", "amount": 2000 }`);
    const sig = crypto.createHmac('sha256', ENV.RELWORX_WEBHOOK_SECRET).update(raw).digest('hex');
    assert.equal(pay.webhook(raw, sig).body.applied, true);
  });

  test('failed/rejected marks FAILED with the message and grants nothing', async () => {
    const { pay, db, granted } = setup();
    const { reference } = await pay.collect({ phone: '0772123456', coffees: 1, guestId: GUEST }, 'ip');
    const body = { reference, status: 'REJECTED', message: 'User cancelled' };
    pay.webhook(Buffer.from(JSON.stringify(body)), sign(body));
    const r = row(db, reference);
    assert.equal(r.status, 'FAILED');
    assert.equal(r.error_message, 'User cancelled');
    assert.equal(granted.length, 0);
    assert.equal(pay.hasPass(GUEST), false);
  });

  test('grants only for what was actually paid', async () => {
    const { pay, granted, now } = setup();
    const { reference } = await pay.collect({ phone: '0772123456', coffees: 3, guestId: GUEST }, 'ip');
    const body = { reference, status: 'success', amount: 2000 };
    pay.webhook(Buffer.from(JSON.stringify(body)), sign(body));
    assert.equal(granted[0].e, now() + 24 * HOUR);
  });
});

describe('status poll', () => {
  test('finalizes on request_status success and is idempotent with the webhook', async () => {
    const ctx = setup({
      fetchHandler: (url) => url.includes('check-request-status')
        ? { json: { success: true, request_status: 'success', amount: 2000 } }
        : { json: { success: true, internal_reference: 'INT-9' } },
    });
    const { reference } = await ctx.pay.collect({ phone: '0772123456', coffees: 1, guestId: GUEST }, 'ip');

    const st = await ctx.pay.status(reference);
    assert.equal(st.status, 'success');
    assert.equal(st.pass.active, true);
    const pollCall = ctx.fetchImpl.calls.find((c) => c.url.includes('check-request-status'));
    assert.match(pollCall.url, /internal_reference=INT-9/);
    assert.match(pollCall.url, /account_no=REL123/);
    assert.equal(pollCall.init.method, 'GET');

    // Webhook arrives late: acknowledged, but nothing applied twice.
    const body = { reference, status: 'success', amount: 2000 };
    assert.equal(ctx.pay.webhook(Buffer.from(JSON.stringify(body)), sign(body)).body.applied, false);
    assert.equal(ctx.granted.length, 1);

    // Polling again doesn't call Relworx once final.
    const before = ctx.fetchImpl.calls.length;
    await ctx.pay.status(reference);
    assert.equal(ctx.fetchImpl.calls.length, before);
  });

  test('failed/rejected → failed; anything else → pending', async () => {
    let next = 'processing';
    const ctx = setup({
      fetchHandler: (url) => url.includes('check-request-status')
        ? { json: { request_status: next } }
        : { json: { internal_reference: 'INT-2' } },
    });
    const { reference } = await ctx.pay.collect({ phone: '0772123456', coffees: 1, guestId: GUEST }, 'ip');
    assert.equal((await ctx.pay.status(reference)).status, 'pending');
    next = 'rejected';
    assert.equal((await ctx.pay.status(reference)).status, 'failed');
  });

  test('404 for an unknown reference', async () => {
    const { pay } = setup();
    await assert.rejects(pay.status('DULU-NOPE'), (e) => e.status === 404);
  });
});

describe('FINALIZE', () => {
  test('concurrent calls → exactly one applied', async () => {
    const { pay, granted } = setup();
    const { reference } = await pay.collect({ phone: '0772123456', coffees: 1, guestId: GUEST }, 'ip');
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      Promise.resolve().then(() => pay.finalize(reference, 'SUCCESS', 2000, { reference }))));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(granted.length, 1);
  });

  test('concurrent webhook + poll on the same reference finalize once', async () => {
    const ctx = setup({
      fetchHandler: async (url) => {
        if (url.includes('check-request-status')) {
          await new Promise((r) => setTimeout(r, 5));
          return { json: { request_status: 'success', amount: 2000 } };
        }
        return { json: { internal_reference: 'INT-3' } };
      },
    });
    const { reference } = await ctx.pay.collect({ phone: '0772123456', coffees: 1, guestId: GUEST }, 'ip');
    const body = { reference, status: 'success', amount: 2000 };
    const [poll, hook] = await Promise.all([
      ctx.pay.status(reference),
      Promise.resolve().then(() => ctx.pay.webhook(Buffer.from(JSON.stringify(body)), sign(body))),
    ]);
    assert.equal(poll.status, 'success');
    assert.equal(hook.status, 200);
    assert.equal(ctx.granted.length, 1);
  });
});

describe('passes', () => {
  test('more coffees stack on time already left; expiry ends access', async () => {
    const { pay, advance } = setup();
    const pay1 = await pay.collect({ phone: '0772123456', coffees: 1, guestId: GUEST }, 'a');
    pay.finalize(pay1.reference, 'SUCCESS', 2000, null);
    advance(10 * HOUR);
    const pay2 = await pay.collect({ phone: '0772123456', coffees: 1, guestId: GUEST }, 'b');
    pay.finalize(pay2.reference, 'SUCCESS', 2000, null);
    advance(37 * HOUR); // 47h after first purchase: 24 + 24 = 48h in total
    assert.equal(pay.hasPass(GUEST), true);
    advance(2 * HOUR);
    assert.equal(pay.hasPass(GUEST), false);
  });

  test('restore by phone number copies an active pass to a new device', async () => {
    const { pay } = setup();
    const p = await pay.collect({ phone: '0772123456', coffees: 1, guestId: GUEST }, 'a');
    pay.finalize(p.reference, 'SUCCESS', 2000, null);
    const out = pay.restore({ phone: '+256 772 123456', guestId: 'newdevice_999999' }, 'ip');
    assert.equal(out.pass.active, true);
    assert.equal(pay.hasPass('newdevice_999999'), true);
    assert.throws(() => pay.restore({ phone: '0700000000', guestId: 'other_device_1' }, 'ip'), (e) => e.status === 404);
  });
});

describe('background reconciler (webhook slot belongs to Jukila)', () => {
  test('confirms a payment with no webhook and no client polling, and grants once', async () => {
    let state = 'pending';
    const ctx = setup({
      fetchHandler: (url) => url.includes('check-request-status')
        ? { json: { request_status: state, amount: 2000 } }
        : { json: { internal_reference: 'INT-R1' } },
    });
    const { reference } = await ctx.pay.collect({ phone: '0772123456', coffees: 1, guestId: GUEST }, 'ip');
    assert.equal(await ctx.pay.reconcileOnce(), 1);
    assert.equal(row(ctx.db, reference).status, 'PENDING');
    state = 'success'; // player approves after closing the page
    ctx.advance(20_000);
    await ctx.pay.reconcileOnce();
    assert.equal(row(ctx.db, reference).status, 'SUCCESS');
    assert.equal(ctx.granted.length, 1);
    // Nothing left to check afterwards
    assert.equal(await ctx.pay.reconcileOnce(), 0);
    assert.equal(ctx.granted.length, 1);
  });

  test('checks older payments only every 5 minutes and gives up after 24h', async () => {
    const ctx = setup({
      fetchHandler: (url) => url.includes('check-request-status')
        ? { json: { request_status: 'pending' } }
        : { json: { internal_reference: 'INT-R2' } },
    });
    await ctx.pay.collect({ phone: '0772123456', coffees: 1, guestId: GUEST }, 'ip');
    const polls = () => ctx.fetchImpl.calls.filter((c) => c.url.includes('check-request-status')).length;
    ctx.advance(20 * 60_000);
    await ctx.pay.reconcileOnce(); assert.equal(polls(), 1);
    ctx.advance(60_000);
    await ctx.pay.reconcileOnce(); assert.equal(polls(), 1, 'too soon for a slow re-check');
    ctx.advance(5 * 60_000);
    await ctx.pay.reconcileOnce(); assert.equal(polls(), 2);
    ctx.advance(25 * 3600_000);
    await ctx.pay.reconcileOnce(); assert.equal(polls(), 2, 'older than 24h: left alone');
  });

  test('does nothing when payments are off', async () => {
    const { pay } = setup({ env: {} });
    assert.equal(await pay.reconcileOnce(), 0);
  });
});
