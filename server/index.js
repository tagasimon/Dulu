// DULU multiplayer server
// -----------------------------------------------------------------------------
// One small Node process that:
//   1. serves the built game (dist/) — replaces nginx
//   2. runs a WebSocket at /ws for anonymous online play:
//        • random matchmaking ("Play Online")
//        • private rooms with a 4-letter code / share link ("Play a Friend")
//        • turn relay, scoring, turn timers, reconnects, rematches
//
// No accounts. Each browser makes a random guestId (kept in localStorage) and a
// nickname. The guestId lets a player who refreshes or drops signal rejoin
// their match.
//
// Trust model: the player who is shooting runs the physics for that shot and
// reports where the seeds stopped + how many hits. The server checks the
// report is sane (right player, right phase, positions inside the arena,
// launch speed within limits), keeps the score and decides whose turn it is.
// -----------------------------------------------------------------------------

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  generateArena, randomSeed, ARENA_RADIUS, WIN_SCORE, MAX_LAUNCH_SPEED, TOPIES_PER_GAME,
} from '../shared/arena.js';
import { openDb } from './db.js';
import { createPayments } from './payments.js';
import { createStripe } from './stripe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
const PORT = Number(process.env.PORT) || 8787;
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '..', 'dist'));
const AIM_TIME_MS = Number(process.env.AIM_TIME_MS) || 40_000;      // time to take a shot
const SHOT_TIME_MS = 20_000;                                          // time for shooter to report result
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 45_000;
const PRIVATE_ROOM_TTL_MS = 30 * 60_000;
const FINISHED_ROOM_TTL_MS = 3 * 60_000;
const MAX_AFK_TURNS = 3;           // missed turns in a row → forfeit
const MAX_HITS_PER_SHOT = 5;
const HEARTBEAT_MS = 25_000;
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 2000;   // whole server
const MAX_CONNECTIONS_PER_IP = Number(process.env.MAX_CONNECTIONS_PER_IP) || 50; // generous: mobile carriers share IPs (CGNAT)
// Optional: comma-separated list of origins allowed to open the WebSocket,
// e.g. "https://dulu.example.com". Empty = allow any (fine for a public game).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);

// ---------- state ----------
/** @type {Map<string, Session>} guestId → session */
const sessions = new Map();
/** @type {Session[]} */
let queue = [];
/** @type {Map<string, PrivateRoom>} code → waiting private room */
const privateRooms = new Map();
/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * @typedef {{ guestId: string, name: string, ws: import('ws').WebSocket | null,
 *   room: Room | null, hosting: PrivateRoom | null, goneTimer: any }} Session
 * @typedef {{ code: string, host: Session, created: number }} PrivateRoom
 * @typedef {{ id: string, players: [Session, Session], layout: any,
 *   scores: [number, number], turn: 1|2, seeds: [number, number][],
 *   phase: 'aim'|'shot'|'over', deadline: number, timer: any,
 *   afk: [number, number], rematch: Set<number>, lastLoser: 1|2,
 *   graceTimers: [any, any], cleanupTimer: any, private: boolean }} Room
 */

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- payments ("buy me a Rolex") ----------
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const db = openDb(path.join(DATA_DIR, 'dulu.db'));
const payments = createPayments({
  db,
  log,
  // A coffee was confirmed: tell that player's open game right away.
  onPassGranted: (guestId, expiresAt) => {
    send(sessions.get(guestId), { type: 'pass', pass: { active: true, expiresAt } });
  },
});

// Players outside Uganda pay by card through Stripe Checkout.
const stripe = createStripe({
  db,
  log,
  onPassGranted: (guestId, expiresAt) => {
    send(sessions.get(guestId), { type: 'pass', pass: { active: true, expiresAt } });
  },
});

// Confirm payments ourselves; the Relworx webhook slot belongs to Jukila.
const stopReconciler = payments.startReconciler();

/**
 * Online play needs an active Rolex, for players in Uganda only: Mobile Money
 * is how they pay. Players elsewhere play online free and see a Buy Me a
 * Coffee tip button instead. Region comes from the browser's timezone, so it
 * isn't tamper-proof; it's a soft gate, not DRM.
 */
function requireCoffee(session) {
  // The gate is on only where a way to pay is configured for that region.
  const gateOn = session.region === 'UG' ? payments.enabled : stripe.enabled;
  if (!gateOn) return true;
  if (payments.passFor(session.guestId).active) return true;
  send(session, { type: 'error', code: 'NEED_COFFEE', message: 'Online play needs a Rolex.' });
  return false;
}

/** What the client needs to show the Rolex sheet (both payment methods). */
function coffeeConfig(guestId) {
  return { ...payments.config(guestId), pass: payments.passFor(guestId), card: stripe.config() };
}

function cleanRegion(r) {
  return r === 'INTL' ? 'INTL' : 'UG'; // default to UG so the gate fails closed
}

// ---------- helpers ----------
function send(session, msg) {
  const ws = session?.ws;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function cleanName(raw) {
  const s = String(raw ?? '').replace(/[^\p{L}\p{N} _.\-']/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || 'Player';
}

function validGuestId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
function makeCode() {
  for (let tries = 0; tries < 50; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!privateRooms.has(c)) return c;
  }
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function onlineCount() {
  let n = 0;
  for (const s of sessions.values()) if (s.ws) n++;
  return n;
}

function playingCount() {
  let n = 0;
  for (const r of rooms.values()) if (r.phase !== 'over') n += 2;
  return n;
}

function seatOf(room, session) {
  return room.players[0] === session ? 1 : room.players[1] === session ? 2 : 0;
}

function other(p) { return p === 1 ? 2 : 1; }

// ---------- live lobby stats ----------
// Who's around: everyone connected, how many are mid-game, and how many are
// waiting in "Play Online" right now. Pushed to players on the menu/lobby
// whenever it changes (at most every 1.5 s), plus a 15 s heartbeat.
function statsMsg() {
  return {
    type: 'stats',
    online: onlineCount(),
    playing: playingCount(),
    waiting: queue.filter((s) => s.ws).length,
  };
}

function broadcastStats() {
  const msg = statsMsg();
  for (const s of sessions.values()) if (s.ws && !isActive(s.room)) send(s, msg);
}

let statsTimer = null;
function scheduleStats() {
  if (statsTimer) return;
  statsTimer = setTimeout(() => { statsTimer = null; broadcastStats(); }, 1500);
}

function removeFromQueue(session) {
  const before = queue.length;
  queue = queue.filter((s) => s !== session);
  if (queue.length !== before) scheduleStats();
}

function closeHosting(session) {
  if (session.hosting) {
    privateRooms.delete(session.hosting.code);
    session.hosting = null;
  }
}

function isActive(room) {
  return room && room.phase !== 'over';
}

// ---------- matches ----------
function matchPayload(room, seat) {
  return {
    type: 'match',
    roomId: room.id,
    you: seat,
    names: [room.players[0].name, room.players[1].name],
    layout: room.layout,
    scores: room.scores,
    turn: room.turn,
    seeds: room.seeds,
    phase: room.phase,
    deadline: Math.max(0, room.deadline - Date.now()),
    topies: room.topies,
    opponentConnected: !!room.players[seat === 1 ? 1 : 0].ws,
  };
}

function createMatch(a, b, isPrivate) {
  removeFromQueue(a); removeFromQueue(b);
  closeHosting(a); closeHosting(b);
  leaveRoom(a, 'switched'); leaveRoom(b, 'switched');

  /** @type {Room} */
  const room = {
    id: crypto.randomUUID(),
    players: [a, b],
    layout: null,
    scores: [0, 0],
    turn: 1,
    seeds: [],
    phase: 'aim',
    deadline: 0,
    timer: null,
    afk: [0, 0],
    rematch: new Set(),
    lastLoser: 2,
    graceTimers: [null, null],
    cleanupTimer: null,
    private: !!isPrivate,
  };
  rooms.set(room.id, room);
  a.room = room; b.room = room;
  scheduleStats();
  startGame(room, 1);
  log('match', room.id, isPrivate ? 'private' : 'public', a.name, 'vs', b.name);
}

function startGame(room, firstTurn) {
  room.layout = generateArena(randomSeed());
  room.seeds = room.layout.seeds.map((s) => [s.x, s.z]);
  room.scores = [0, 0];
  room.topies = [TOPIES_PER_GAME, TOPIES_PER_GAME];
  room.turn = firstTurn;
  room.afk = [0, 0];
  room.rematch.clear();
  clearTimeout(room.cleanupTimer);
  startAim(room);
  send(room.players[0], matchPayload(room, 1));
  send(room.players[1], matchPayload(room, 2));
}

function startAim(room) {
  clearTimeout(room.timer);
  room.phase = 'aim';
  room.topieUsed = false; // one Topie per turn
  room.deadline = Date.now() + AIM_TIME_MS;
  room.timer = setTimeout(() => onAimTimeout(room), AIM_TIME_MS);
}

function broadcastState(room, extra) {
  const msg = {
    type: 'state',
    scores: room.scores,
    turn: room.turn,
    seeds: room.seeds,
    deadline: Math.max(0, room.deadline - Date.now()),
    topies: room.topies,
    ...extra,
  };
  send(room.players[0], msg);
  send(room.players[1], msg);
}

function onAimTimeout(room) {
  if (room.phase !== 'aim') return;
  const idle = room.turn;
  room.afk[idle - 1]++;
  if (room.afk[idle - 1] >= MAX_AFK_TURNS) {
    endGame(room, other(idle), 'afk');
    return;
  }
  room.turn = other(idle);
  startAim(room);
  broadcastState(room, { hits: 0, reason: 'timeout' });
}

function onShotTimeout(room) {
  if (room.phase !== 'shot') return;
  // Shooter never reported — keep the pre-shot positions, count as a miss.
  applyShot(room, { seeds: room.seeds, hits: 0, bust: null }, 'timeout');
}

function applyShot(room, result, reason) {
  clearTimeout(room.timer);
  const shooter = room.turn;
  room.seeds = result.seeds;
  room.scores[shooter - 1] = Math.min(WIN_SCORE, room.scores[shooter - 1] + result.hits);

  if (result.bust) {
    endGame(room, other(result.bust), 'bust');
    return;
  }
  if (room.scores[shooter - 1] >= WIN_SCORE) {
    endGame(room, shooter, 'score');
    return;
  }
  room.turn = result.hits > 0 ? shooter : other(shooter);
  startAim(room);
  broadcastState(room, { hits: result.hits, reason });
}

function endGame(room, winner, reason) {
  clearTimeout(room.timer);
  room.phase = 'over';
  room.lastLoser = other(winner);
  room.rematch.clear();
  const msg = { type: 'gameOver', winner, reason, scores: room.scores, seeds: room.seeds };
  send(room.players[0], msg);
  send(room.players[1], msg);
  log('gameOver', room.id, 'winner', winner, reason, room.scores.join('-'));
  scheduleStats();
  // keep the room around for a rematch, then clean up
  clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => destroyRoom(room), FINISHED_ROOM_TTL_MS);
}

function destroyRoom(room) {
  clearTimeout(room.timer);
  clearTimeout(room.cleanupTimer);
  room.graceTimers.forEach((t) => clearTimeout(t));
  for (const p of room.players) if (p.room === room) p.room = null;
  rooms.delete(room.id);
}

/** Player leaves their room (menu, new opponent, or forfeit). */
function leaveRoom(session, why) {
  const room = session.room;
  if (!room) return;
  const seat = seatOf(room, session);
  session.room = null;
  const opp = room.players[seat === 1 ? 1 : 0];
  if (isActive(room)) {
    endGame(room, other(seat), 'left');
  }
  if (opp.room === room) send(opp, { type: 'opponentLeft' });
  if (!room.players.some((p) => p.room === room)) destroyRoom(room);
}

// ---------- message handling ----------
function handle(ws, session, msg) {
  switch (msg.type) {
    case 'setName': {
      session.name = cleanName(msg.name);
      return;
    }

    case 'setRegion': {
      session.region = cleanRegion(msg.region);
      return;
    }

    case 'queue': {
      if (isActive(session.room)) return send(session, { type: 'error', code: 'IN_GAME', message: 'Already in a game.' });
      if (!requireCoffee(session)) return;
      closeHosting(session);
      leaveRoom(session, 'queue');
      if (queue.includes(session)) return send(session, { type: 'queued' });
      const opp = queue.find((s) => s !== session && s.ws);
      if (opp) {
        createMatch(opp, session, false);
      } else {
        queue.push(session);
        scheduleStats();
        send(session, { type: 'queued' });
      }
      return;
    }

    case 'createRoom': {
      if (isActive(session.room)) return send(session, { type: 'error', code: 'IN_GAME', message: 'Already in a game.' });
      if (!requireCoffee(session)) return; // the friend who joins plays free
      removeFromQueue(session);
      leaveRoom(session, 'createRoom');
      closeHosting(session);
      const code = makeCode();
      const pr = { code, host: session, created: Date.now() };
      privateRooms.set(code, pr);
      session.hosting = pr;
      send(session, { type: 'roomCreated', code });
      setTimeout(() => {
        if (privateRooms.get(code) === pr) {
          privateRooms.delete(code);
          if (pr.host.hosting === pr) pr.host.hosting = null;
          send(pr.host, { type: 'error', code: 'ROOM_EXPIRED', message: 'Room code expired.' });
        }
      }, PRIVATE_ROOM_TTL_MS);
      return;
    }

    case 'joinRoom': {
      const code = String(msg.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      const pr = privateRooms.get(code);
      if (!pr) return send(session, { type: 'error', code: 'ROOM_NOT_FOUND', message: `No room "${code}". Check the code or ask your friend for a new link.` });
      if (pr.host === session) return send(session, { type: 'roomCreated', code });
      if (isActive(session.room)) return send(session, { type: 'error', code: 'IN_GAME', message: 'Already in a game.' });
      if (!pr.host.ws) return send(session, { type: 'error', code: 'HOST_OFFLINE', message: 'Your friend is offline right now. Try again in a moment.' });
      privateRooms.delete(code);
      pr.host.hosting = null;
      createMatch(pr.host, session, true);
      return;
    }

    case 'cancel': {
      removeFromQueue(session);
      closeHosting(session);
      return;
    }

    case 'leave': {
      removeFromQueue(session);
      closeHosting(session);
      leaveRoom(session, 'leave');
      return;
    }

    case 'aim': {
      const room = session.room;
      if (!room || room.phase !== 'aim' || seatOf(room, session) !== room.turn) return;
      if (!num(msg.x) || !num(msg.z) || !num(msg.t)) return;
      const opp = room.players[room.turn === 1 ? 1 : 0];
      send(opp, { type: 'aim', x: +msg.x.toFixed(3), z: +msg.z.toFixed(3), t: Math.max(0, Math.min(1, +msg.t.toFixed(3))) });
      return;
    }

    case 'topie': {
      // Shooter stands the opponent's seed up before shooting.
      const room = session.room;
      if (!room || room.phase !== 'aim' || seatOf(room, session) !== room.turn) return;
      if (room.topieUsed || !room.topies || room.topies[room.turn - 1] <= 0) return;
      room.topieUsed = true;
      room.topies[room.turn - 1]--;
      const opp = room.players[room.turn === 1 ? 1 : 0];
      send(opp, { type: 'topie', by: room.turn, topies: room.topies });
      return;
    }

    case 'launch': {
      const room = session.room;
      if (!room || room.phase !== 'aim' || seatOf(room, session) !== room.turn) return;
      if (!num(msg.vx) || !num(msg.vz)) return;
      let { vx, vz } = msg;
      const sp = Math.hypot(vx, vz);
      if (sp > MAX_LAUNCH_SPEED) { vx *= MAX_LAUNCH_SPEED / sp; vz *= MAX_LAUNCH_SPEED / sp; }
      clearTimeout(room.timer);
      room.phase = 'shot';
      room.afk[room.turn - 1] = 0;
      room.timer = setTimeout(() => onShotTimeout(room), SHOT_TIME_MS);
      const opp = room.players[room.turn === 1 ? 1 : 0];
      send(opp, { type: 'launch', vx, vz });
      return;
    }

    case 'shotResult': {
      const room = session.room;
      if (!room || room.phase !== 'shot' || seatOf(room, session) !== room.turn) return;
      const seeds = Array.isArray(msg.seeds) ? msg.seeds : null;
      if (!seeds || seeds.length !== 2) return;
      const clean = [];
      for (const p of seeds) {
        if (!Array.isArray(p) || !num(p[0]) || !num(p[1])) return;
        let [x, z] = p;
        const r = Math.hypot(x, z);
        const max = ARENA_RADIUS - 0.1;
        if (r > max) { x *= max / r; z *= max / r; }
        clean.push([+x.toFixed(4), +z.toFixed(4)]);
      }
      const hits = Math.max(0, Math.min(MAX_HITS_PER_SHOT, Math.floor(Number(msg.hits) || 0)));
      const bust = msg.bust === 1 || msg.bust === 2 ? msg.bust : null;
      applyShot(room, { seeds: clean, hits, bust }, 'shot');
      return;
    }

    case 'rematch': {
      const room = session.room;
      if (!room || room.phase !== 'over') return;
      const seat = seatOf(room, session);
      const opp = room.players[seat === 1 ? 1 : 0];
      if (opp.room !== room) return send(session, { type: 'opponentLeft' });
      room.rematch.add(seat);
      if (room.rematch.size === 2) {
        startGame(room, room.lastLoser); // loser shoots first
      } else {
        send(opp, { type: 'rematchRequested' });
      }
      return;
    }

    case 'ping':
      return send(session, { type: 'pong', t: msg.t });
  }
}

// ---------- connection lifecycle ----------
function attach(ws, hello) {
  const guestId = hello.guestId;
  let session = sessions.get(guestId);
  if (session) {
    clearTimeout(session.goneTimer);
    if (session.ws && session.ws !== ws) {
      // same browser opened a second tab / reconnected — newest wins
      try { session.ws.close(4000, 'replaced'); } catch {}
    }
    session.ws = ws;
    session.name = cleanName(hello.name ?? session.name);
    session.region = cleanRegion(hello.region);
  } else {
    session = { guestId, name: cleanName(hello.name), region: cleanRegion(hello.region), ws, room: null, hosting: null, goneTimer: null };
    sessions.set(guestId, session);
  }

  const room = session.room;
  scheduleStats();
  send(session, {
    type: 'welcome',
    online: onlineCount(),
    playing: playingCount(),
    waiting: queue.filter((s) => s.ws).length,
    inGame: !!(room && isActive(room)),
    coffee: coffeeConfig(session.guestId),
  });

  if (room) {
    const seat = seatOf(room, session);
    clearTimeout(room.graceTimers[seat - 1]);
    room.graceTimers[seat - 1] = null;
    if (isActive(room)) {
      send(session, matchPayload(room, seat));
      send(room.players[seat === 1 ? 1 : 0], { type: 'opponentBack' });
    }
  } else if (session.hosting) {
    send(session, { type: 'roomCreated', code: session.hosting.code });
  }
  return session;
}

function detach(ws, session) {
  if (!session || session.ws !== ws) return;
  session.ws = null;
  scheduleStats();
  removeFromQueue(session);

  const room = session.room;
  if (room && isActive(room)) {
    const seat = seatOf(room, session);
    const opp = room.players[seat === 1 ? 1 : 0];
    send(opp, { type: 'opponentAway', graceMs: RECONNECT_GRACE_MS });
    clearTimeout(room.graceTimers[seat - 1]);
    room.graceTimers[seat - 1] = setTimeout(() => {
      room.graceTimers[seat - 1] = null;
      if (!session.ws && session.room === room && isActive(room)) {
        log('forfeit (disconnect)', room.id, session.name);
        endGame(room, other(seat), 'disconnect');
      }
    }, RECONNECT_GRACE_MS);
  }

  // forget idle sessions after a while (keeps memory flat)
  session.goneTimer = setTimeout(() => {
    if (session.ws) return;
    if (session.room && isActive(session.room)) return; // grace timer handles it
    closeHosting(session);
    if (session.room) leaveRoom(session, 'gone');
    sessions.delete(session.guestId);
  }, RECONNECT_GRACE_MS + 5_000);
}

// ---------- static file serving ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt']);
const fileCache = new Map(); // path → { raw, gz }

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

function loadFile(abs) {
  let entry = fileCache.get(abs);
  if (entry) return entry;
  const raw = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase();
  const gz = COMPRESSIBLE.has(ext) && raw.length > 1024 ? zlib.gzipSync(raw, { level: 9 }) : null;
  entry = { raw, gz };
  fileCache.set(abs, entry);
  return entry;
}

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { urlPath = '/'; }
  let abs = path.join(STATIC_DIR, path.normalize(urlPath));
  if (!abs.startsWith(STATIC_DIR)) { res.writeHead(400); return res.end(); }

  let isFile = false;
  try { isFile = fs.statSync(abs).isFile(); } catch {}
  if (!isFile) {
    if (path.extname(urlPath)) { res.writeHead(404, SECURITY_HEADERS); return res.end('Not found'); }
    abs = path.join(STATIC_DIR, 'index.html'); // SPA fallback (e.g. /r/K7QX)
  }

  let entry;
  try { entry = loadFile(abs); } catch {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    return res.end('Game not built yet — run `npm run build`.');
  }
  const ext = path.extname(abs).toLowerCase();
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'Vary': 'Accept-Encoding',
  };
  const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = entry.gz && wantsGzip ? entry.gz : entry.raw;
  if (body === entry.gz) headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------- HTTP + WS server ----------
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, online: onlineCount(), playing: playingCount(), queue: queue.length, payments: payments.enabled, cards: stripe.enabled }));
  }
  if (req.url && req.url.startsWith('/api/coffee') && req.method === 'GET') {
    const u = new URL(req.url, 'http://x');
    const body = JSON.stringify(coffeeConfig(u.searchParams.get('guestId') || ''));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(body);
  }
  if (req.url && (req.url.startsWith('/relworx/') || req.url.startsWith('/api/coffee'))) {
    payments.route(req, res, clientIp(req));
    return;
  }
  if (req.url && req.url.startsWith('/stripe/')) {
    stripe.route(req, res, clientIp(req));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

// Behind Coolify's Traefik the real client address is the LAST entry of
// X-Forwarded-For (earlier entries can be set by the client).
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '');
  const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : (req.socket.remoteAddress || 'unknown');
}

/** ip → open WebSocket count */
const ipCounts = new Map();

function rejectUpgrade(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {}
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/ws')) { socket.destroy(); return; }
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(String(req.headers.origin || '').replace(/\/$/, ''))) {
    return rejectUpgrade(socket, 403, 'Forbidden');
  }
  if (wss.clients.size >= MAX_CONNECTIONS) return rejectUpgrade(socket, 503, 'Server Busy');
  const ip = clientIp(req);
  if ((ipCounts.get(ip) || 0) >= MAX_CONNECTIONS_PER_IP) return rejectUpgrade(socket, 429, 'Too Many Connections');
  wss.handleUpgrade(req, socket, head, (ws) => {
    ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
    ws.once('close', () => {
      const n = (ipCounts.get(ip) || 1) - 1;
      if (n <= 0) ipCounts.delete(ip); else ipCounts.set(ip, n);
    });
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  /** @type {Session | null} */
  let session = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // simple token bucket: ~40 msgs/sec sustained
  let tokens = 40, last = Date.now(), dropped = 0;

  ws.on('message', (data) => {
    const now = Date.now();
    tokens = Math.min(40, tokens + ((now - last) / 1000) * 40);
    last = now;
    if (tokens < 1) { if (++dropped > 200) ws.close(4008, 'rate limit'); return; }
    tokens--;

    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (!session) {
      if (msg.type !== 'hello' || !validGuestId(msg.guestId)) {
        ws.close(4001, 'hello required');
        return;
      }
      session = attach(ws, msg);
      return;
    }
    try { handle(ws, session, msg); } catch (err) { log('handler error', err); }
  });

  ws.on('close', () => detach(ws, session));
  ws.on('error', () => {});
});

// heartbeat: drop dead sockets so opponents find out quickly
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_MS).unref();

// lobby stats for players sitting on the menu / in the queue
setInterval(broadcastStats, 15_000).unref();

// Keep idle HTTP connections open longer than the reverse proxy does, so
// Traefik never reuses a socket Node has just closed (avoids random 502s).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

process.on('uncaughtException', (err) => { log('uncaughtException', err); process.exit(1); });
process.on('unhandledRejection', (err) => { log('unhandledRejection', err); });

server.listen(PORT, () => {
  log(`DULU server on :${PORT} — static from ${STATIC_DIR}`);
  log(`payments: ${payments.enabled ? `ON — ${payments.priceUgx} UGX per Rolex = ${payments.passHours}h online (players in Uganda)` : 'OFF (Relworx env vars not set) — online play is free'}; data in ${DATA_DIR}`);
  log(`card payments (outside Uganda): ${stripe.enabled ? `ON — Stripe, ${(stripe.config().priceCents / 100).toFixed(2)} ${stripe.config().currency.toUpperCase()} per Rolex` : 'OFF (STRIPE_SECRET_KEY not set) — online play free outside Uganda'}`);
  log(`limits: ${MAX_CONNECTIONS} connections, ${MAX_CONNECTIONS_PER_IP}/IP; origins: ${ALLOWED_ORIGINS.join(", ") || "any"}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('shutting down');
    for (const ws of wss.clients) try { ws.close(1012, 'server restarting'); } catch {}
    stopReconciler();
    server.close(() => { try { db.close(); } catch {} process.exit(0); });
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
