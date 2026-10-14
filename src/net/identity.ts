// Anonymous guest identity, remembered in this browser only.
// localStorage can be unavailable (private mode, blocked storage) — fall back
// to an in-memory identity for the session.

const ID_KEY = 'dulu.guestId';
const NAME_KEY = 'dulu.name';

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

let guestId = read(ID_KEY);
if (!guestId || !/^[A-Za-z0-9_-]{8,64}$/.test(guestId)) {
  guestId = randomId();
  write(ID_KEY, guestId);
}

let name = read(NAME_KEY) || '';

export const identity = {
  get guestId() { return guestId!; },
  get name() { return name; },
  /** Name to send; falls back to a friendly random one. */
  get displayName() {
    if (name) return name;
    const n = (parseInt(guestId!.slice(0, 4), 16) % 9000) + 1000;
    return `Player ${n}`;
  },
  setName(v: string) {
    name = v.replace(/\s+/g, ' ').trim().slice(0, 16);
    write(NAME_KEY, name);
  },
};
