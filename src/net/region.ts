// Where is this player? Decides how they support the game:
//   UG   → Mobile Money (Relworx) "Buy me a Rolex"; online play needs one
//   INTL → card via Stripe Checkout ($1.99); online play needs one once Stripe is set up
// Detected from the browser's timezone. A player can switch themselves into
// UG mode from the sheet ("In Uganda? Pay with Mobile Money"); there's no
// switch the other way on the paywall, so it can't be used to skip paying.

export type Region = 'UG' | 'INTL';
const KEY = 'dulu.region';

function detect(): Region {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    return tz === 'Africa/Kampala' ? 'UG' : 'INTL';
  } catch {
    return 'UG';
  }
}

let region: Region = (() => {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'UG') return 'UG';
  } catch { /* ignore */ }
  return detect();
})();

export const regionStore = {
  get value(): Region { return region; },
  /** Only ever used to opt INTO Uganda/Mobile Money. */
  setUganda() {
    region = 'UG';
    try { localStorage.setItem(KEY, 'UG'); } catch { /* ignore */ }
  },
};
