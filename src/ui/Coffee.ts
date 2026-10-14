// "Buy me a Rolex" sheet (a Rolex is Uganda's chapati-and-egg street food).
// Players in Uganda pay with Mobile Money: 1 Rolex (default 2,000 UGX) = 24h
// of online play; more Rolexes stack. Players elsewhere get a Buy Me a Coffee
// link instead and play online free. (Code still says "coffee" internally.)
// The player only ever enters a phone number — the Mobile Money PIN prompt
// comes from their network, never from this page.

export interface CoffeeConfig {
  enabled: boolean;
  priceUgx: number;
  passHours: number;
  maxCoffees: number;
  pass: { active: boolean; expiresAt: number | null };
}

type View = 'buy' | 'waiting' | 'success' | 'failed' | 'slow' | 'restore';

import { regionStore, BMC_URL } from '../net/region';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const POLL_MS = 3000;
const POLL_MAX_MS = 90_000;

function fmtUgx(n: number) {
  return `${n.toLocaleString('en-UG')} UGX`;
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

function readPhone(): string {
  try { return localStorage.getItem('dulu.phone') || ''; } catch { return ''; }
}
function savePhone(v: string) {
  try { localStorage.setItem('dulu.phone', v); } catch { /* ignore */ }
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
  /** Fired whenever the pass changes (menu status line listens). */
  onChange: () => void = () => {};

  private el = $('coffee');
  private coffees = 1;
  private view: View = 'buy';
  private reference: string | null = null;
  private pollTimer: number | null = null;
  private pollStarted = 0;
  private afterUnlock: (() => void) | null = null;
  /** gate = needed to play online; tip = a voluntary "thank you" from the menu/game over */
  private mode: 'gate' | 'tip' = 'tip';

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
    $('coffee-card-link').addEventListener('click', () => openBmc());
    for (const id of ['coffee-phone', 'coffee-restore-phone']) {
      $(id).addEventListener('pointerdown', (e) => e.stopPropagation());
    }
  }

  /** Online play allowed right now? */
  get unlocked() {
    return !this.config.enabled || regionStore.value !== 'UG' || this.config.pass.active;
  }

  /** Can this player pay with Mobile Money here? */
  get mobileMoney() {
    return this.config.enabled && regionStore.value === 'UG';
  }

  /**
   * Voluntary support (never blocks play): Mobile Money sheet in Uganda,
   * Buy Me a Coffee page everywhere else.
   */
  support() {
    if (this.mobileMoney) this.open(undefined, 'tip');
    else openBmc();
  }

  setConfig(c: CoffeeConfig) {
    this.config = c;
    this.onChange();
  }

  /** Server says a coffee was confirmed (may arrive while the sheet is open). */
  setPass(pass: CoffeeConfig['pass']) {
    this.config.pass = pass;
    this.onChange();
    if (pass.active && !this.el.classList.contains('hidden') && (this.view === 'waiting' || this.view === 'slow')) {
      this.showSuccess();
    }
  }

  /**
   * Open the sheet. `then` runs after a successful purchase (e.g. continue to
   * matchmaking), so the player doesn't have to tap Play Online again.
   */
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

  // ---------------- actions

  private setCount(n: number) {
    this.coffees = Math.max(1, Math.min(this.config.maxCoffees, n));
    this.renderBuy();
  }

  private async buy() {
    const phoneInput = $<HTMLInputElement>('coffee-phone');
    const phone = phoneInput.value.trim();
    if (phone.replace(/\D/g, '').length < 9) {
      this.error('Enter your MTN or Airtel number, e.g. 0772 123456.');
      phoneInput.focus();
      return;
    }
    savePhone(phone);
    const btn = $<HTMLButtonElement>('coffee-buy-btn');
    btn.disabled = true;
    this.error('');
    try {
      const out = await api<{ reference: string }>('/relworx/collect', {
        method: 'POST',
        body: JSON.stringify({ phone, coffees: this.coffees, guestId: this.guestId() }),
      });
      this.reference = out.reference;
      this.show('waiting');
      this.startPolling();
    } catch (e) {
      this.error((e as Error).message);
    } finally {
      btn.disabled = false;
    }
  }

  private async restore() {
    const phone = $<HTMLInputElement>('coffee-restore-phone').value.trim();
    const err = $('coffee-restore-error');
    err.textContent = '';
    try {
      const out = await api<{ pass: CoffeeConfig['pass'] }>('/api/coffee/restore', {
        method: 'POST',
        body: JSON.stringify({ phone, guestId: this.guestId() }),
      });
      savePhone(phone);
      this.config.pass = out.pass;
      this.onChange();
      this.showSuccess(true);
    } catch (e) {
      err.textContent = (e as Error).message;
    }
  }

  private startPolling() {
    this.stopPolling();
    this.pollStarted = Date.now();
    const tick = async () => {
      if (!this.reference) return;
      try {
        const st = await api<{ status: string; message?: string; pass: CoffeeConfig['pass'] }>(
          `/relworx/status?reference=${encodeURIComponent(this.reference)}`,
        );
        if (st.status === 'success') {
          this.config.pass = st.pass;
          this.onChange();
          this.showSuccess();
          return;
        }
        if (st.status === 'failed') {
          this.stopPolling();
          $('coffee-failed-text').textContent = st.message || 'The payment was not completed.';
          this.show('failed');
          return;
        }
      } catch { /* network blip — keep trying */ }
      if (Date.now() - this.pollStarted > POLL_MAX_MS) {
        this.stopPolling();
        this.show('slow');
        return;
      }
      this.pollTimer = window.setTimeout(tick, POLL_MS);
    };
    this.pollTimer = window.setTimeout(tick, POLL_MS);
  }

  private stopPolling() {
    if (this.pollTimer !== null) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  private showSuccess(restored = false) {
    this.stopPolling();
    const exp = this.config.pass.expiresAt;
    $('coffee-success-title').textContent = restored ? 'WELCOME BACK 🌯' : 'THANK YOU! 🌯';
    $('coffee-success-text').textContent = exp
      ? `Online play is unlocked until ${fmtExpiry(exp)}.`
      : 'Online play is unlocked.';
    $('coffee-continue').textContent = this.afterUnlock ? 'PLAY NOW' : 'DONE';
    this.show('success');
  }

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
    if (v === 'buy') {
      $('coffee-why').textContent = this.mode === 'gate'
        ? 'Same Device is always free. Online games run on a small server that costs real money every month — a Rolex helps keep the lights on.'
        : 'DULU is free on one device. A Rolex helps keep the online server\'s lights on, and unlocks online play as a thank-you.';
      $('coffee-card-row').classList.toggle('hidden', this.mode === 'gate');
      const input = $<HTMLInputElement>('coffee-phone');
      if (!input.value) input.value = readPhone();
      this.error('');
      this.renderBuy();
    }
    if (v === 'restore') {
      const input = $<HTMLInputElement>('coffee-restore-phone');
      if (!input.value) input.value = readPhone();
      $('coffee-restore-error').textContent = '';
    }
  }

  private renderBuy() {
    const c = this.config;
    const total = this.coffees * c.priceUgx;
    const hours = this.coffees * c.passHours;
    $('coffee-count').textContent = `${this.coffees} Rolex${this.coffees > 1 ? 'es' : ''}`;
    $('coffee-cups').textContent = '🌯'.repeat(Math.min(this.coffees, 5)) + (this.coffees > 5 ? '+' : '');
    $('coffee-duration').textContent = hours % 24 === 0
      ? `${hours / 24} day${hours / 24 > 1 ? 's' : ''} online`
      : `${hours} hours online`;
    $('coffee-buy-btn').textContent = `BUY ${this.coffees} ROLEX${this.coffees > 1 ? 'ES' : ''} · ${fmtUgx(total)}`;
    $<HTMLButtonElement>('coffee-minus').disabled = this.coffees <= 1;
    $<HTMLButtonElement>('coffee-plus').disabled = this.coffees >= c.maxCoffees;
    $('coffee-price-note').textContent = `1 Rolex = ${fmtUgx(c.priceUgx)} = ${c.passHours} hours of online play. More Rolexes stack days.`;
    const pass = c.pass;
    $('coffee-current').textContent = pass.active && pass.expiresAt
      ? `You're unlocked until ${fmtExpiry(pass.expiresAt)}. More Rolexes add time on top.`
      : '';
  }

  private error(text: string) {
    $('coffee-error').textContent = text;
  }

  /** Quiet line for the menu (and what tapping it does). */
  menuStatus(): { text: string; cta: string; kind: 'mm' | 'bmc' } {
    const c = this.config;
    if (this.mobileMoney) {
      if (c.pass.active && c.pass.expiresAt) {
        return { text: `🌯 Online unlocked until ${fmtExpiry(c.pass.expiresAt)}`, cta: 'add a Rolex', kind: 'mm' };
      }
      return { text: 'Same Device is always free. Online play runs on Rolex 🌯', cta: 'buy me a Rolex', kind: 'mm' };
    }
    return { text: 'DULU is free to play. Enjoying it?', cta: 'Buy me a Rolex', kind: 'bmc' };
  }
}

/** Buy Me a Coffee page for players outside Uganda (card payments). */
export function openBmc() {
  window.open(BMC_URL, '_blank', 'noopener');
}
