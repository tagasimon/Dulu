// "Buy me a Rolex" sheet (a Rolex is Uganda's chapati-and-egg street food).
// 1 Rolex = 24h of online play; more Rolexes stack.
//   • In Uganda: Mobile Money via Relworx, 2,000 UGX. The player enters a phone
//     number only; the PIN prompt comes from their network, never this page.
//   • Elsewhere: card / Apple Pay / Google Pay via Stripe Checkout, $1.99.
//     Stripe's page opens in a new tab so a game in progress isn't interrupted;
//     card details never touch DULU.
// (Internally the code still says "coffee" in places; players only see "Rolex".)

import { regionStore } from '../net/region';

export interface CardConfig {
  enabled: boolean;
  priceCents: number;
  currency: string;
  passHours: number;
  maxRolexes: number;
}

export interface CoffeeConfig {
  /** Mobile Money (Relworx) configured */
  enabled: boolean;
  priceUgx: number;
  passHours: number;
  maxCoffees: number;
  pass: { active: boolean; expiresAt: number | null };
  card?: CardConfig;
}

type View = 'buy' | 'waiting' | 'success' | 'failed' | 'slow' | 'restore';
type Method = 'mm' | 'card' | 'none';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const POLL_MS = 3000;
const MM_POLL_MAX_MS = 90_000;
const CARD_POLL_MAX_MS = 15 * 60_000; // card checkouts take longer

function fmtUgx(n: number) {
  return `${n.toLocaleString('en-UG')} UGX`;
}

function fmtMoney(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function fmtExpiry(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

function readLocal(key: string): string {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}
function saveLocal(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* ignore */ }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) throw new Error(data?.error || `Something went wrong (${res.status}).`);
  return data as T;
}

export class CoffeeSheet {
  config: CoffeeConfig = { enabled: false, priceUgx: 2000, passHours: 24, maxCoffees: 10, pass: { active: true, expiresAt: null } };
  /** Fired whenever the pass or config changes (menu line listens). */
  onChange: () => void = () => {};

  private el = $('coffee');
  private coffees = 1;
  private view: View = 'buy';
  private reference: string | null = null;  // Mobile Money reference
  private sessionId: string | null = null;  // Stripe Checkout session
  private pollTimer: number | null = null;
  private pollStarted = 0;
  private afterUnlock: (() => void) | null = null;
  /** gate = needed to play online; tip = a voluntary "thank you" */
  private mode: 'gate' | 'tip' = 'tip';
  /** Player in Uganda chose "pay by card instead" */
  private preferCard = false;
  /** Which method the current purchase uses */
  private active: Method = 'none';

  constructor(private guestId: () => string) {
    $('coffee-minus').addEventListener('click', () => this.setCount(this.coffees - 1));
    $('coffee-plus').addEventListener('click', () => this.setCount(this.coffees + 1));
    $('coffee-form').addEventListener('submit', (e) => { e.preventDefault(); this.buy(); });
    $('coffee-restore-form').addEventListener('submit', (e) => { e.preventDefault(); this.restore(); });
    $('coffee-restore-link').addEventListener('click', () => this.show('restore'));
    $('coffee-back').addEventListener('click', () => this.show('buy'));
    $('coffee-retry').addEventListener('click', () => this.show('buy'));
    $('coffee-continue').addEventListener('click', () => this.finish());
    $('coffee-close').addEventListener('click', () => this.close());
    $('coffee-card-link').addEventListener('click', () => { this.preferCard = !this.preferCard; this.show('buy'); });
    for (const id of ['coffee-phone', 'coffee-restore-phone']) {
      $(id).addEventListener('pointerdown', (e) => e.stopPropagation());
    }
  }

  private get card(): CardConfig | undefined {
    return this.config.card?.enabled ? this.config.card : undefined;
  }

  /** How this player pays right now. */
  get method(): Method {
    if (regionStore.value === 'UG') {
      if (this.preferCard && this.card) return 'card';
      if (this.config.enabled) return 'mm';
      return this.card ? 'card' : 'none';
    }
    return this.card ? 'card' : 'none';
  }

  /** Online play allowed right now? (mirrors the server's rule) */
  get unlocked() {
    const gateOn = regionStore.value === 'UG' ? this.config.enabled : !!this.card;
    return !gateOn || this.config.pass.active;
  }

  /** Kept for callers: "can pay with Mobile Money here?" */
  get mobileMoney() {
    return this.method === 'mm';
  }

  /** Any way to pay at all? (hides the Rolex buttons if not) */
  get canSupport() {
    return this.method !== 'none';
  }

  /** Voluntary support from the menu, game-over card or in-game button. */
  support() {
    if (this.canSupport) this.open(undefined, 'tip');
  }

  setConfig(c: CoffeeConfig) {
    this.config = c;
    this.onChange();
  }

  /** Server says a Rolex was confirmed (may arrive while the sheet is open). */
  setPass(pass: CoffeeConfig['pass']) {
    this.config.pass = pass;
    this.onChange();
    if (pass.active && !this.el.classList.contains('hidden') && (this.view === 'waiting' || this.view === 'slow')) {
      this.showSuccess();
    }
  }

  open(then?: () => void, mode: 'gate' | 'tip' = then ? 'gate' : 'tip') {
    this.afterUnlock = then ?? null;
    this.mode = mode;
    this.coffees = 1;
    this.show('buy');
    this.el.classList.remove('hidden');
  }

  close() {
    this.stopPolling();
    this.el.classList.add('hidden');
    this.afterUnlock = null;
  }

  /**
   * Back from Stripe (this tab was opened for checkout): confirm the payment
   * and say thanks. The original game tab is unlocked over the WebSocket.
   */
  handleCardReturn(sessionId: string) {
    this.active = 'card';
    this.sessionId = sessionId;
    this.mode = 'tip';
    this.afterUnlock = null;
    this.show('waiting');
    $('coffee-waiting-text').textContent = 'Confirming your payment…';
    this.el.classList.remove('hidden');
    this.startPolling(true);
  }

  // ---------------- actions

  private setCount(n: number) {
    const max = this.method === 'card' ? (this.card?.maxRolexes ?? 10) : this.config.maxCoffees;
    this.coffees = Math.max(1, Math.min(max, n));
    this.renderBuy();
  }

  private async buy() {
    if (this.method === 'card') return this.buyCard();
    const phoneInput = $<HTMLInputElement>('coffee-phone');
    const phone = phoneInput.value.trim();
    if (phone.replace(/\D/g, '').length < 9) {
      this.error('Enter your MTN or Airtel number, e.g. 0772 123456.');
      phoneInput.focus();
      return;
    }
    saveLocal('dulu.phone', phone);
    const btn = $<HTMLButtonElement>('coffee-buy-btn');
    btn.disabled = true;
    this.error('');
    try {
      const out = await api<{ reference: string }>('/relworx/collect', {
        method: 'POST',
        body: JSON.stringify({ phone, rolexes: this.coffees, guestId: this.guestId() }),
      });
      this.active = 'mm';
      this.reference = out.reference;
      this.show('waiting');
      $('coffee-waiting-text').textContent = 'Approve the Mobile Money prompt with your PIN. This page updates by itself once it goes through.';
      this.startPolling();
    } catch (e) {
      this.error((e as Error).message);
    } finally {
      btn.disabled = false;
    }
  }

  private async buyCard() {
    // Open the tab now, while we still have the tap (otherwise phones block it),
    // then point it at Stripe once the checkout is created.
    let tab: Window | null = null;
    try { tab = window.open('', '_blank'); } catch { tab = null; }
    if (tab) {
      try {
        tab.document.title = 'DULU — opening checkout…';
        tab.document.body.style.cssText = 'background:#1a0d08;color:#f5e6cf;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0';
        tab.document.body.textContent = 'Opening secure checkout…';
      } catch { /* ignore */ }
    }
    const btn = $<HTMLButtonElement>('coffee-buy-btn');
    btn.disabled = true;
    this.error('');
    try {
      const out = await api<{ sessionId: string; url: string }>('/stripe/checkout', {
        method: 'POST',
        body: JSON.stringify({ rolexes: this.coffees, guestId: this.guestId() }),
      });
      this.active = 'card';
      this.sessionId = out.sessionId;
      const link = $<HTMLAnchorElement>('coffee-card-open');
      link.href = out.url;
      if (tab && !tab.closed) {
        tab.location.href = out.url;
        link.classList.add('hidden');
      } else {
        link.classList.remove('hidden'); // pop-up blocked: let them tap through
      }
      this.show('waiting');
      $('coffee-waiting-text').textContent = tab
        ? 'Finish paying in the Stripe tab. This updates by itself when it goes through.'
        : 'Tap below to open the secure Stripe checkout. This updates by itself when it goes through.';
      this.startPolling(true);
    } catch (e) {
      try { tab?.close(); } catch { /* ignore */ }
      this.error((e as Error).message);
    } finally {
      btn.disabled = false;
    }
  }

  private async restore() {
    const value = $<HTMLInputElement>('coffee-restore-phone').value.trim();
    const err = $('coffee-restore-error');
    err.textContent = '';
    const byEmail = this.method === 'card' || value.includes('@');
    try {
      const out = await api<{ pass: CoffeeConfig['pass'] }>(byEmail ? '/stripe/restore' : '/api/coffee/restore', {
        method: 'POST',
        body: JSON.stringify(byEmail ? { email: value, guestId: this.guestId() } : { phone: value, guestId: this.guestId() }),
      });
      saveLocal(byEmail ? 'dulu.email' : 'dulu.phone', value);
      this.config.pass = out.pass;
      this.onChange();
      this.showSuccess(true);
    } catch (e) {
      err.textContent = (e as Error).message;
    }
  }

  private startPolling(card = false) {
    this.stopPolling();
    this.pollStarted = Date.now();
    const maxMs = card ? CARD_POLL_MAX_MS : MM_POLL_MAX_MS;
    const tick = async () => {
      try {
        const st = card
          ? await api<{ status: string; pass: CoffeeConfig['pass'] }>(`/stripe/status?session_id=${encodeURIComponent(this.sessionId || '')}`)
          : await api<{ status: string; message?: string; pass: CoffeeConfig['pass'] }>(`/relworx/status?reference=${encodeURIComponent(this.reference || '')}`);
        if (st.status === 'success') {
          this.config.pass = st.pass;
          this.onChange();
          this.showSuccess();
          return;
        }
        if (st.status === 'failed') {
          this.stopPolling();
          $('coffee-failed-text').textContent = (st as any).message || (card ? 'The checkout expired or was cancelled.' : 'The payment was not completed.');
          this.show('failed');
          return;
        }
      } catch { /* network blip — keep trying */ }
      if (Date.now() - this.pollStarted > maxMs) {
        this.stopPolling();
        this.show('slow');
        return;
      }
      this.pollTimer = window.setTimeout(tick, POLL_MS);
    };
    this.pollTimer = window.setTimeout(tick, card ? 1200 : POLL_MS);
  }

  private stopPolling() {
    if (this.pollTimer !== null) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  private showSuccess(restored = false) {
    this.stopPolling();
    const exp = this.config.pass.expiresAt;
    const returnTab = new URLSearchParams(location.search).has('session_id') || this.wasCardReturn;
    $('coffee-success-title').textContent = restored ? 'WELCOME BACK 🌯' : 'THANK YOU! 🌯';
    $('coffee-success-text').textContent = (exp ? `Online play is unlocked until ${fmtExpiry(exp)}.` : 'Online play is unlocked.') +
      (returnTab && !restored ? ' You can close this tab and go back to your game.' : '');
    $('coffee-continue').textContent = this.afterUnlock ? 'PLAY NOW' : 'DONE';
    this.show('success');
  }

  /** Set by main when this tab was opened by Stripe's return URL. */
  wasCardReturn = false;

  private finish() {
    const then = this.afterUnlock;
    this.close();
    then?.();
  }

  // ---------------- rendering

  private show(v: View) {
    this.view = v;
    for (const name of ['buy', 'waiting', 'success', 'failed', 'slow', 'restore'] as View[]) {
      $(`coffee-${name}`).classList.toggle('hidden', name !== v);
    }
    $('coffee-close').textContent = v === 'success' ? 'CLOSE' : v === 'waiting' ? 'CLOSE (KEEPS CHECKING)' : 'NOT NOW';
    const card = this.method === 'card';
    if (v === 'buy') {
      $('coffee-why').textContent = this.mode === 'gate'
        ? 'Same Device is always free. Online games run on a small server that costs real money every month — a Rolex helps keep the lights on.'
        : 'DULU is free on one device. A Rolex helps keep the online server\'s lights on, and unlocks online play as a thank-you.';
      $('coffee-phone-row').classList.toggle('hidden', card);
      $('coffee-pin-note').classList.toggle('hidden', card);
      $('coffee-card-note').classList.toggle('hidden', !card);
      // In Uganda with cards available: offer to switch between the two
      const canSwitch = regionStore.value === 'UG' && this.config.enabled && !!this.card;
      $('coffee-card-row').classList.toggle('hidden', !canSwitch);
      $('coffee-card-link').textContent = card ? 'Pay with Mobile Money instead' : `Pay by card instead (${fmtMoney(this.card?.priceCents ?? 199, this.card?.currency ?? 'usd')} per Rolex)`;
      const input = $<HTMLInputElement>('coffee-phone');
      if (!input.value) input.value = readLocal('dulu.phone');
      this.error('');
      this.renderBuy();
    }
    if (v === 'slow') {
      $('coffee-slow-text').textContent = this.active === 'card'
        ? 'We haven\'t heard back from Stripe yet. If you paid, online play unlocks automatically as soon as it\'s confirmed, even if you close this.'
        : 'We haven\'t heard back from Mobile Money yet. If you approved it, online play unlocks automatically as soon as it\'s confirmed, even if you close this.';
    }
    if (v === 'restore') {
      const input = $<HTMLInputElement>('coffee-restore-phone');
      input.type = card ? 'email' : 'tel';
      input.inputMode = card ? 'email' : 'tel';
      input.autocomplete = card ? 'email' : 'tel';
      input.placeholder = card ? 'you@example.com' : '0772 123456';
      input.maxLength = card ? 120 : 16;
      input.value = readLocal(card ? 'dulu.email' : 'dulu.phone');
      $('coffee-restore-why').textContent = card
        ? 'On a new phone or browser? Enter the email you used at checkout to bring your online time across.'
        : 'On a new phone or browser? Enter the number you paid with to bring your online time across.';
      $('coffee-restore-error').textContent = '';
    }
  }

  private renderBuy() {
    const c = this.config;
    const card = this.method === 'card';
    const cc = this.card;
    const hours = this.coffees * c.passHours;
    $('coffee-count').textContent = `${this.coffees} Rolex${this.coffees > 1 ? 'es' : ''}`;
    $('coffee-cups').textContent = '🌯'.repeat(Math.min(this.coffees, 5)) + (this.coffees > 5 ? '+' : '');
    $('coffee-duration').textContent = hours % 24 === 0
      ? `${hours / 24} day${hours / 24 > 1 ? 's' : ''} online`
      : `${hours} hours online`;
    const total = card && cc ? fmtMoney(this.coffees * cc.priceCents, cc.currency) : fmtUgx(this.coffees * c.priceUgx);
    const unit = card && cc ? fmtMoney(cc.priceCents, cc.currency) : fmtUgx(c.priceUgx);
    $('coffee-buy-btn').textContent = `BUY ${this.coffees} ROLEX${this.coffees > 1 ? 'ES' : ''} · ${total}`;
    const max = card ? (cc?.maxRolexes ?? 10) : c.maxCoffees;
    $<HTMLButtonElement>('coffee-minus').disabled = this.coffees <= 1;
    $<HTMLButtonElement>('coffee-plus').disabled = this.coffees >= max;
    $('coffee-price-note').textContent = `1 Rolex = ${unit} = ${c.passHours} hours of online play. More Rolexes stack days.`;
    const pass = c.pass;
    $('coffee-current').textContent = pass.active && pass.expiresAt
      ? `You're unlocked until ${fmtExpiry(pass.expiresAt)}. More Rolexes add time on top.`
      : '';
  }

  private error(text: string) {
    $('coffee-error').textContent = text;
  }

  /** Quiet line for the menu (null = no way to pay configured). */
  menuStatus(): { text: string; cta: string } | null {
    const c = this.config;
    if (!this.canSupport) return null;
    const gated = regionStore.value === 'UG' ? c.enabled : !!this.card;
    if (gated && c.pass.active && c.pass.expiresAt) {
      return { text: `🌯 Online unlocked until ${fmtExpiry(c.pass.expiresAt)}`, cta: 'add a Rolex' };
    }
    if (gated) return { text: 'Same Device is always free. Online play runs on Rolex 🌯', cta: 'buy me a Rolex' };
    return { text: 'DULU is free to play. Enjoying it?', cta: 'buy me a Rolex 🌯' };
  }
}
