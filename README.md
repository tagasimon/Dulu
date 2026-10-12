# DULU — The Blasting Game

A 3D browser recreation of a Ugandan childhood game where two players flick hard seeds at each other from a middle-finger launch. First player to 25 hits wins.

Built with Three.js + TypeScript + Vite. No frameworks, no online multiplayer — local hotseat 2-player.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173.

## Play

- **Pull** — press and drag backward from your seed.
- **Aim** — the arrow shows where the seed launches.
- **Release** — let go, the finger snaps forward and blasts the seed.
- **Hit** the opponent's seed to score +1 — and you shoot again.
- **Miss** — turn passes to the other player.
- **First to 25** wins.
- **Rare game-over:** blast your seed into a big rock at high speed and the game ends immediately with the other player winning.

Works with mouse, trackpad and touch. Rotate your phone if the arena feels cramped.

## Build

```bash
npm run build      # production bundle in dist/
npm run preview    # serve the built bundle
```

## Deploy on Coolify

The repo ships with a multi-stage `Dockerfile` (node build → nginx serve) plus a tuned `nginx.conf`. Coolify will pick these up automatically.

1. In Coolify, create a **New Resource → Application** and point it at this repo.
2. **Build Pack**: `Dockerfile` (auto-detected).
3. **Ports**:
   - Container port: `80`
   - Publicly exposed: whatever domain you attach (Coolify handles TLS via Let's Encrypt).
4. **Health check**: already declared in the Dockerfile (`HEALTHCHECK` hits `http://127.0.0.1/`). Coolify will pick it up.
5. Deploy. Coolify will run `docker build .` then start the container.

Local sanity check (needs Docker running):

```bash
docker build -t dulu .
docker run --rm -p 8080:80 dulu
# open http://localhost:8080
```

Notes:
- `nginx.conf` gzips text assets, caches hashed bundles for 1 year, and adds SPA fallback + basic security headers.
- No env vars, no backend, no persistent volumes — pure static bundle.
- Bundle is ~530 KB (~137 KB gzipped) — mostly `three`. Fine on 3G.

## Structure

```
src/
  main.ts                 entry, wires UI + Game
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
  ui/UI.ts                HUD/menu/tutorial/game-over DOM controllers
```
