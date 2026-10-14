# DULU — The Blasting Game

A 3D browser recreation of a Ugandan childhood game where two players flick hard seeds at each other from a middle-finger launch. First player to 25 hits wins.

Built with Three.js + TypeScript + Vite, plus a tiny Node WebSocket server for online play.

**Modes**
- **Play Online** — no sign-up. You're matched with the next person who taps Play Online.
- **Play a Friend** — creates a 4-letter room code and a link (`/r/K7QX`) to send on WhatsApp etc.
- **Same Device** — the original hot-seat 2-player game.

## Run locally

```bash
npm install
npm run dev:server   # terminal 1 — multiplayer server on :8787
npm run dev          # terminal 2 — game on http://localhost:5173 (proxies /ws to :8787)
```

To test online play on your own, open the game in two different browsers (or one normal + one private window), since each browser gets its own guest identity.

## Play

- **Pull** — press and drag backward from your seed.
- **Aim** — the arrow shows where the seed launches.
- **Release** — let go, the finger snaps forward and blasts the seed.
- **Hit** the opponent's seed to score +1 — and you shoot again.
- **Miss** — turn passes to the other player.
- **First to 25** wins.
- **Rare game-over:** blast your seed into a big rock at high speed and the game ends immediately with the other player winning.

Works with mouse, trackpad and touch. Rotate your phone if the arena feels cramped.

## How online play works

- **No accounts.** Each browser gets a random guest ID (saved in localStorage) and a nickname. The ID lets someone who refreshes or loses signal rejoin their match.
- **One server, one arena.** The server picks a random arena seed and sends the full layout (seed positions, every obstacle) to both players, so both see exactly the same field.
- **The shooter's screen decides the shot.** When you shoot, the opponent instantly sees your launch and watches it play out. When everything stops, your screen reports where the seeds ended up and how many hits you scored; the server checks it (your turn, sane positions, launch speed within limits), updates the score and decides whose turn is next. The opponent's seeds glide to the exact final positions, so both screens always agree.
- **Fair play:** 40 s to take each shot (countdown appears in the last 15 s). Miss 3 turns in a row and you forfeit. If someone disconnects, the other player sees a countdown; after 45 s without reconnecting, they forfeit. Leaving a match (✕, then tap again to confirm) counts as a forfeit.
- After a game: **Rematch** (loser shoots first), **New Opponent**, or **Menu**.

Server files: `server/index.js` (matchmaking, rooms, turns, static file serving) and `shared/arena.js` (arena generator used by both the server and the game).

The server listens on `PORT` (default `8787`, `80` in Docker) and serves the built game from `STATIC_DIR` (default `./dist`). Other settings are listed under *Deploy on Coolify*.

`GET /healthz` returns `{"ok":true,"online":…,"playing":…,"queue":…}`. Handy for a quick look at how many people are on.


## Build

```bash
npm run build      # production bundle in dist/
npm start          # serve dist/ + multiplayer on :8787
npm run check      # typecheck + server syntax check
```

## Deploy on Coolify

One Dockerfile app serves the game **and** the multiplayer WebSocket (`/ws`) on the same port and domain. You need no database, no volumes and no required env vars.

### First-time setup
1. **Projects → (your project) → + New → Public/Private Repository** → pick `tagasimon/Dulu`, branch `main`.
2. **Build Pack:** `Dockerfile` (Dockerfile location `/Dockerfile`).
3. **Ports Exposes:** `80`. Leave *Ports Mappings* empty (Traefik routes to it).
4. **Domains:** e.g. `https://dulu.yourdomain.com`. Point a DNS **A record** for that name at the VPS IP first, and Coolify gets the Let's Encrypt certificate automatically.
5. **Health check:** nothing to set. The Dockerfile already checks `/healthz` every 30 s.
6. **Deploy.** The first build takes ~1–2 minutes. The log should end with
   `DULU server on :80 …` and `limits: 2000 connections, 50/IP; origins: any`.

### Updating an existing DULU app (the old nginx version)
Nothing to change in Coolify: still the Dockerfile build pack, still port 80. Merge to `main` and redeploy (or let the GitHub webhook do it).

### Check it's live
- `https://dulu.yourdomain.com/healthz` → `{"ok":true,"online":0,"playing":0,"queue":0}`
- Open the game on two phones (or a phone + laptop), tap **Play Online** on both, and you should be matched within a second.
- If matching never happens and the menu shows no "online now" count, the WebSocket isn't getting through. Open DevTools → Network → WS and check `wss://…/ws` returns **101**. Coolify's Traefik passes WebSockets by default; the usual culprit is a Cloudflare proxy with WebSockets disabled, or custom Traefik labels.

### Optional environment variables
| Variable | Default | What it does |
|---|---|---|
| `ALLOWED_ORIGINS` | *(any)* | Comma-separated origins allowed to open the WebSocket, e.g. `https://dulu.yourdomain.com`. Stops other sites embedding your server. |
| `MAX_CONNECTIONS` | `2000` | Total simultaneous players before new ones get "server busy". |
| `MAX_CONNECTIONS_PER_IP` | `50` | Kept generous because mobile networks (MTN, Airtel) put many phones behind one IP. |
| `AIM_TIME_MS` | `40000` | Time allowed per shot. |
| `RECONNECT_GRACE_MS` | `45000` | How long a dropped player has to come back before forfeiting. |

### Things to know
- **Keep it at one instance.** Matches live in the server's memory, so don't scale to multiple replicas or containers. One instance easily handles hundreds of simultaneous games on a small VPS (~70 MB RAM).
- **Redeploys end live matches.** Players see "match lost" and can start a new one, so deploy when it's quiet.
- **CI:** `.github/workflows/docker.yml` builds the exact image on every push, starts it, and checks the page, `/healthz` and the WebSocket handshake. A green tick on GitHub means Coolify's build will work.
- Static files are gzipped, and hashed bundles are cached for a year.

Local Docker check (needs Docker running):

```bash
docker build -t dulu .
docker run --rm -p 8080:80 dulu
# open http://localhost:8080 in two browsers
```

## Structure

```
server/index.js           multiplayer server: matchmaking, rooms, turns, reconnects, static files
shared/arena.js           seeded arena generator shared by server + game (+ arena.d.ts types)
src/
  main.ts                 entry, wires UI + Game + network
  style.css               HUD, menu, tutorial, game-over styling
  game/Game.ts            orchestrator, state machine, turn logic
  scene/SceneManager.ts   three.js scene, camera, terrain, lighting
  physics/PhysicsWorld.ts custom XZ-plane physics (friction, restitution, collisions)
  entities/
    Seed.ts               procedurally distorted seed + rolling rotation
    Obstacle.ts           rocks, pebbles, sticks, dirt bumps
    FingerLauncher.ts     visible finger that bends and snaps
  effects/Dust.ts         warm dust burst + rolling trail particles
  audio/AudioManager.ts   WebAudio-synthesized launch/thwack/roll SFX
  ui/UI.ts                HUD/menu/lobby/tutorial/game-over DOM controllers
  net/Net.ts              WebSocket client with auto-reconnect
  net/identity.ts         anonymous guest ID + nickname (localStorage)
```
