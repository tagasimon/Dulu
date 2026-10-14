// Shared between the browser game and the multiplayer server.
// Plain JS (with arena.d.ts for types) so Node can import it without a build step.
//
// Given one integer seed, this produces the exact same arena layout everywhere:
// both seed start positions and every obstacle's kind, position and size.
// Online, the SERVER generates the layout and sends the resulting numbers to both
// players, so tiny Math.sin/cos differences between browsers can never make two
// players see different arenas.

export const ARENA_RADIUS = 9;
export const WIN_SCORE = 25;
export const MAX_LAUNCH_SPEED = 22;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

function dist(ax, az, bx, bz) {
  return Math.hypot(ax - bx, az - bz);
}

function pointToSegmentDist(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const apx = px - ax, apz = pz - az;
  const lenSq = abx * abx + abz * abz;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, (apx * abx + apz * abz) / lenSq)) : 0;
  return dist(px, pz, ax + abx * t, az + abz * t);
}

/** Collision radius + size parameters for one obstacle, drawn from rng. */
function obstacleSize(kind, rng) {
  switch (kind) {
    case 'rock': return { radius: 0.4 + rng() * 0.25, len: 0 };
    case 'pebble': return { radius: 0.18 + rng() * 0.1, len: 0 };
    case 'stick': {
      const len = 0.6 + rng() * 0.7;
      return { radius: Math.max(0.16, len * 0.3), len };
    }
    default: return { radius: 0.35, len: 0 }; // bump
  }
}

/**
 * @param {number} seed
 * @returns {import('./arena').ArenaLayout}
 */
export function generateArena(seed) {
  const rng = mulberry32(seed);
  const angle = rng() * Math.PI * 2;
  const d = ARENA_RADIUS - 1.6;
  const s1 = { x: round(Math.cos(angle) * d), z: round(Math.sin(angle) * d) };
  const s2 = { x: round(Math.cos(angle + Math.PI) * d), z: round(Math.sin(angle + Math.PI) * d) };

  const kinds = [
    { kind: 'rock', count: 3 + Math.floor(rng() * 3) },
    { kind: 'pebble', count: 6 + Math.floor(rng() * 4) },
    { kind: 'stick', count: 2 + Math.floor(rng() * 2) },
    { kind: 'bump', count: 2 + Math.floor(rng() * 2) },
  ];

  const obstacles = [];
  for (const { kind, count } of kinds) {
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const a = rng() * Math.PI * 2;
        const r = rng() * (ARENA_RADIUS - 1.2);
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        // keep a clear zone around each seed
        if (dist(x, z, s1.x, s1.z) < 1.6) continue;
        if (dist(x, z, s2.x, s2.z) < 1.6) continue;
        // avoid clustering
        let bad = false;
        for (const o of obstacles) {
          if (dist(x, z, o.x, o.z) < 0.55 + o.radius) { bad = true; break; }
        }
        if (bad) continue;
        // leave a lane between the seeds (no rocks right on the line)
        if (kind === 'rock' && pointToSegmentDist(x, z, s1.x, s1.z, s2.x, s2.z) < 0.35) continue;

        const size = obstacleSize(kind, rng);
        obstacles.push({
          kind,
          x: round(x),
          z: round(z),
          radius: round(size.radius),
          len: round(size.len),
          shapeSeed: Math.floor(rng() * 2 ** 31),
        });
        break;
      }
    }
  }

  return { seed, seeds: [s1, s2], obstacles };
}

// Round to 4 decimals so the layout serialises compactly and identically.
function round(n) {
  return Math.round(n * 10000) / 10000;
}
