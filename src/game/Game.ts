import * as THREE from 'three';
import { SceneManager, ARENA_RADIUS } from '../scene/SceneManager';
import { Seed, SEED_RADIUS } from '../entities/Seed';
import { Obstacle, ObstacleKind } from '../entities/Obstacle';
import { FingerLauncher } from '../entities/FingerLauncher';
import { PhysicsWorld, CollisionEvent } from '../physics/PhysicsWorld';
import { DustSystem } from '../effects/Dust';
import { AudioManager } from '../audio/AudioManager';
import { UI, Player } from '../ui/UI';

type State =
  | 'MENU'
  | 'SETUP'
  | 'AIMING'
  | 'SHOOTING'
  | 'RESOLVING'
  | 'GAME_OVER';

const WIN_SCORE = 25;
const MAX_PULL = 2.6;          // world-units pull distance = max power
const MAX_LAUNCH_SPEED = 22;   // seed speed at max pull
const AIM_START_RADIUS = 2.6;  // must start drag within this world radius of active seed

export class Game {
  private scene: SceneManager;
  private phys = new PhysicsWorld();
  private dust = new DustSystem();
  private audio = new AudioManager();
  private finger = new FingerLauncher();
  private seeds: [Seed, Seed] | null = null;
  private obstacles: Obstacle[] = [];

  private ui: UI;
  private state: State = 'MENU';
  private currentPlayer: Player = 1;
  private scores: [number, number] = [0, 0];
  private hitDuringShot = false;
  private clock = new THREE.Clock();
  private lastGroundPoint: THREE.Vector3 | null = null;
  private pointerDown = false;
  private aimStart = new THREE.Vector3();
  private currentPull = new THREE.Vector3();
  private lastPullT = 0;
  private slowMoUntil = 0;
  private rollTickAccum = 0;
  private ambientDustAccum = 0;

  constructor(private canvas: HTMLCanvasElement, ui: UI) {
    this.ui = ui;
    this.scene = new SceneManager(canvas);
    this.scene.add(this.dust.points);
    this.scene.add(this.finger.group);

    this.phys.onCollision = (e) => this.handleCollision(e);
    this.setupInput();
  }

  async init() {
    // Prime audio on first interaction
    const prime = () => { this.audio.resume(); window.removeEventListener('pointerdown', prime); };
    window.addEventListener('pointerdown', prime);
    this.startLoop();
  }

  setSoundEnabled(v: boolean) { this.audio.setEnabled(v); }

  startNewGame() {
    // Reset
    this.scores = [0, 0];
    this.hitDuringShot = false;
    this.currentPlayer = 1;
    this.ui.setScore(0, 0);

    // Clear existing seeds/obstacles from scene
    if (this.seeds) {
      this.scene.remove(this.seeds[0].mesh);
      this.scene.remove(this.seeds[1].mesh);
    }
    for (const o of this.obstacles) this.scene.remove(o.mesh);
    this.obstacles.length = 0;
    this.phys.clearObstacles();
    this.phys.seeds.length = 0;

    // Create seeds at opposite ends
    const angle = Math.random() * Math.PI * 2;
    const dist = ARENA_RADIUS - 1.6;
    const s1 = new Seed(1);
    const s2 = new Seed(2);
    s1.setPosition(Math.cos(angle) * dist, Math.sin(angle) * dist);
    s2.setPosition(Math.cos(angle + Math.PI) * dist, Math.sin(angle + Math.PI) * dist);
    this.scene.add(s1.mesh);
    this.scene.add(s2.mesh);
    this.phys.addSeed(s1);
    this.phys.addSeed(s2);
    this.seeds = [s1, s2];

    // Generate obstacles between seeds, ensuring clear paths
    this.generateObstacles();

    this.beginTurn(1);
  }

  private generateObstacles() {
    if (!this.seeds) return;
    const rng = mulberry32(Math.floor(Math.random() * 1e9));
    const seed1 = this.seeds[0].pos.clone();
    const seed2 = this.seeds[1].pos.clone();

    const kinds: { kind: ObstacleKind; count: number }[] = [
      { kind: 'rock', count: 3 + Math.floor(rng() * 3) },
      { kind: 'pebble', count: 6 + Math.floor(rng() * 4) },
      { kind: 'stick', count: 2 + Math.floor(rng() * 2) },
      { kind: 'bump', count: 2 + Math.floor(rng() * 2) },
    ];

    for (const { kind, count } of kinds) {
      for (let i = 0; i < count; i++) {
        for (let attempt = 0; attempt < 30; attempt++) {
          const a = rng() * Math.PI * 2;
          const r = rng() * (ARENA_RADIUS - 1.2);
          const x = Math.cos(a) * r;
          const z = Math.sin(a) * r;
          const candidate = new THREE.Vector3(x, 0, z);
          // keep clear zone around each seed
          if (candidate.distanceTo(seed1) < 1.6) continue;
          if (candidate.distanceTo(seed2) < 1.6) continue;
          // avoid clustering
          let bad = false;
          for (const o of this.obstacles) {
            if (candidate.distanceTo(o.pos) < 0.55 + o.radius) { bad = true; break; }
          }
          if (bad) continue;
          // avoid blocking direct line between seeds too tightly (leave a lane on at least one side)
          const distToLine = pointToSegmentDist(candidate, seed1, seed2);
          if (distToLine < 0.35 && kind === 'rock') continue;

          const obs = new Obstacle(kind, x, z, rng);
          this.obstacles.push(obs);
          this.phys.addObstacle(obs);
          this.scene.addObstacle(obs.mesh);
          break;
        }
      }
    }
  }

  private beginTurn(player: Player) {
    this.currentPlayer = player;
    this.hitDuringShot = false;
    this.state = 'AIMING';
    this.ui.setActivePlayer(player);
    this.ui.setHint('PULL BACK • RELEASE');
    if (this.seeds) {
      this.finger.show(this.seeds[player - 1]);
      this.updateAimingCamera();
    }
  }

  /**
   * Frame the shot so BOTH seeds are always fully on screen with drag room
   * behind the active seed. Zoom is derived from the seed separation and
   * clamped so anything up to a coast-to-coast shot is visible.
   */
  private updateAimingCamera() {
    if (!this.seeds) return;
    const active = this.seeds[this.currentPlayer - 1];
    const opponent = this.seeds[this.currentPlayer === 1 ? 1 : 0];
    const focus = active.pos.clone().add(opponent.pos).multiplyScalar(0.5);
    const separation = active.pos.distanceTo(opponent.pos);
    const activeEdgeT = Math.min(1, Math.hypot(active.pos.x, active.pos.z) / ARENA_RADIUS);
    // Fit-based zoom: (separation + drag-room padding) / rough base coverage
    const zoom = Math.max(1, (separation + 5.5 + activeEdgeT * 2.5) / 9);
    this.scene.setCameraTargets(focus, zoom);
  }

  private endTurn() {
    // If we scored a hit, same player shoots again. Otherwise switch.
    if (this.hitDuringShot) {
      this.beginTurn(this.currentPlayer);
    } else {
      this.beginTurn(this.currentPlayer === 1 ? 2 : 1);
    }
  }

  // ---------- Input ----------

  private setupInput() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', (e) => this.onPointerMove(e));
    c.addEventListener('pointerup', (e) => this.onPointerUp(e));
    c.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private pointerGround(e: PointerEvent): THREE.Vector3 | null {
    return this.scene.screenToGround(new THREE.Vector2(e.clientX, e.clientY));
  }

  private onPointerDown(e: PointerEvent) {
    if (this.state !== 'AIMING' || !this.seeds) return;
    const gp = this.pointerGround(e);
    if (!gp) return;
    const seed = this.seeds[this.currentPlayer - 1];
    // Allow generous grab zone
    if (gp.distanceTo(seed.pos) > AIM_START_RADIUS) return;
    this.pointerDown = true;
    this.aimStart.copy(gp);
    this.currentPull.set(0, 0, 0);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    this.audio.resume();
  }

  private onPointerMove(e: PointerEvent) {
    if (!this.pointerDown || this.state !== 'AIMING' || !this.seeds) return;
    const gp = this.pointerGround(e);
    if (!gp) return;
    // pull vector = start - current (drag backward from seed direction)
    this.currentPull.subVectors(this.aimStart, gp);
    this.currentPull.y = 0;
    const pullMag = Math.min(MAX_PULL, this.currentPull.length());
    const pullT = pullMag / MAX_PULL;
    this.lastPullT = pullT;
    // Aim direction = OPPOSITE of drag (finger snaps forward when released)
    const aimDir = this.currentPull.clone();
    if (aimDir.lengthSq() < 1e-6) {
      this.finger.setAim(new THREE.Vector3(0, 0, 1), 0);
      return;
    }
    aimDir.normalize();
    this.finger.setAim(aimDir, pullT);
  }

  private onPointerUp(e: PointerEvent) {
    if (!this.pointerDown || !this.seeds) { this.pointerDown = false; return; }
    this.pointerDown = false;
    if (this.state !== 'AIMING') return;

    const pullLen = this.currentPull.length();
    if (pullLen < 0.15) {
      // too weak — cancel
      this.finger.resetPull();
      return;
    }
    const pullT = Math.min(1, pullLen / MAX_PULL);
    const speed = pullT * MAX_LAUNCH_SPEED;
    const dir = this.currentPull.clone().normalize();
    const seed = this.seeds[this.currentPlayer - 1];
    seed.vel.set(dir.x * speed, 0, dir.z * speed);

    // audio + dust burst at launch
    this.audio.launch();
    this.dust.burst(seed.pos.x, seed.pos.z, 14, 0.8 + pullT * 0.6);
    this.scene.shake(0.08 + pullT * 0.14);

    this.finger.snap();
    // Let the flick animation play before hiding the hand
    window.setTimeout(() => this.finger.hide(), 220);

    this.state = 'SHOOTING';
    this.ui.setHint('BLASTING…');
  }

  // ---------- Collision handling ----------

  private handleCollision(e: CollisionEvent) {
    if (e.type === 'seed-seed') {
      // Attacking seed is the current player's
      if (!this.seeds) return;
      const attacker = this.seeds[this.currentPlayer - 1];
      const other = attacker === e.a ? e.b! : e.a;
      // Only count as hit if attacker was actually moving significantly
      const attackerSpeed = Math.hypot(attacker.vel.x, attacker.vel.z) + Math.hypot(other.vel.x, other.vel.z);
      if (attackerSpeed > 0.4) {
        this.hitDuringShot = true;
        this.scores[this.currentPlayer - 1]++;
        this.ui.setScore(this.scores[0], this.scores[1]);
        this.ui.flashBlast('BLAST! +1');
        this.audio.seedHitSeed();
        this.audio.score();
        this.dust.burst(e.point.x, e.point.z, 26, 1.3);
        this.scene.shake(0.35);
        this.slowMoUntil = performance.now() + 100;
      }
    } else if (e.type === 'seed-obstacle') {
      const power = Math.min(1, e.impactSpeed / 12);
      this.audio.seedHitObstacle();
      this.dust.burst(e.point.x, e.point.z, Math.floor(8 + power * 14), 0.5 + power * 0.8);
      this.scene.shake(0.08 + power * 0.2);

      // Rare "blasted into obstacle" — big rock, high impact.
      // The seed that CRASHED into the rock loses (its player is the loser).
      if (e.obstacle && e.obstacle.significant && e.impactSpeed > 10.5 && Math.random() < 0.06) {
        this.triggerBlastedIntoObstacle(e.a.playerId);
      }
    } else if (e.type === 'seed-wall') {
      const power = Math.min(1, e.impactSpeed / 12);
      this.audio.seedHitObstacle();
      this.dust.burst(e.point.x, e.point.z, Math.floor(4 + power * 8), 0.3 + power * 0.5);
      this.scene.shake(0.04 + power * 0.1);
    }
  }

  private triggerBlastedIntoObstacle(loser: Player) {
    if (this.state === 'GAME_OVER') return;
    this.state = 'GAME_OVER';
    this.audio.gameOverBust();
    this.scene.shake(0.6);
    const winner: Player = loser === 1 ? 2 : 1;
    setTimeout(() => {
      this.ui.showGameOver(winner, this.scores[0], this.scores[1], 'BLASTED INTO THE OBSTACLE!');
    }, 500);
  }

  // ---------- Loop ----------

  private startLoop() {
    const loop = () => {
      const rawDt = Math.min(0.05, this.clock.getDelta());
      const slow = performance.now() < this.slowMoUntil;
      const dt = slow ? rawDt * 0.35 : rawDt;

      if (this.state === 'SHOOTING' || this.state === 'RESOLVING') {
        this.phys.step(dt);
        if (this.seeds) {
          for (const s of this.seeds) {
            s.syncMesh();
            // dust trail for fast rolling
            const spd = Math.hypot(s.vel.x, s.vel.z);
            this.dust.trail(s.pos.x, s.pos.z, Math.min(1, spd / 8));
            // roll audio ticks
          }
          // aggregate rolling ticks
          const aggSpd = (Math.hypot(this.seeds[0].vel.x, this.seeds[0].vel.z) +
                          Math.hypot(this.seeds[1].vel.x, this.seeds[1].vel.z)) / 2;
          this.rollTickAccum += dt * aggSpd;
          if (this.rollTickAccum > 0.35) {
            this.audio.rollTick(Math.min(1, aggSpd / 6));
            this.rollTickAccum = 0;
          }
          // Frame both seeds always — fit-based zoom
          const active = this.seeds[this.currentPlayer - 1];
          const other = this.seeds[this.currentPlayer === 1 ? 1 : 0];
          const focus = active.pos.clone().add(other.pos).multiplyScalar(0.5);
          const separation = active.pos.distanceTo(other.pos);
          const zoom = Math.max(1, (separation + 4) / 9);
          this.scene.setCameraTargets(focus, zoom);
        }

        // Check if all resting
        if (this.phys.allSeedsResting()) {
          if (this.state === 'SHOOTING') this.state = 'RESOLVING';
          // small delay then finalize
          this.finalizeTurnSoon();
        }
      } else if (this.state === 'AIMING' && this.seeds) {
        // idle: seeds shouldn't move, but keep meshes synced
        for (const s of this.seeds) s.syncMesh();
      }

      // Ambient dust drifting through the arena
      this.ambientDustAccum += rawDt;
      if (this.ambientDustAccum > 0.35) {
        this.ambientDustAccum = 0;
        this.dust.ambient(1, ARENA_RADIUS);
      }

      this.finger.update(dt);
      this.dust.update(dt);
      this.scene.update(dt);
      this.scene.render();

      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private finalizeScheduled = false;
  private finalizeTurnSoon() {
    if (this.finalizeScheduled) return;
    this.finalizeScheduled = true;
    window.setTimeout(() => {
      this.finalizeScheduled = false;
      if (this.state !== 'RESOLVING') return;
      // check victory
      if (this.scores[0] >= WIN_SCORE) {
        this.state = 'GAME_OVER';
        this.audio.victory();
        this.ui.showGameOver(1, this.scores[0], this.scores[1]);
        return;
      }
      if (this.scores[1] >= WIN_SCORE) {
        this.state = 'GAME_OVER';
        this.audio.victory();
        this.ui.showGameOver(2, this.scores[0], this.scores[1]);
        return;
      }
      this.endTurn();
    }, 400);
  }
}

function pointToSegmentDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const ab = new THREE.Vector3().subVectors(b, a);
  const ap = new THREE.Vector3().subVectors(p, a);
  const t = Math.max(0, Math.min(1, ap.dot(ab) / ab.lengthSq()));
  const proj = a.clone().addScaledVector(ab, t);
  return proj.distanceTo(p);
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
