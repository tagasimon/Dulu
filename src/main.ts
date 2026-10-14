import './style.css';
import { Game, type MatchInfo, type ServerGameOver } from './game/Game';
import { UI, type Player } from './ui/UI';
import { Net } from './net/Net';
import { identity } from './net/identity';
import { CoffeeSheet, type CoffeeConfig } from './ui/Coffee';
import { regionStore } from './net/region';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const ui = new UI();
const game = new Game(canvas, ui);
const net = new Net(Net.defaultUrl(), () => ({ guestId: identity.guestId, name: identity.displayName, region: regionStore.value }));

// What the player is currently doing, so reconnects can pick up where they were.
type Phase =
  | { kind: 'menu' }
  | { kind: 'local' }
  | { kind: 'searching' }
  | { kind: 'friend' }
  | { kind: 'hosting'; code: string }
  | { kind: 'joining'; code: string }
  | { kind: 'online'; you: Player; names: [string, string]; over: boolean; rematchAsked: boolean; opponentGone: boolean };

let phase: Phase = { kind: 'menu' };
const coffee = new CoffeeSheet(() => identity.guestId);
/** What to resume if the server says a coffee is needed (e.g. it just expired). */
let pendingOnlineAction: (() => void) | null = null;
let slowSearchTimer: number | null = null;
let awayTimer: number | null = null;

// ---------- menu ----------

ui.setNameValue(identity.name, identity.displayName);
ui.onNameChange = (name) => {
  identity.setName(name);
  ui.setNameValue(identity.name, identity.displayName);
  if (net.ready) net.send({ type: 'setName', name: identity.displayName });
};

ui.onPlay = () => {
  phase = { kind: 'local' };
  armBack();
  ui.showHUD(false);
  game.startNewGame();
};

// ---------- coffee (online play) ----------

/** Run an online action now, or after the player buys a coffee. Same Device never asks. */
function withCoffee(action: () => void) {
  pendingOnlineAction = action;
  armBack();
  if (coffee.unlocked) action();
  else coffee.open(action);
}

// "Buy me a Rolex" — a quiet line on the menu, the game-over card and in game.
// Uganda: Mobile Money. Elsewhere: card via Stripe Checkout.
const coffeeStatusEl = document.getElementById('coffee-status')!;
const coffeeStatusText = document.getElementById('coffee-status-text')!;
const coffeeStatusCta = document.getElementById('coffee-status-cta')!;
const coffeeStatusUg = document.getElementById('coffee-status-ug')!;
const goSupportBtn = document.getElementById('go-support-btn')!;
const hudRolexBtn = document.getElementById('hud-rolex')!;

function renderSupport() {
  const st = coffee.menuStatus();
  const can = !!st;
  coffeeStatusEl.classList.toggle('hidden', !can);
  document.querySelector('.go-support')?.classList.toggle('hidden', !can);
  hudRolexBtn.classList.toggle('hidden', !can);
  if (st) {
    coffeeStatusText.textContent = st.text;
    coffeeStatusCta.textContent = st.cta;
  }
  // Outside Uganda, offer a way into Mobile Money (only when it's set up).
  coffeeStatusUg.classList.toggle('hidden', !(regionStore.value !== 'UG' && coffee.config.enabled));
}
coffee.onChange = renderSupport;
renderSupport();

function support() {
  if (!coffee.canSupport) return;
  if (phase.kind === 'menu') armBack();
  coffee.support();
}
coffeeStatusCta.addEventListener('click', support);
goSupportBtn.addEventListener('click', support);
// In-game: never pauses anything; Uganda opens the tip sheet over the game,
// elsewhere it opens Buy Me a Coffee in a new tab.
hudRolexBtn.addEventListener('click', (e) => { e.stopPropagation(); support(); });
coffeeStatusUg.addEventListener('click', () => {
  regionStore.setUganda();
  net.send({ type: 'setRegion', region: 'UG' });
  renderSupport();
  support();
});
document.getElementById('coffee-close')!.addEventListener('click', () => {
  if (phase.kind === 'menu') disarmBack();
});

ui.onPlayOnline = () => withCoffee(startSearching);
ui.onPlayFriend = () => {
  phase = { kind: 'friend' };
  armBack();
  ui.showLobby({ kind: 'friend' });
  net.connect();
};

ui.onSoundToggle = (enabled) => game.setSoundEnabled(enabled);

// ---------- lobby ----------

function startSearching() {
  phase = { kind: 'searching' };
  ui.showLobby(net.ready ? { kind: 'searching' } : { kind: 'connecting' });
  net.send({ type: 'queue' });
  clearSlowTimer();
  slowSearchTimer = window.setTimeout(() => {
    if (phase.kind === 'searching') ui.showLobby({ kind: 'searching', slow: true });
  }, 20_000);
}

function clearSlowTimer() {
  if (slowSearchTimer !== null) { clearTimeout(slowSearchTimer); slowSearchTimer = null; }
}

function createRoom() {
  phase = { kind: 'friend' };
  ui.showLobby({ kind: 'connecting' });
  net.send({ type: 'createRoom' });
}

// Only the room creator needs a coffee — the friend who joins plays free.
ui.onCreateRoom = () => withCoffee(createRoom);

ui.onJoinRoom = (code) => joinRoom(code);

function joinRoom(code: string) {
  phase = { kind: 'joining', code };
  armBack();
  ui.showLobby({ kind: 'joining', code });
  net.send({ type: 'joinRoom', code });
}

function shareUrl(code: string) {
  return `${location.origin}/r/${code}`;
}

function shareText(code: string) {
  return `Play DULU with me — the seed-blasting game! Tap to join my room (${code}): ${shareUrl(code)}`;
}

ui.onShare = async () => {
  if (phase.kind !== 'hosting') return;
  const url = shareUrl(phase.code);
  const text = shareText(phase.code);
  try {
    if (navigator.share) {
      await navigator.share({ title: 'DULU', text, url });
      return;
    }
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return;
  }
  try {
    await navigator.clipboard.writeText(url);
    ui.setShareFeedback('Link copied — paste it to your friend.');
  } catch {
    ui.setShareFeedback(url);
  }
};

ui.onWhatsApp = () => {
  if (phase.kind !== 'hosting') return;
  window.open(`https://wa.me/?text=${encodeURIComponent(shareText(phase.code))}`, '_blank', 'noopener');
};

ui.onLobbyCancel = () => {
  clearSlowTimer();
  net.send({ type: 'cancel' });
  goToMenu();
};

function goToMenu() {
  disarmBack();
  clearSlowTimer();
  phase = { kind: 'menu' };
  game.stop();
  clearRoomFromUrl();
  ui.showMenu();
}

// ---------- in game ----------

ui.onLeave = () => {
  if (phase.kind === 'online') {
    net.clearOutbox();
    net.send({ type: 'leave' });
  }
  goToMenu();
};

ui.onRestart = () => {
  if (phase.kind === 'online') {
    if (phase.opponentGone) return;
    phase.rematchAsked = true;
    net.send({ type: 'rematch' });
    ui.updateGameOver('Waiting for them to accept…', 'REMATCH SENT', true);
    return;
  }
  ui.showHUD(false);
  game.startNewGame();
};

ui.onNewOpponent = () => {
  net.send({ type: 'leave' });
  withCoffee(startSearching);
};

ui.onMenu = () => {
  if (phase.kind === 'online') net.send({ type: 'leave' });
  goToMenu();
};

game.onOnlineGameOver = (m: ServerGameOver) => {
  if (phase.kind !== 'online') return;
  phase.over = true;
  phase.rematchAsked = false;
  const me = phase.you;
  const opp: Player = me === 1 ? 2 : 1;
  const oppName = phase.names[opp - 1];
  const won = m.winner === me;

  let title: string;
  switch (m.reason) {
    case 'bust':
      title = won ? `${oppName} BLASTED INTO A ROCK!` : 'YOU BLASTED INTO A ROCK!';
      break;
    case 'left':
    case 'disconnect':
      title = won ? `${oppName} LEFT — YOU WIN` : 'YOU LEFT THE GAME';
      phase.opponentGone = won;
      break;
    case 'afk':
      title = won ? `${oppName} STOPPED PLAYING` : 'YOU RAN OUT OF TIME';
      break;
    default:
      title = won ? 'YOU WIN!' : `${oppName} WINS!`;
  }
  ui.showGameOverView({
    title: title.toUpperCase(),
    subtitle: `YOU ${m.scores[me - 1]} — ${m.scores[opp - 1]} ${oppName.toUpperCase()}`,
    note: phase.opponentGone ? 'Your opponent has gone.' : '',
    primaryLabel: 'REMATCH',
    primaryDisabled: phase.opponentGone,
    showNewOpponent: true,
  });
};

// ---------- network events ----------

net.on('welcome', (m) => {
  ui.setLobbyStats({ online: m.online, playing: m.playing ?? 0, waiting: m.waiting ?? 0 });
  if (m.coffee) coffee.setConfig(m.coffee as CoffeeConfig);
  if (phase.kind === 'online' && !phase.over && !m.inGame) {
    // Server restarted or our match expired while we were away.
    game.stop();
    phase = { kind: 'menu' };
    ui.showLobby({ kind: 'error', title: 'MATCH LOST', text: 'The connection dropped for too long and the match ended. Sorry about that!' });
    return;
  }
  // Re-enter whatever we were doing when the connection dropped.
  if (phase.kind === 'searching') {
    net.send({ type: 'queue' });
    ui.showLobby({ kind: 'searching' });
  } else if (phase.kind === 'hosting') {
    // the server resends roomCreated if it still has the room
  } else if (phase.kind === 'joining') {
    net.send({ type: 'joinRoom', code: phase.code });
  }
  if (phase.kind === 'online') ui.hideNetBanner();
});

net.on('stats', (m) => ui.setLobbyStats({ online: m.online, playing: m.playing ?? 0, waiting: m.waiting ?? 0 }));

net.on('queued', () => {
  if (phase.kind === 'searching') ui.showLobby({ kind: 'searching' });
});

net.on('roomCreated', (m) => {
  if (phase.kind !== 'friend' && phase.kind !== 'hosting' && phase.kind !== 'joining') return;
  phase = { kind: 'hosting', code: m.code };
  ui.showLobby({ kind: 'room', code: m.code, shareUrl: shareUrl(m.code) });
});

net.on('pass', (m) => coffee.setPass(m.pass));

net.on('error', (m) => {
  if (m.code === 'NEED_COFFEE') {
    // Server is the judge (e.g. the pass expired a moment ago).
    clearSlowTimer();
    const resume = pendingOnlineAction ?? startSearching;
    coffee.setPass({ active: false, expiresAt: null });
    if (!coffee.config.enabled) coffee.setConfig({ ...coffee.config, enabled: true });
    goToMenu();
    coffee.open(resume);
    return;
  }
  if (m.code === 'ROOM_NOT_FOUND' || m.code === 'HOST_OFFLINE' || m.code === 'ROOM_EXPIRED') {
    clearRoomFromUrl();
    phase = { kind: 'friend' };
    ui.showLobby({ kind: 'friend', error: m.message });
  }
});

net.on('match', (m: MatchInfo & { opponentConnected: boolean }) => {
  clearSlowTimer();
  armBack();
  clearRoomFromUrl();
  phase = { kind: 'online', you: m.you, names: m.names, over: false, rematchAsked: false, opponentGone: false };
  ui.showHUD(true);
  game.startOnline(m, {
    aim: (x, z, t) => net.send({ type: 'aim', x, z, t }),
    launch: (vx, vz) => net.send({ type: 'launch', vx, vz }),
    shotResult: (seeds, hits, bust) => net.send({ type: 'shotResult', seeds, hits, bust }),
    topie: () => net.send({ type: 'topie' }),
  });
  if (!m.opponentConnected) ui.showNetBanner(`${opponentName()} lost connection — waiting…`);
});

net.on('aim', (m) => game.remoteAim(m.x, m.z, m.t));
net.on('topie', (m) => game.remoteTopie(m.by, m.topies));
net.on('launch', (m) => game.remoteLaunch(m.vx, m.vz));
net.on('state', (m) => game.applyServerState(m));
net.on('gameOver', (m) => {
  if (phase.kind !== 'online') return;
  clearAwayTimer();
  ui.hideNetBanner();
  game.applyGameOver(m);
});

net.on('opponentAway', (m) => {
  if (phase.kind !== 'online' || phase.over) return;
  let left = Math.round(m.graceMs / 1000);
  const tick = () => {
    if (phase.kind !== 'online' || phase.over) { clearAwayTimer(); return; }
    ui.showNetBanner(`${opponentName()} lost connection — waiting ${left}s`);
    left = Math.max(0, left - 1);
  };
  clearAwayTimer();
  tick();
  awayTimer = window.setInterval(tick, 1000);
});

net.on('opponentBack', () => {
  clearAwayTimer();
  ui.hideNetBanner();
});

net.on('rematchRequested', () => {
  if (phase.kind !== 'online' || !phase.over) return;
  ui.updateGameOver(`${opponentName()} wants a rematch!`, 'ACCEPT REMATCH', false);
});

net.on('opponentLeft', () => {
  if (phase.kind !== 'online') return;
  phase.opponentGone = true;
  if (phase.over) {
    ui.updateGameOver(`${opponentName()} left. Find a new opponent?`);
    ui.setRematchAvailable(false);
  }
});

net.onStatus = (s) => {
  if (s === 'closed') {
    ui.setLobbyStats(null);
    if (phase.kind === 'online' && !phase.over) ui.showNetBanner('Connection lost — reconnecting…');
    if (phase.kind === 'searching') ui.showLobby({ kind: 'connecting' });
  }
};

function opponentName() {
  if (phase.kind !== 'online') return 'Opponent';
  return phase.names[phase.you === 1 ? 1 : 0];
}

function clearAwayTimer() {
  if (awayTimer !== null) { clearInterval(awayTimer); awayTimer = null; }
}

// ---------- room links: /r/K7QX or ?room=K7QX ----------

function roomFromUrl(): string | null {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{4,8})\/?$/);
  if (m) return m[1].toUpperCase();
  const q = new URLSearchParams(location.search).get('room');
  return q && /^[A-Za-z0-9]{4,8}$/.test(q) ? q.toUpperCase() : null;
}

function clearRoomFromUrl() {
  if (location.pathname !== '/' || location.search) {
    try { history.replaceState(null, '', '/'); } catch { /* ignore */ }
  }
}

// ---------- Topie button ----------
const topieBtn = document.getElementById('btn-topie') as HTMLButtonElement;
const topieLeft = document.getElementById('topie-left')!;
topieBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
topieBtn.addEventListener('click', (e) => { e.stopPropagation(); game.requestTopie(); });
game.onTopieChange = ({ visible, enabled, left }) => {
  topieBtn.classList.toggle('hidden', !visible);
  topieBtn.disabled = !enabled;
  topieLeft.textContent = `×${left}`;
};

// ---------- phone / browser back button → Home ----------
// While away from the menu we keep one extra history entry, so the back
// button lands here instead of leaving the site.
let backTrap = false;
let ignorePops = 0;

function armBack() {
  if (backTrap) return;
  try { history.pushState({ dulu: 'away' }, ''); backTrap = true; } catch { /* ignore */ }
}

function disarmBack() {
  if (!backTrap) return;
  backTrap = false;
  ignorePops++;
  try { history.back(); } catch { ignorePops--; }
}

window.addEventListener('popstate', () => {
  if (ignorePops > 0) { ignorePops--; return; }
  backTrap = false;
  const sheetOpen = !document.getElementById('coffee')!.classList.contains('hidden');
  const tutOpen = !document.getElementById('tutorial')!.classList.contains('hidden');
  if (sheetOpen || tutOpen) {
    if (sheetOpen) coffee.close();
    if (tutOpen) document.getElementById('tutorial')!.classList.add('hidden');
    if (phase.kind !== 'menu') armBack();
    return;
  }
  switch (phase.kind) {
    case 'online':
      if (!phase.over) {
        armBack();         // stay; first press asks, second press leaves
        ui.requestLeave();
        return;
      }
      ui.onMenu();
      return;
    case 'local':
      ui.onLeave();
      return;
    case 'menu':
      return;
    default:
      ui.onLobbyCancel();
  }
});

// ---------- boot ----------

if (new URLSearchParams(location.search).has('debug')) (window as any).__dulu = game;

// Back from Stripe Checkout (this tab was opened for paying): confirm + thank.
{
  const params = new URLSearchParams(location.search);
  const sid = params.get('session_id');
  if (params.get('rolex') === 'paid' && sid && /^cs_[A-Za-z0-9_]+$/.test(sid)) {
    coffee.wasCardReturn = true;
    coffee.handleCardReturn(sid);
  }
  if (params.has('rolex')) {
    try { history.replaceState(null, '', '/'); } catch { /* ignore */ }
  }
}

// Menu status line before the socket connects.
fetch(`/api/coffee?guestId=${encodeURIComponent(identity.guestId)}`)
  .then((r) => (r.ok ? r.json() : null))
  .then((c) => { if (c) coffee.setConfig(c); })
  .catch(() => { /* server offline: online buttons will say so */ });

game.init().then(() => {
  ui.showMenu();
  net.connect(); // shows "N online" on the menu
  const code = roomFromUrl();
  if (code) joinRoom(code);
});
