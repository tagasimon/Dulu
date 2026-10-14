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
- **Topie (T):** before you shoot, tap **Topie** (or press **T**) to stand your opponent's seed up on its edge like a coin: taller and easier to hit for that shot. It falls flat when hit or when the turn ends. 3 per player per game, one per turn; synced online.
- **Holes** don't block seeds but swallow them: a seed that rolls in slows down and slides to the middle, while a fast one rolls out the other side.
- **Rare game-over:** blast your seed into a big rock at high speed and the game ends immediately with the other player winning.

Works with mouse, trackpad and touch. Rotate your phone if the arena feels cramped.

## How online play works

- **No accounts.** Each browser gets a random guest ID (saved in localStorage) and a nickname. The ID lets someone who refreshes or loses signal rejoin their match.
- **One server, one arena.** The server picks a random arena seed and sends the full layout (seed positions, every obstacle) to both players, so both see exactly the same field.
- **The shooter's screen decides the shot.** When you shoot, the opponent instantly sees your launch and watches it play out. When everything stops, your screen reports where the seeds ended up and how many hits you scored; the server checks it (your turn, sane positions, launch speed within limits), updates the score and decides whose turn is next. The opponent's seeds glide to the exact final positions, so both screens always agree.
- **Fair play:** 40 s to take each shot (countdown appears in the last 15 s). Miss 3 turns in a row and you forfeit. If someone disconnects, the other player sees a countdown; after 45 s without reconnecting, they forfeit. Leaving a match (✕, then tap again to confirm) counts as a forfeit.
- After a game: **Rematch** (loser shoots first), **New Opponent**, or **Home**.
- **Home** is always one tap away: the ⌂ HOME button in a game (online it asks "tap again", since leaving forfeits), ⌂ HOME on the lobby and game-over screens, and the phone's **back button** (same rules).

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
4. **Domains:** e.g. `https://dulu.elastictech.biz`. Point a DNS **A record** for that name at the VPS IP first, and Coolify gets the Let's Encrypt certificate automatically.
5. **Health check:** nothing to set. The Dockerfile already checks `/healthz` every 30 s.
6. **Deploy.** The first build takes ~1–2 minutes. The log should end with
   `DULU server on :80 …` and `limits: 2000 connections, 50/IP; origins: any`.

### Updating an existing DULU app (the old nginx version)
Nothing to change in Coolify: still the Dockerfile build pack, still port 80. Merge to `main` and redeploy (or let the GitHub webhook do it).

### Check it's live
- `https://dulu.elastictech.biz/healthz` → `{"ok":true,"online":0,"playing":0,"queue":0}`
- Open the game on two phones (or a phone + laptop), tap **Play Online** on both, and you should be matched within a second.
- If matching never happens and the menu shows no "online now" count, the WebSocket isn't getting through. Open DevTools → Network → WS and check `wss://…/ws` returns **101**. Coolify's Traefik passes WebSockets by default; the usual culprit is a Cloudflare proxy with WebSockets disabled, or custom Traefik labels.

### Optional environment variables
| Variable | Default | What it does |
|---|---|---|
| `ALLOWED_ORIGINS` | *(any)* | Comma-separated origins allowed to open the WebSocket, e.g. `https://dulu.elastictech.biz`. Stops other sites embedding your server. |
| `MAX_CONNECTIONS` | `2000` | Total simultaneous players before new ones get "server busy". |
| `MAX_CONNECTIONS_PER_IP` | `50` | Kept generous because mobile networks (MTN, Airtel) put many phones behind one IP. |
| `AIM_TIME_MS` | `40000` | Time allowed per shot. |
| `RECONNECT_GRACE_MS` | `45000` | How long a dropped player has to come back before forfeiting. |

### Things to know
- **Add the `/data` volume** (Persistent Storage) once payments are on. See *Buy me a coffee* below.
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

## Buy me a Rolex 🌯 (Relworx mobile money + Buy Me a Coffee)

A *Rolex* is Uganda's chapati-and-egg street food (about 2,000 UGX), so "buy me a Rolex" is the local "buy me a coffee".

**Players in Uganda** (browser timezone `Africa/Kampala`):
- Same Device is always free.
- Play Online and *creating* a friend room need a Rolex: **1 Rolex = 2,000 UGX = 24 hours**, and more Rolexes stack extra days. They pay with MTN/Airtel Mobile Money via Relworx.
- A friend who opens your room link plays free.
- Free players see a quiet "Buy me a Rolex 🌯" on the menu and the game-over card. It never interrupts a game.

**Players outside Uganda** play online free and see a yellow **Buy me a Rolex** button that opens [Buy Me a Coffee](https://www.buymeacoffee.com/elastictechnologies) (card payments, a tip only). If they are actually in Uganda, an "In Uganda? Use Mobile Money" link switches them over. There's deliberately no switch the other way on the paywall, so it can't be used to skip paying.

The region comes from the browser's timezone, so it's a soft gate: someone determined could change their phone's timezone to play online free.

Players and the server see who's around: the menu shows a live pill ("3 other players online · 1 in games", or "1 player waiting for a match — tap Play Online" when someone's in the queue), updated within ~1.5 s.

How a purchase works:
1. The player picks how many Rolexes and enters their MTN/Airtel number (never a PIN).
2. The server saves a `PENDING` payment, then asks Relworx to collect. Relworx pushes the Mobile Money PIN prompt to the phone.
3. The game polls `/relworx/status` every 3 s (up to 90 s), and the **server also checks every pending payment with Relworx in the background**: every ~20 s for the first 15 minutes, then every 5 minutes for up to 24 hours. Whichever check sees the result first marks the payment `SUCCESS` (exactly once) and adds the time to the player's pass. Their open game unlocks instantly, and a player who approves after closing the page still gets the Rolex.
4. Money lands in the shared Relworx float. There are **no payouts here**; cash-out happens in Jukila.

Passes are tied to the player's anonymous browser ID. On a new phone or browser, **"Already bought one? Restore it"** copies an active pass across using the number they paid with.

**If the Relworx variables aren't set, payments are off and online play is free**, so you can deploy safely before configuring anything.

### Environment variables (set in Coolify → Environment Variables, never commit them)
| Variable | Example | Notes |
|---|---|---|
| `RELWORX_API_KEY` | *(from Relworx)* | Shared with Jukila so funds credit the same float. |
| `RELWORX_ACCOUNT_NO` | *(from Relworx)* | Shared with Jukila. |
| `RELWORX_WEBHOOK_SECRET` | *(from Relworx)* | Shared with Jukila. Used to verify `x-relworx-signature`. |
| `APP_REF_PREFIX` | `DULU-` | **Must differ from Jukila's `JK-`/`JKP-`**; the server refuses to start with those. |
| `ROLEX_PRICE_UGX` | `2000` | Optional. (`COFFEE_PRICE_UGX` also works.) |
| `PASS_HOURS` | `24` | Optional. Hours of online play per Rolex. |

### One-time setup
1. **Persistent storage:** Coolify → DULU app → *Persistent Storage* → add a volume with destination path **`/data`**. Payments and passes live in `/data/dulu.db` (SQLite). Without the volume, every redeploy forgets who has paid.
2. **Env vars:** add the variables above, then redeploy. The deploy log should show `payments: ON — 2000 UGX per Rolex = 24h online (players in Uganda)`.
3. **Relworx dashboard: change nothing.** The account is shared with Jukila and has only one *Request payment webhook* slot, which must stay `https://api.jukila.elastictech.biz/billing/webhook`. DULU doesn't need it because it confirms payments itself (step 3 above). DULU's own `/relworx/webhook` endpoint stays available in case Jukila ever forwards `DULU-` references to it.
4. **Test with a real Rolex:** Play Online → buy 1 Rolex with your own number → approve → you should see "Thank you! 🌯" and start matchmaking. The deploy log shows `payment DULU-… SUCCESS +1 Rolex(es)`.

### Endpoints
- `POST /relworx/collect` with `{ phone, rolexes | amountUgx, guestId }`: starts a collection. Rate-limited per IP and per phone number so nobody can spam prompts to a stranger's phone.
- `GET /relworx/status?reference=…`: the poll fallback.
- `POST /relworx/webhook`: HMAC-SHA256 signed. Returns 401 on a bad signature and 200 otherwise, including unknown references. Not registered with Relworx (that slot belongs to Jukila); kept for optional forwarding.
- `GET /api/coffee?guestId=…` and `POST /api/coffee/restore`: pass status and restore.

### Tests
`npm test` runs 26 tests against a mocked Relworx. They cover phone normalisation, collect validation, the row being saved before the Relworx call, error passthrough, webhook signatures, unknown references, retries, exactly-once finalisation under webhook + poll races, stacking and expiry, restore, and the background checker. To look at what's been paid on the server: `sqlite3 /data/dulu.db "select reference, msisdn, amount_ugx, status, created_at from payments order by created_at desc limit 20"` (or copy the file off the volume).

## Structure

```
server/index.js           multiplayer server: matchmaking, rooms, turns, reconnects, static files
server/payments.js        Relworx collections (collect / status / webhook), Rolex passes
server/db.js              SQLite schema (payments, passes); built into Node 22, no extra dependency
test/payments.test.js     payment tests (npm test)
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
  ui/Coffee.ts            buy-me-a-Rolex sheet (stepper, phone, polling, restore) + Buy Me a Coffee link
  net/region.ts           Uganda vs. elsewhere (timezone), decides Mobile Money vs. card
  net/Net.ts              WebSocket client with auto-reconnect
  net/identity.ts         anonymous guest ID + nickname (localStorage)
```
