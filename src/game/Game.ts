import * as THREE from 'three';
import { SceneManager, ARENA_RADIUS } from '../scene/SceneManager';
import { Seed } from '../entities/Seed';
import { Obstacle } from '../entities/Obstacle';
import { FingerLauncher } from '../entities/FingerLauncher';
import { PhysicsWorld, CollisionEvent } from '../physics/PhysicsWorld';
import { DustSystem } from '../effects/Dust';
import { AudioManager } from '../audio/AudioManager';
import { UI, Player } from '../ui/UI';
import {
  generateArena, randomSeed, WIN_SCORE, MAX_LAUNCH_SPEED, TOPIES_PER_GAME, type ArenaLayout,
} from '../../shared/arena';

type State =
  | 'MENU'
  | 'AIMING'      // someone is lining up a shot (input only if it's your seed)
  | 'SHOOTING'
  | 'RESOLVING'
  | 'WAITING'     // online: shot finished locally, waiting for the server's verdict
  | 'GAME_OVER';

export type Mode = 'local' | 'online';

/** Online: what the game needs to tell the server. */
export interface OnlineHooks {
  aim(x: number, z: number, t: number): void;
  launch(vx: number, vz: number): void;
  shotResult(seeds: [number, number][], hits: number, bust: Player | null): void;
  topie(): void;
}

export interface MatchInfo {
  you: Player;
  names: [string, string];
  layout: ArenaLayout;
  scores: [number, number];
  turn: Player;
  seeds: [number, number][];
  phase: 'aim' | 'shot' | 'over';
  deadline: number; // ms remaining in this turn
  topies?: [number, number];
  topieActive?: boolean;
}

export interface ServerState {
  scores: [number, number];
  turn: Player;
  seeds: [number, number][];
  deadline: number;
  hits: number;
  reason: 'shot' | 'timeout';
  topies?: [number, number];
}

export interface ServerGameOver {
  winner: Player;
  reason: 'score' | 'bust' | 'left' | 'disconnect' | 'afk';
  scores: [number, number];
  seeds: [number, number][];
}

type Pending =
  | { kind: 'state'; msg: ServerState }
  | { kind: 'over'; msg: ServerGameOver };

const MAX_PULL = 2.6;          // world-units pull distance = max power
const AIM_START_RADIUS = 2.6;  // must start drag within this world radius of active seed
const AIM_SEND_INTERVAL = 90;  // ms between aim updates sent to the opponent
const TURN_WARN_SECONDS = 15;  // show countdown when this little time is left

export class Game {
  /** Fired when an ONLINE match ends (local games use the UI directly). */
  onOnlineGameOver: (msg: ServerGameOver) => void = () => {};

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
  private pointerDown = false;
  private aimStart = new THREE.Vector3();
  private currentPull = new THREE.Vector3();
  private slowMoUntil = 0;
  private rollTickAccum = 0;
  private ambientDustAccum = 0;

  // ----- Topie -----
  /** Topies left for each player this game. */
  private topiesLeft: [number, number] = [TOPIES_PER_GAME, TOPIES_PER_GAME];
  /** Used this turn already (one per turn). */
  private topieThisTurn = false;
  /** HUD hook: show/hide/enable the Topie button. */
  onTopieChange: (st: { visible: boolean; enabled: boolean; left: number }) => void = () => {};

  // ----- online -----
  private mode: Mode = 'local';
  private me: Player = 1;
  private names: [string, string] = ['PLAYER 1', 'PLAYER 2'];
  private hooks: OnlineHooks | null = null;
  private shotHits = 0;
  private turnDeadline = 0;      // performance.now() timestamp
  private lastTurnLabel = '';
  private lastAimSent = 0;
  private pending: Pending[] = [];
  private processingPending = false;
  private waitingSince = 0;
  private tween: { from: THREE.Vector3[]; to: THREE.Vector3[]; t: number; dur: number; done: () => void } | null = null;

  constructor(private canvas: HTMLCanvasElement, ui: UI) {
    this.ui = ui;
    this.scene = new SceneManager(canvas);
    this.scene.add(this.dust.points);
    this.scene.add(this.finger.group);

    this.phys.onCollision = (e) => this.handleCollision(e);
    this.setupInput();

    // Browsers pause animation in background tabs. If the shooter switches to
    // another app mid-shot, finish the shot instantly so the result still
    // reaches the opponent.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.fastForwardShot();
    });
  }

  private fastForwarding = false;

  private fastForwardShot() {
    if (this.state !== 'SHOOTING' && this.state !== 'RESOLVING') return;
    if (this.mode === 'online' && !this.isMyTurn()) return; // spectators catch up via the server
    this.fastForwarding = true;
    try {
      for (let i = 0; i < 60 * 30 && !this.phys.allSeedsResting(); i++) {
        this.phys.step(1 / 60);
        if (this.state !== 'SHOOTING' && this.state !== 'RESOLVING') break; // e.g. bust
      }
    } finally {
      this.fastForwarding = false;
    }
    if (this.state !== 'SHOOTING' && this.state !== 'RESOLVING') return;
    this.seeds?.forEach((s) => { s.vel.set(0, 0, 0); s.syncMesh(); });
    this.state = 'RESOLVING';
    this.finalizeTurnSoon();
  }

  async init() {
    // Prime audio on first interaction
    const prime = () => { this.audio.resume(); window.removeEventListener('pointerdown', prime); };
    window.addEventListener('pointerdown', prime);
    this.startLoop();
  }

  setSoundEnabled(v: boolean) { this.audio.setEnabled(v); }

  get isOnline() { return this.mode === 'online'; }

  // ---------- Starting / stopping ----------

  /** Local hot-seat game on one device. */
  startNewGame() {
    this.mode = 'local';
    this.hooks = null;
    this.names = ['PLAYER 1', 'PLAYER 2'];
    this.ui.setNames('PLAYER 1', 'PLAYER 2');
    this.resetCommon();
    this.buildArena(generateArena(randomSeed()));
    this.beginTurn(1);
  }

  /** Start (or resume after reconnect) an online match from the server. */
  startOnline(m: MatchInfo, hooks: OnlineHooks) {
    this.mode = 'online';
    this.hooks = hooks;
    this.me = m.you;
    this.names = m.names;
    const label = (p: Player) => (p === m.you ? `${m.names[p - 1]} (YOU)` : m.names[p - 1]).toUpperCase();
    this.ui.setNames(label(1), label(2));
    this.resetCommon();
    this.buildArena(m.layout, m.seeds);
    this.scores = [m.scores[0], m.scores[1]];
    this.ui.setScore(this.scores[0], this.scores[1]);
    this.setDeadline(m.deadline);
    if (m.topies) this.topiesLeft = [m.topies[0], m.topies[1]];

    if (m.phase === 'shot') {
      // Rejoined mid-shot: wait for the result, then carry on.
      this.currentPlayer = m.turn;
      this.ui.setActivePlayer(m.turn, this.turnLabel());
      this.ui.setHint('SYNCING…');
      this.finger.hide();
      this.state = 'WAITING';
      this.waitingSince = performance.now();
      this.frameBothSeeds();
    } else {
      this.beginTurn(m.turn);
    }
  }

  /** Back to the menu: freeze the arena, drop pending network events. */
  stop() {
    this.state = 'MENU';
    this.onTopieChange({ visible: false, enabled: false, left: 0 });
    this.pending = [];
    this.processingPending = false;
    this.tween = null;
    this.pointerDown = false;
    this.finger.hide();
  }

  private resetCommon() {
    this.topiesLeft = [TOPIES_PER_GAME, TOPIES_PER_GAME];
    this.topieThisTurn = false;
    this.scores = [0, 0];
    this.hitDuringShot = false;
    this.shotHits = 0;
    this.pending = [];
    this.processingPending = false;
    this.tween = null;
    this.pointerDown = false;
    this.turnDeadline = 0;
    this.lastTurnLabel = '';
    this.ui.setScore(0, 0);
  }

  private buildArena(layout: ArenaLayout, seedPositions?: [number, number][]) {
    // Clear existing seeds/obstacles from scene
    if (this.seeds) {
      this.scene.remove(this.seeds[0].mesh);
      this.scene.remove(this.seeds[1].mesh);
    }
    // Obstacles live inside the ground group, so remove them from their parent.
    for (const o of this.obstacles) o.mesh.removeFromParent();
    this.obstacles.length = 0;
    this.phys.clearObstacles();
    this.phys.seeds.length = 0;

    const s1 = new Seed(1);
    const s2 = new Seed(2);
    const p1 = seedPositions?.[0] ?? [layout.seeds[0].x, layout.seeds[0].z];
    const p2 = seedPositions?.[1] ?? [layout.seeds[1].x, layout.seeds[1].z];
    s1.setPosition(p1[0], p1[1]);
    s2.setPosition(p2[0], p2[1]);
    this.scene.add(s1.mesh);
    this.scene.add(s2.mesh);
    this.phys.addSeed(s1);
    this.phys.addSeed(s2);
    this.seeds = [s1, s2];

    for (const spec of layout.obstacles) {
      const obs = new Obstacle(spec);
      this.obstacles.push(obs);
      this.phys.addObstacle(obs);
      this.scene.addObstacle(obs.mesh);
    }
  }

  // ---------- Turns ----------

  /** Does the person at this screen control the current shot? */
  private isMyTurn() {
    return this.mode === 'local' || this.currentPlayer === this.me;
  }

  private turnLabel(): string {
    const p = this.currentPlayer;
    if (this.mode === 'local') return `PLAYER ${p}'S TURN`;
    let label = p === this.me ? 'YOUR TURN' : `${this.names[p - 1].toUpperCase()}'S TURN`;
    if (this.state === 'AIMING' && this.turnDeadline > 0) {
      const secs = Math.max(0, Math.ceil((this.turnDeadline - performance.now()) / 1000));
      if (secs <= TURN_WARN_SECONDS) label += ` · ${secs}s`;
    }
    return label;
  }

  private setDeadline(msRemaining: number) {
    this.turnDeadline = msRemaining > 0 ? performance.now() + msRemaining : 0;
  }

  private beginTurn(player: Player) {
    this.currentPlayer = player;
    this.hitDuringShot = false;
    this.shotHits = 0;
    this.state = 'AIMING';
    // A stood-up seed that wasn't knocked over lies back down for the new turn.
    this.topieThisTurn = false;
    this.seeds?.forEach((s) => s.setStanding(false));
    this.lastTurnLabel = '';
    this.ui.setActivePlayer(player, this.turnLabel());
    if (this.isMyTurn()) {
      this.ui.setHint('PULL BACK • RELEASE');
    } else {
      this.ui.setHint(`WAITING FOR ${this.names[player - 1].toUpperCase()}…`);
    }
    if (this.seeds) {
      this.finger.show(this.seeds[player - 1]);
      this.updateAimingCamera();
    }
    this.refreshTopie();
  }

  // ---------- Topie ----------

  /**
   * "Topie!" — before shooting, the player can make the opponent's seed stand
   * on its edge (tallest way up, like a coin on its side): a bigger, easier
   * target for this shot. Limited per game; one per turn.
   */
  requestTopie() {
    if (!this.canTopie()) return;
    this.hooks?.topie();
    this.applyTopie(this.currentPlayer);
  }

  /** Opponent called Topie (online). */
  remoteTopie(by: Player, left?: [number, number]) {
    if (this.mode !== 'online' || this.state !== 'AIMING' || this.currentPlayer !== by || this.topieThisTurn) return;
    this.applyTopie(by);
    if (left) this.topiesLeft = [left[0], left[1]];
    this.refreshTopie();
  }

  private canTopie() {
    return this.state === 'AIMING' && this.isMyTurn() && !this.pointerDown && !this.topieThisTurn &&
      this.topiesLeft[this.currentPlayer - 1] > 0 && !!this.seeds;
  }

  private applyTopie(by: Player) {
    if (!this.seeds) return;
    this.topieThisTurn = true;
    this.topiesLeft[by - 1] = Math.max(0, this.topiesLeft[by - 1] - 1);
    const target = this.seeds[by === 1 ? 1 : 0];
    target.setStanding(true);
    this.audio.seedHitObstacle();
    this.dust.burst(target.pos.x, target.pos.z, 8, 0.5);
    this.ui.flashBlast('TOPIE!');
    this.refreshTopie();
  }

  private refreshTopie() {
    const me = this.mode === 'local' ? this.currentPlayer : this.me;
    const myTurn = this.isMyTurn();
    this.onTopieChange({
      visible: this.state !== 'MENU' && this.state !== 'GAME_OVER',
      enabled: this.canTopie(),
      left: this.topiesLeft[(myTurn ? this.currentPlayer : me) - 1],
    });
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

  private frameBothSeeds() {
    if (!this.seeds) return;
    const active = this.seeds[this.currentPlayer - 1];
    const other = this.seeds[this.currentPlayer === 1 ? 1 : 0];
    const focus = active.pos.clone().add(other.pos).multiplyScalar(0.5);
    const separation = active.pos.distanceTo(other.pos);
    const zoom = Math.max(1, (separation + 4) / 9);
    this.scene.setCameraTargets(focus, zoom);
  }

  private endTurnLocal() {
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
    // Keyboard shortcut: T = Topie (ignored while typing in a text box)
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if ((e.key === 't' || e.key === 'T') && !e.repeat) this.requestTopie();
    });
  }

  private pointerGround(e: PointerEvent): THREE.Vector3 | null {
    return this.scene.screenToGround(new THREE.Vector2(e.clientX, e.clientY));
  }

  private onPointerDown(e: PointerEvent) {
    if (this.state !== 'AIMING' || !this.seeds || !this.isMyTurn()) return;
    const gp = this.pointerGround(e);
    if (!gp) return;
    const seed = this.seeds[this.currentPlayer - 1];
    // Allow generous grab zone
    if (gp.distanceTo(seed.pos) > AIM_START_RADIUS) return;
    this.pointerDown = true;
    this.refreshTopie();
    this.aimStart.copy(gp);
    this.currentPull.set(0, 0, 0);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    this.audio.resume();
  }

  private onPointerMove(e: PointerEvent) {
    if (!this.pointerDown || this.state !== 'AIMING' || !this.seeds || !this.isMyTurn()) return;
    const gp = this.pointerGround(e);
    if (!gp) return;
    // pull vector = start - current (drag backward from seed direction)
    this.currentPull.subVectors(this.aimStart, gp);
    this.currentPull.y = 0;
    const pullMag = Math.min(MAX_PULL, this.currentPull.length());
    const pullT = pullMag / MAX_PULL;
    // Aim direction = OPPOSITE of drag (finger snaps forward when released)
    const aimDir = this.currentPull.clone();
    if (aimDir.lengthSq() < 1e-6) {
      this.finger.setAim(new THREE.Vector3(0, 0, 1), 0);
      return;
    }
    aimDir.normalize();
    this.finger.setAim(aimDir, pullT);

    // Let the opponent watch the finger pull back
    if (this.hooks && performance.now() - this.lastAimSent > AIM_SEND_INTERVAL) {
      this.lastAimSent = performance.now();
      this.hooks.aim(aimDir.x, aimDir.z, pullT);
    }
  }

  private onPointerUp(e: PointerEvent) {
    if (!this.pointerDown || !this.seeds) { this.pointerDown = false; return; }
    this.pointerDown = false;
    this.refreshTopie();
    if (this.state !== 'AIMING' || !this.isMyTurn()) return;

    const pullLen = this.currentPull.length();
    if (pullLen < 0.15) {
      // too weak — cancel
      this.finger.resetPull();
      this.hooks?.aim(0, 1, 0);
      return;
    }
    const pullT = Math.min(1, pullLen / MAX_PULL);
    const speed = pullT * MAX_LAUNCH_SPEED;
    const dir = this.currentPull.clone().normalize();
    const vx = dir.x * speed;
    const vz = dir.z * speed;
    this.hooks?.launch(vx, vz);
    this.launch(vx, vz);
  }

  /** Fire the current player's seed (used for both your shots and the opponent's). */
  private launch(vx: number, vz: number) {
    if (!this.seeds) return;
    const seed = this.seeds[this.currentPlayer - 1];
    const pullT = Math.min(1, Math.hypot(vx, vz) / MAX_LAUNCH_SPEED);
    seed.vel.set(vx, 0, vz);

    // audio + dust burst at launch
    this.audio.launch();
    this.dust.burst(seed.pos.x, seed.pos.z, 14, 0.8 + pullT * 0.6);
    this.scene.shake(0.08 + pullT * 0.14);

    this.finger.snap();
    // Let the flick animation play before hiding the hand
    window.setTimeout(() => { if (this.state !== 'AIMING') this.finger.hide(); }, 220);

    this.hitDuringShot = false;
    this.shotHits = 0;
    this.waitingSince = performance.now();
    this.state = 'SHOOTING';
    this.ui.setActivePlayer(this.currentPlayer, this.turnLabel());
    this.ui.setHint('BLASTING…');
    this.refreshTopie();
  }

  // ---------- Network events (online) ----------

  remoteAim(x: number, z: number, t: number) {
    if (this.mode !== 'online' || this.state !== 'AIMING' || this.isMyTurn()) return;
    const dir = new THREE.Vector3(x, 0, z);
    if (dir.lengthSq() < 1e-6) return;
    if (t <= 0) this.finger.resetPull();
    else this.finger.setAim(dir, t);
  }

  remoteLaunch(vx: number, vz: number) {
    if (this.mode !== 'online' || this.state !== 'AIMING' || this.isMyTurn()) return;
    this.launch(vx, vz);
  }

  applyServerState(msg: ServerState) {
    if (this.mode !== 'online') return;
    this.pending.push({ kind: 'state', msg });
    this.flushPending();
  }

  applyGameOver(msg: ServerGameOver) {
    if (this.mode !== 'online') return;
    this.pending.push({ kind: 'over', msg });
    this.flushPending();
  }

  /**
   * Apply server verdicts in order. If we're still animating the opponent's
   * shot locally, wait for it to settle (or give up after a few seconds) so
   * the replay isn't cut short.
   */
  private flushPending(force = false) {
    if (this.processingPending || this.pending.length === 0) return;
    const simRunning = this.state === 'SHOOTING' || this.state === 'RESOLVING';
    if (simRunning && !force) return;

    const item = this.pending.shift()!;
    this.processingPending = true;
    this.pointerDown = false;

    const next = () => {
      this.processingPending = false;
      this.flushPending();
    };

    if (item.kind === 'state') {
      const m = item.msg;
      if (m.reason === 'timeout' && this.state === 'AIMING') {
        this.finger.resetPull();
        if (this.currentPlayer === this.me) this.ui.flashBlast('TIME UP');
      }
      this.state = 'WAITING';
      this.settleSeeds(m.seeds, () => {
        this.scores = [m.scores[0], m.scores[1]];
        this.ui.setScore(this.scores[0], this.scores[1]);
        this.setDeadline(m.deadline);
        if (m.topies) this.topiesLeft = [m.topies[0], m.topies[1]];
        this.beginTurn(m.turn);
        next();
      });
    } else {
      const m = item.msg;
      this.state = 'GAME_OVER'; this.refreshTopie();
      this.finger.hide();
      this.settleSeeds(m.seeds, () => {
        this.scores = [m.scores[0], m.scores[1]];
        this.ui.setScore(this.scores[0], this.scores[1]);
        if (m.reason === 'bust') {
          this.audio.gameOverBust();
          this.scene.shake(0.6);
        } else if (m.winner === this.me) {
          this.audio.victory();
        }
        this.pending = [];
        this.processingPending = false;
        window.setTimeout(() => this.onOnlineGameOver(m), m.reason === 'bust' ? 500 : 250);
      });
    }
  }

  /** Glide seeds to the authoritative positions (instant if already there). */
  private settleSeeds(target: [number, number][], done: () => void) {
    if (!this.seeds || !target || target.length !== 2) { done(); return; }
    const to = target.map(([x, z]) => new THREE.Vector3(x, this.seeds![0].radius, z));
    const from = this.seeds.map((s) => s.pos.clone());
    for (const s of this.seeds) s.vel.set(0, 0, 0);
    const maxErr = Math.max(from[0].distanceTo(to[0]), from[1].distanceTo(to[1]));
    if (maxErr < 0.01) {
      this.seeds.forEach((s, i) => { s.pos.copy(to[i]); s.syncMesh(); });
      done();
      return;
    }
    this.tween = { from, to, t: 0, dur: Math.min(0.45, 0.15 + maxErr * 0.1), done };
  }

  // ---------- Collision handling ----------

  private handleCollision(e: CollisionEvent) {
    // Only the shooter's screen decides scoring and busts; the other screen
    // just shows the effects and gets the verdict from the server.
    const authority = this.isMyTurn();

    if (e.type === 'seed-seed') {
      // Attacking seed is the current player's
      if (!this.seeds) return;
      const attacker = this.seeds[this.currentPlayer - 1];
      const other = attacker === e.a ? e.b! : e.a;
      // Only count as hit if attacker was actually moving significantly
      const attackerSpeed = Math.hypot(attacker.vel.x, attacker.vel.z) + Math.hypot(other.vel.x, other.vel.z);
      // A stood-up seed gets knocked flat by any real contact.
      if (attackerSpeed > 0.4) {
        e.a.setStanding(false);
        e.b?.setStanding(false);
      }
      if (attackerSpeed > 0.4) {
        if (authority) {
          this.hitDuringShot = true;
          this.shotHits++;
          this.scores[this.currentPlayer - 1]++;
          this.ui.setScore(this.scores[0], this.scores[1]);
        }
        if (this.fastForwarding) return;
        this.ui.flashBlast('BLAST! +1');
        this.audio.seedHitSeed();
        this.audio.score();
        this.dust.burst(e.point.x, e.point.z, 26, 1.3);
        this.scene.shake(0.35);
        this.slowMoUntil = performance.now() + 100;
      }
    } else if (e.type === 'seed-obstacle') {
      if (authority && e.obstacle && e.obstacle.significant && e.impactSpeed > 10.5 && this.fastForwarding && Math.random() < 0.06) {
        this.triggerBlastedIntoObstacle(e.a.playerId);
        return;
      }
      if (this.fastForwarding) return;
      const power = Math.min(1, e.impactSpeed / 12);
      this.audio.seedHitObstacle();
      this.dust.burst(e.point.x, e.point.z, Math.floor(8 + power * 14), 0.5 + power * 0.8);
      this.scene.shake(0.08 + power * 0.2);

      // Rare "blasted into obstacle" — big rock, high impact.
      // The seed that CRASHED into the rock loses (its player is the loser).
      if (authority && e.obstacle && e.obstacle.significant && e.impactSpeed > 10.5 && Math.random() < 0.06) {
        this.triggerBlastedIntoObstacle(e.a.playerId);
      }
    } else if (e.type === 'seed-wall') {
      if (this.fastForwarding) return;
      const power = Math.min(1, e.impactSpeed / 12);
      this.audio.seedHitObstacle();
      this.dust.burst(e.point.x, e.point.z, Math.floor(4 + power * 8), 0.3 + power * 0.5);
      this.scene.shake(0.04 + power * 0.1);
    }
  }

  private triggerBlastedIntoObstacle(loser: Player) {
    if (this.state === 'GAME_OVER' || this.state === 'WAITING') return;
    if (this.mode === 'online') {
      // Report now; the server ends the game for both players.
      this.state = 'WAITING';
      this.waitingSince = performance.now();
      this.hooks?.shotResult(this.seedPositions(), this.shotHits, loser);
      return;
    }
    this.state = 'GAME_OVER'; this.refreshTopie();
    this.audio.gameOverBust();
    this.scene.shake(0.6);
    const winner: Player = loser === 1 ? 2 : 1;
    setTimeout(() => {
      this.ui.showGameOver(winner, this.scores[0], this.scores[1], 'BLASTED INTO THE OBSTACLE!');
    }, 500);
  }

  private seedPositions(): [number, number][] {
    if (!this.seeds) return [];
    return this.seeds.map((s) => [round4(s.pos.x), round4(s.pos.z)] as [number, number]);
  }

  // ---------- Test hook (only exposed with ?debug) ----------

  /** Snapshot used by automated tests; also handy in the browser console. */
  debugInfo() {
    const project = (x: number, z: number) => {
      const v = new THREE.Vector3(x, 0, z).project(this.scene.camera);
      const r = this.canvas.getBoundingClientRect();
      return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
    };
    return {
      state: this.state,
      mode: this.mode,
      me: this.me,
      currentPlayer: this.currentPlayer,
      scores: [...this.scores],
      seeds: this.seedPositions(),
      standing: this.seeds ? this.seeds.map((s) => s.standing) : [],
      topies: [...this.topiesLeft],
      obstacles: this.obstacles.map((o) => [round4(o.pos.x), round4(o.pos.z), o.kind]),
      project: (x: number, z: number) => project(x, z),
    };
  }

  // ---------- Loop ----------

  private startLoop() {
    const loop = () => {
      const rawDt = Math.min(0.05, this.clock.getDelta());
      const slow = performance.now() < this.slowMoUntil;
      const dt = slow ? rawDt * 0.35 : rawDt;

      if (this.tween && this.seeds) {
        const tw = this.tween;
        tw.t = Math.min(1, tw.t + rawDt / tw.dur);
        const k = 1 - (1 - tw.t) * (1 - tw.t);
        this.seeds.forEach((s, i) => { s.pos.lerpVectors(tw.from[i], tw.to[i], k); s.syncMesh(); });
        if (tw.t >= 1) { this.tween = null; tw.done(); }
      }

      if (this.state === 'SHOOTING' || this.state === 'RESOLVING') {
        this.phys.step(dt);
        if (this.seeds) {
          for (const s of this.seeds) {
            s.syncMesh();
            // dust trail for fast rolling
            const spd = Math.hypot(s.vel.x, s.vel.z);
            this.dust.trail(s.pos.x, s.pos.z, Math.min(1, spd / 8));
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
          this.frameBothSeeds();
        }

        // Check if all resting
        if (this.phys.allSeedsResting()) {
          if (this.state === 'SHOOTING') this.state = 'RESOLVING';
          // small delay then finalize
          this.finalizeTurnSoon();
        }
      } else if (this.state === 'AIMING' && this.seeds) {
        // idle: seeds shouldn't move, but keep meshes synced
        if (!this.tween) for (const s of this.seeds) s.syncMesh();
        if (this.mode === 'online') {
          const label = this.turnLabel();
          if (label !== this.lastTurnLabel) {
            this.lastTurnLabel = label;
            this.ui.setActivePlayer(this.currentPlayer, label);
          }
        }
      } else if (this.state === 'WAITING') {
        // Safety net: if the opponent's replay never settles, apply anyway.
        if (this.pending.length && !this.processingPending) this.flushPending(true);
      }

      // If a verdict arrived while the local replay was still rolling,
      // and the replay is taking unusually long, apply it anyway.
      if ((this.state === 'SHOOTING' || this.state === 'RESOLVING') && this.pending.length &&
          !this.processingPending && performance.now() - this.waitingSince > 6000) {
        this.flushPending(true);
      }

      // Ambient dust drifting through the arena
      this.ambientDustAccum += rawDt;
      if (this.ambientDustAccum > 0.35) {
        this.ambientDustAccum = 0;
        this.dust.ambient(1, ARENA_RADIUS);
      }

      if (this.seeds) for (const s of this.seeds) s.updateStand(rawDt);
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

      if (this.mode === 'online') {
        this.state = 'WAITING';
        this.waitingSince = performance.now();
        if (this.isMyTurn()) {
          // We were the shooter: report where everything stopped.
          this.hooks?.shotResult(this.seedPositions(), this.shotHits, null);
        } else {
          this.ui.setHint('…');
        }
        this.flushPending();
        return;
      }

      // check victory
      if (this.scores[0] >= WIN_SCORE) {
        this.state = 'GAME_OVER'; this.refreshTopie();
        this.audio.victory();
        this.ui.showGameOver(1, this.scores[0], this.scores[1]);
        return;
      }
      if (this.scores[1] >= WIN_SCORE) {
        this.state = 'GAME_OVER'; this.refreshTopie();
        this.audio.victory();
        this.ui.showGameOver(2, this.scores[0], this.scores[1]);
        return;
      }
      this.endTurnLocal();
    }, 400);
  }
}

function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}
