// Thin WebSocket client with auto-reconnect.
// Identity is sent in a `hello` on every (re)connect so the server can put a
// dropped player straight back into their match.

type Handler = (msg: any) => void;
export type NetStatus = 'idle' | 'connecting' | 'open' | 'closed';

// Messages that are worthless if delayed (sent only when the socket is open).
const TRANSIENT = new Set(['aim', 'ping']);

export class Net {
  status: NetStatus = 'idle';
  onStatus: (s: NetStatus) => void = () => {};

  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private outbox: object[] = [];
  private retry = 0;
  private retryTimer: number | null = null;
  private helloAcked = false;

  constructor(private url: string, private hello: () => { guestId: string; name: string }) {}

  static defaultUrl(): string {
    const override = (import.meta as any).env?.VITE_WS_URL as string | undefined;
    if (override) return override;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  get ready() { return this.status === 'open' && this.helloAcked; }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.setStatus('connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    this.helloAcked = false;

    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ type: 'hello', ...this.hello() }));
      this.setStatus('open');
    };
    ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'welcome') {
        this.helloAcked = true;
        const pending = this.outbox;
        this.outbox = [];
        for (const m of pending) ws.send(JSON.stringify(m));
      }
      this.handlers.get(msg.type)?.forEach((h) => h(msg));
      this.handlers.get('*')?.forEach((h) => h(msg));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.helloAcked = false;
      this.setStatus('closed');
      // 4000 = this browser opened the game in another tab; don't fight it.
      if (ev.code === 4000) return;
      this.scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  send(msg: { type: string; [k: string]: unknown }) {
    if (this.ready && this.ws) {
      this.ws.send(JSON.stringify(msg));
    } else if (!TRANSIENT.has(msg.type)) {
      this.outbox.push(msg);
      this.connect();
    }
  }

  /** Forget anything queued while offline (e.g. after leaving to the menu). */
  clearOutbox() { this.outbox = []; }

  on(type: string, fn: Handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(fn);
  }

  private scheduleReconnect() {
    if (this.retryTimer !== null) return;
    const delay = Math.min(5000, 500 * 2 ** this.retry++) + Math.random() * 300;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private setStatus(s: NetStatus) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }
}
