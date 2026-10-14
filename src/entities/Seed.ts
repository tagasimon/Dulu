import * as THREE from 'three';

export const SEED_RADIUS = 0.14;

export class Seed {
  mesh: THREE.Group;
  body: THREE.Mesh;
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  radius = SEED_RADIUS;
  angularVel = new THREE.Vector3();
  playerId: 1 | 2;

  /** Extra hit radius while stood up with "Topie" (physics reads this). */
  hitBonus = 0;
  /** 0 = lying flat, 1 = standing on its edge like a coin. */
  private standT = 0;
  private standTarget = 0;
  /** Orientation from rolling; the displayed orientation blends to "standing". */
  private rollQuat = new THREE.Quaternion();
  private static UPRIGHT = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2));
  private tmpQ = new THREE.Quaternion();
  private ring!: THREE.Mesh;

  constructor(playerId: 1 | 2) {
    this.playerId = playerId;
    this.mesh = new THREE.Group();

    // Slightly irregular ellipsoid, procedurally distorted
    const geo = new THREE.IcosahedronGeometry(SEED_RADIUS, 3);
    const pos = geo.attributes.position;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i);
      const stretch = 1.15 + Math.sin(tmp.x * 5) * 0.05;
      tmp.y *= 0.78;
      tmp.x *= stretch;
      // slight surface roughness
      const noise = (Math.sin(tmp.x * 22) + Math.cos(tmp.y * 24) + Math.sin(tmp.z * 21)) * 0.006;
      tmp.multiplyScalar(1 + noise);
      pos.setXYZ(i, tmp.x, tmp.y, tmp.z);
    }
    geo.computeVertexNormals();

    // Colors: P1 = pale cream seed with darker eye, P2 = darker reddish-brown
    const isP1 = playerId === 1;
    const mat = new THREE.MeshStandardMaterial({
      color: isP1 ? 0xd8b477 : 0x7a3b1c,
      roughness: 0.55,
      metalness: 0.05,
    });

    this.body = new THREE.Mesh(geo, mat);
    this.body.castShadow = true;
    this.body.receiveShadow = false;
    this.mesh.add(this.body);

    // Ground ring indicator so a marble-sized seed stays findable
    const ringMat = new THREE.MeshBasicMaterial({
      color: isP1 ? 0xffd28a : 0xff9060,
      transparent: true,
      opacity: 0.55,
    });
    const ringGeo = new THREE.RingGeometry(SEED_RADIUS * 2.0, SEED_RADIUS * 2.6, 32);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring = ring;
    ring.position.y = -SEED_RADIUS + 0.005;
    this.mesh.add(ring);

    // "eye" spot on seed to give plant-seed look
    const eyeGeo = new THREE.CircleGeometry(SEED_RADIUS * 0.35, 20);
    const eyeMat = new THREE.MeshStandardMaterial({
      color: isP1 ? 0x8a5a30 : 0x2a0f04,
      roughness: 0.7,
      side: THREE.DoubleSide,
    });
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(SEED_RADIUS * 0.9, 0, 0);
    eye.rotation.y = Math.PI / 2;
    eye.scale.set(1, 0.7, 1);
    this.body.add(eye);

    // slight secondary shading band
    const bandMat = new THREE.MeshStandardMaterial({
      color: isP1 ? 0xa07a48 : 0x4a1e0a,
      roughness: 0.9,
      transparent: true,
      opacity: 0.5,
    });
    const band = new THREE.Mesh(new THREE.TorusGeometry(SEED_RADIUS * 1.02, 0.02, 8, 24), bandMat);
    band.rotation.x = Math.PI / 2;
    this.body.add(band);
  }

  setPosition(x: number, z: number) {
    this.pos.set(x, this.radius, z);
    this.mesh.position.copy(this.pos);
  }

  syncMesh() {
    this.mesh.position.copy(this.pos);
    // Rotate based on velocity (rolling) — only while lying down
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (speed > 0.01 && this.standT < 0.05) {
      const axis = new THREE.Vector3(-this.vel.z, 0, this.vel.x).normalize();
      const angle = (speed / this.radius) * 0.016; // per-frame guess; harmless
      this.tmpQ.setFromAxisAngle(axis, angle);
      this.rollQuat.premultiply(this.tmpQ);
    }
    this.applyPose();
  }

  /**
   * "Topie": stand the seed on its edge (tallest way up) so it's a bigger,
   * more visible target. It falls flat again when hit or when the turn ends.
   */
  setStanding(on: boolean) {
    this.standTarget = on ? 1 : 0;
    this.hitBonus = on ? SEED_RADIUS * 0.55 : 0;
  }

  get standing() { return this.standTarget > 0; }

  /** Animate standing up / toppling. Call every frame. */
  updateStand(dt: number) {
    if (Math.abs(this.standT - this.standTarget) < 0.001) return;
    // Standing up is a quick flick; falling over is a little slower.
    const rate = this.standTarget > this.standT ? 9 : 6;
    this.standT += (this.standTarget - this.standT) * Math.min(1, dt * rate);
    if (Math.abs(this.standT - this.standTarget) < 0.002) this.standT = this.standTarget;
    this.applyPose();
  }

  private applyPose() {
    const t = this.standT;
    const e = t * t * (3 - 2 * t); // smoothstep
    this.body.quaternion.copy(this.rollQuat).slerp(Seed.UPRIGHT, e);
    // Lift so it rests on its edge instead of sinking into the dirt, with a
    // tiny wobble at the top of the stand-up.
    this.body.position.y = e * SEED_RADIUS * 0.42 + Math.sin(e * Math.PI) * 0.03;
    // Brighter, bigger ground ring while standing so it's easy to spot.
    if (this.ring) {
      this.ring.scale.setScalar(1 + e * 0.45);
      (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.55 + e * 0.4;
    }
  }

  isMoving(threshold = 0.12): boolean {
    return Math.hypot(this.vel.x, this.vel.z) > threshold;
  }
}
