import * as THREE from 'three';
import { Seed, SEED_RADIUS } from '../entities/Seed';
import { Obstacle } from '../entities/Obstacle';
import { ARENA_RADIUS } from '../scene/SceneManager';

export interface CollisionEvent {
  type: 'seed-seed' | 'seed-obstacle' | 'seed-wall';
  a: Seed;
  b?: Seed;
  obstacle?: Obstacle;
  impactSpeed: number;
  point: THREE.Vector3;
}

const FRICTION = 1.35;     // linear damping / sec (rough dirt)
const REST_THRESHOLD = 0.11;
const WALL_REST = 0.45;
const SEED_SEED_REST = 0.72;
const MAX_STEP_DT = 1 / 90;

export class PhysicsWorld {
  seeds: Seed[] = [];
  obstacles: Obstacle[] = [];
  onCollision: (e: CollisionEvent) => void = () => {};

  addSeed(s: Seed) { this.seeds.push(s); }
  addObstacle(o: Obstacle) { this.obstacles.push(o); }
  clearObstacles() { this.obstacles.length = 0; }

  step(dt: number) {
    // sub-step for stability with fast seeds
    let remaining = dt;
    while (remaining > 0) {
      const step = Math.min(MAX_STEP_DT, remaining);
      this.substep(step);
      remaining -= step;
    }
  }

  private substep(dt: number) {
    // apply friction & integrate
    for (const s of this.seeds) {
      // dirt friction: apply drag proportional to velocity
      const speed = Math.hypot(s.vel.x, s.vel.z);
      if (speed > 0) {
        // combination: linear decay + coulomb-ish flat term
        const decay = Math.max(0, 1 - FRICTION * dt);
        s.vel.x *= decay;
        s.vel.z *= decay;
        const flat = 0.35 * dt;
        const newSpeed = Math.hypot(s.vel.x, s.vel.z);
        if (newSpeed > flat) {
          const k = (newSpeed - flat) / newSpeed;
          s.vel.x *= k;
          s.vel.z *= k;
        } else {
          s.vel.x = 0; s.vel.z = 0;
        }
      }

      // integrate
      s.pos.x += s.vel.x * dt;
      s.pos.z += s.vel.z * dt;
      s.pos.y = s.radius;

      // stop if under threshold and no velocity
      if (Math.hypot(s.vel.x, s.vel.z) < REST_THRESHOLD * 0.4) {
        s.vel.x = 0; s.vel.z = 0;
      }
    }

    // Collide with arena wall (circle boundary)
    for (const s of this.seeds) {
      const r2 = s.pos.x * s.pos.x + s.pos.z * s.pos.z;
      const boundary = ARENA_RADIUS - s.radius;
      if (r2 > boundary * boundary) {
        const dist = Math.sqrt(r2);
        const nx = s.pos.x / dist;
        const nz = s.pos.z / dist;
        s.pos.x = nx * boundary;
        s.pos.z = nz * boundary;
        const vDotN = s.vel.x * nx + s.vel.z * nz;
        if (vDotN > 0) {
          const impact = Math.abs(vDotN);
          s.vel.x -= (1 + WALL_REST) * vDotN * nx;
          s.vel.z -= (1 + WALL_REST) * vDotN * nz;
          if (impact > 1.2) {
            this.onCollision({
              type: 'seed-wall',
              a: s,
              impactSpeed: impact,
              point: new THREE.Vector3(s.pos.x, s.pos.y, s.pos.z),
            });
          }
        }
      }
    }

    // Collide with obstacles (treat as static circles in XZ)
    for (const s of this.seeds) {
      for (const o of this.obstacles) {
        const dx = s.pos.x - o.pos.x;
        const dz = s.pos.z - o.pos.z;
        const rSum = s.radius + o.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 < rSum * rSum && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const nx = dx / d;
          const nz = dz / d;
          // Push seed out
          const penetration = rSum - d;
          s.pos.x += nx * penetration;
          s.pos.z += nz * penetration;
          const vDotN = s.vel.x * nx + s.vel.z * nz;
          if (vDotN < 0) {
            const impact = -vDotN;
            const rest = o.restitution;
            s.vel.x -= (1 + rest) * vDotN * nx;
            s.vel.z -= (1 + rest) * vDotN * nz;
            // add a small tangential scatter to make it feel physical
            s.vel.x += (-nz) * (Math.random() - 0.5) * impact * 0.1;
            s.vel.z += (nx) * (Math.random() - 0.5) * impact * 0.1;
            if (impact > 0.4) {
              this.onCollision({
                type: 'seed-obstacle',
                a: s,
                obstacle: o,
                impactSpeed: impact,
                point: new THREE.Vector3(o.pos.x + nx * o.radius, s.pos.y, o.pos.z + nz * o.radius),
              });
            }
          }
        }
      }
    }

    // Seed-seed collision (only 2 seeds)
    if (this.seeds.length === 2) {
      const a = this.seeds[0];
      const b = this.seeds[1];
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const rSum = a.radius + b.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 < rSum * rSum && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const nz = dz / d;
        // separate
        const penetration = rSum - d;
        a.pos.x -= nx * penetration * 0.5;
        a.pos.z -= nz * penetration * 0.5;
        b.pos.x += nx * penetration * 0.5;
        b.pos.z += nz * penetration * 0.5;
        // relative velocity along normal
        const rvx = b.vel.x - a.vel.x;
        const rvz = b.vel.z - a.vel.z;
        const vAlong = rvx * nx + rvz * nz;
        if (vAlong < 0) {
          const impact = -vAlong;
          // equal masses: exchange normal components with restitution
          const j = -(1 + SEED_SEED_REST) * vAlong / 2;
          a.vel.x -= j * nx;
          a.vel.z -= j * nz;
          b.vel.x += j * nx;
          b.vel.z += j * nz;
          this.onCollision({
            type: 'seed-seed',
            a, b,
            impactSpeed: impact,
            point: new THREE.Vector3(
              (a.pos.x + b.pos.x) / 2,
              SEED_RADIUS,
              (a.pos.z + b.pos.z) / 2
            ),
          });
        }
      }
    }
  }

  allSeedsResting(): boolean {
    return this.seeds.every(s => !s.isMoving(REST_THRESHOLD));
  }
}
