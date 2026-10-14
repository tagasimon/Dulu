import * as THREE from 'three';
import type { Seed } from './Seed';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * Real Dulu mechanic:
 *  - Base hand: palm DOWN on ground, middle finger extended forward, seed
 *    rests on the upper half of the middle finger.
 *  - Puller hand: reaches down FROM ABOVE, pinches the fingertip, and lifts
 *    the tip UP-and-BACK during aim.
 *  - Release: middle finger snaps forward-and-down, sweeping through the
 *    seed's position and launching it toward the target.
 */
export class FingerLauncher {
  group = new THREE.Group();
  private base = new THREE.Group();
  private fingerPivot = new THREE.Group();
  private finger = new THREE.Group();
  /** middle-finger joints (proximal → distal) for a natural bend while pulled/flicked */
  private fingerJoints: THREE.Group[] = [];
  private tipAnchor = new THREE.Group();
  private puller: THREE.Group;
  private aimArrow: THREE.Mesh;
  private trajGroup = new THREE.Group();
  private trajDots: THREE.Mesh[] = [];
  private bendAmount = 0;
  private targetBend = 0;
  private pullerVisibility = 0;
  private targetPullerVisibility = 0;
  private snapTime = -1;
  aimDir = new THREE.Vector3(0, 0, 1);
  visible = false;

  private static FINGER_LEN = 0.55;
  private static HAND_SCALE = 2.4;
  private static HAND_LIFT = 0.04; // palm sits just above dirt

  constructor() {
    // Warm brown skin with a soft sheen; slightly darker on the back of the
    // hand and knuckles, lighter nails. MeshPhysical gives a skin-like sheen.
    const skin = new THREE.MeshPhysicalMaterial({
      color: 0x7a4a2c, roughness: 0.58, sheen: 0.6, sheenRoughness: 0.5,
      sheenColor: new THREE.Color(0xc98a5e), clearcoat: 0.08, clearcoatRoughness: 0.6,
    });
    const skinShade = new THREE.MeshPhysicalMaterial({
      color: 0x5e361f, roughness: 0.66, sheen: 0.4, sheenColor: new THREE.Color(0xa86a44),
    });
    const crease = new THREE.MeshStandardMaterial({ color: 0x5a3420, roughness: 0.9 });
    const nailMat = new THREE.MeshPhysicalMaterial({
      color: 0xd8b49a, roughness: 0.32, clearcoat: 0.7, clearcoatRoughness: 0.25,
    });

    // ---------- BASE HAND — palm DOWN, fingers forward (+Z), back of hand up ----------
    // Back of hand: rounded, slightly domed slab, wider at the knuckles.
    const palmGeo = new RoundedBoxGeometry(0.40, 0.12, 0.36, 4, 0.055);
    taper(palmGeo, 0.86, 1.0, 'z');       // narrower toward the wrist
    dome(palmGeo, 0.025);                  // back of the hand is gently curved
    const palm = new THREE.Mesh(palmGeo, skin);
    palm.position.set(0.01, 0.062, -0.04);
    palm.castShadow = true;
    palm.receiveShadow = true;
    this.base.add(palm);

    // Faint tendons running from wrist to each knuckle
    for (const x of [-0.11, -0.035, 0.04, 0.11]) {
      const t = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, 0.22, 3, 6), skin);
      t.rotation.x = Math.PI / 2;
      t.rotation.y = x * 0.35;
      t.position.set(x * 0.9, 0.118, -0.06);
      this.base.add(t);
    }

    // Wrist + forearm trailing back and slightly up off the ground
    const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.105, 0.75, 18, 1), skin);
    forearm.geometry.translate(0, -0.375, 0);
    scaleGeo(forearm.geometry, 1.15, 1, 0.8);
    forearm.rotation.x = Math.PI / 2 + 0.12;
    forearm.position.set(0.01, 0.07, -0.20);
    forearm.castShadow = true;
    this.base.add(forearm);
    const wristBone = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), skinShade);
    wristBone.position.set(0.13, 0.085, -0.24);
    this.base.add(wristBone);

    // Index, ring, little finger: three jointed segments lying forward, tips
    // curling down to touch the dirt.
    const restFingers = [
      { x: -0.135, lens: [0.19, 0.12, 0.10], r: 0.047, yaw: -0.06 },  // index
      { x: 0.105, lens: [0.19, 0.125, 0.10], r: 0.045, yaw: 0.05 },   // ring
      { x: 0.185, lens: [0.15, 0.10, 0.085], r: 0.039, yaw: 0.14 },   // little
    ];
    for (const f of restFingers) {
      const fin = makeFinger(skin, nailMat, crease, f.lens, f.r);
      fin.root.rotation.set(Math.PI / 2, 0, 0);
      fin.root.rotation.y = f.yaw;
      fin.root.position.set(f.x, 0.06, 0.13);
      fin.joints[0].rotation.x = 0.05;
      fin.joints[1].rotation.x = 0.16;
      fin.joints[2].rotation.x = 0.14;
      this.base.add(fin.root);
      // knuckle bump
      const k = new THREE.Mesh(new THREE.SphereGeometry(f.r * 1.15, 12, 8), skin);
      k.scale.set(1, 0.8, 1);
      k.position.set(f.x, 0.095, 0.12);
      this.base.add(k);
    }

    // Thumb: two segments sweeping out to the side and forward along the dirt
    const thumb = makeFinger(skin, nailMat, crease, [0.13, 0.11], 0.05);
    thumb.root.position.set(-0.19, 0.055, -0.06);
    thumb.root.rotation.set(Math.PI / 2, 0, 0);
    thumb.root.rotation.y = -0.85;
    thumb.joints[1].rotation.x = 0.15;
    thumb.joints[0].rotation.z = 0.2;
    this.base.add(thumb.root);
    const thenar = new THREE.Mesh(new THREE.SphereGeometry(0.085, 14, 10), skin);
    thenar.scale.set(1.1, 0.6, 1.3);
    thenar.position.set(-0.17, 0.06, -0.08);
    thenar.castShadow = true;
    this.base.add(thenar);

    // ---------- MIDDLE FINGER (the launcher) ----------
    // Pivot at the knuckle. At rest the finger lies forward along the ground.
    this.fingerPivot.position.set(-0.015, 0.062, 0.13);
    this.base.add(this.fingerPivot);
    const knuckle = new THREE.Mesh(new THREE.SphereGeometry(0.062, 14, 10), skin);
    knuckle.scale.set(1, 0.85, 1);
    knuckle.position.y = 0.025;
    knuckle.castShadow = true;
    this.fingerPivot.add(knuckle);

    // Three phalanges adding up to FINGER_LEN, built along +Y from the pivot.
    const L = FingerLauncher.FINGER_LEN;
    const mid = makeFinger(skin, nailMat, crease, [L * 0.44, L * 0.31, L * 0.25], 0.056);
    this.finger.add(mid.root);
    this.fingerJoints = mid.joints;
    // Rest orientation: flat on ground pointing +Z
    this.finger.rotation.x = Math.PI / 2;
    this.fingerPivot.add(this.finger);

    // Tip anchor: follows the fingertip (end of the last phalanx)
    mid.tip.add(this.tipAnchor);

    // ---------- PULLER HAND — reaches down from above and pinches the tip ----------
    // Built in the tip's frame: local +Y points away from the fingertip (up/back
    // toward the puller's forearm); the pinch is at the origin.
    this.puller = new THREE.Group();

    const pPalmGeo = new RoundedBoxGeometry(0.30, 0.11, 0.26, 4, 0.05);
    dome(pPalmGeo, 0.02);
    const pPalm = new THREE.Mesh(pPalmGeo, skin);
    pPalm.position.set(0.04, 0.30, 0.0);
    pPalm.rotation.set(0.25, 0, -0.15);
    pPalm.castShadow = true;
    this.puller.add(pPalm);

    // Index finger and thumb come down and meet at the fingertip.
    const pIndex = makeFinger(skin, nailMat, crease, [0.13, 0.09, 0.075], 0.042);
    pIndex.root.position.set(0.075, 0.26, 0.02);
    pIndex.root.rotation.set(0, 0, Math.PI - 0.22);
    pIndex.joints[1].rotation.x = 0.35;
    pIndex.joints[2].rotation.x = 0.3;
    this.puller.add(pIndex.root);

    const pThumb = makeFinger(skin, nailMat, crease, [0.12, 0.10], 0.048);
    pThumb.root.position.set(-0.10, 0.22, 0.03);
    pThumb.root.rotation.set(0, 0, -(Math.PI - 0.42));
    pThumb.joints[1].rotation.x = -0.25;
    this.puller.add(pThumb.root);

    // The other three fingers curled into the palm (loose fist)
    [0.04, 0.115, 0.18].forEach((x, i) => {
      const cf = makeFinger(skin, nailMat, crease, [0.10, 0.075, 0.06], 0.04 - i * 0.003);
      cf.root.position.set(x, 0.27, -0.06);
      cf.root.rotation.set(0.2, 0, Math.PI - 0.05);
      cf.joints[0].rotation.x = 0.9;
      cf.joints[1].rotation.x = 1.25;
      cf.joints[2].rotation.x = 0.9;
      this.puller.add(cf.root);
    });

    // Forearm rising up-and-back out of view
    const pArm = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.13, 0.85, 16), skin);
    pArm.geometry.translate(0, 0.425, 0);
    scaleGeo(pArm.geometry, 1.1, 1, 0.85);
    pArm.position.set(0.03, 0.33, -0.02);
    pArm.rotation.set(-0.35, 0, -0.1);
    pArm.castShadow = true;
    this.puller.add(pArm);

    this.tipAnchor.add(this.puller);
    this.puller.visible = false;

    // ---------- Assemble base ----------
    this.base.scale.setScalar(FingerLauncher.HAND_SCALE);
    this.base.position.y = FingerLauncher.HAND_LIFT;
    this.group.add(this.base);

    // Soft ground shadow disc under hand
    const shadowGeo = new THREE.CircleGeometry(0.7, 24);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false,
    });
    const groundShadow = new THREE.Mesh(shadowGeo, shadowMat);
    groundShadow.position.y = 0.008;
    // Elongate shadow toward wrist (behind hand)
    groundShadow.scale.set(1.0, 1.0, 1.35);
    groundShadow.position.z = -0.15;
    this.group.add(groundShadow);

    // ---------- Aim arrow ----------
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, 0);
    arrowShape.lineTo(0.20, -0.42);
    arrowShape.lineTo(0, -0.30);
    arrowShape.lineTo(-0.20, -0.42);
    arrowShape.lineTo(0, 0);
    const arrowGeo = new THREE.ShapeGeometry(arrowShape);
    arrowGeo.rotateX(-Math.PI / 2);
    this.aimArrow = new THREE.Mesh(
      arrowGeo,
      new THREE.MeshBasicMaterial({ color: 0xffb056, transparent: true, opacity: 0.85 })
    );
    this.aimArrow.position.y = 0.02;
    this.group.add(this.aimArrow);

    // Trajectory dots
    const dotGeo = new THREE.CircleGeometry(0.07, 12);
    dotGeo.rotateX(-Math.PI / 2);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xffd090, transparent: true, opacity: 0.7 });
    for (let i = 0; i < 8; i++) {
      const dot = new THREE.Mesh(dotGeo, dotMat.clone());
      dot.position.y = 0.015;
      this.trajGroup.add(dot);
      this.trajDots.push(dot);
    }
    this.group.add(this.trajGroup);

    this.group.visible = false;
  }

  getTipWorldPosition(target: THREE.Vector3): THREE.Vector3 {
    this.tipAnchor.updateWorldMatrix(true, false);
    return target.setFromMatrixPosition(this.tipAnchor.matrixWorld);
  }

  show(seed: Seed) {
    this.visible = true;
    this.group.visible = true;
    this.group.position.copy(seed.pos);
    this.group.position.y = 0;
    const away = seed.pos.clone().multiplyScalar(-1);
    if (away.lengthSq() < 0.01) away.set(0, 0, 1);
    away.y = 0;
    away.normalize();
    this.snapTime = -1;
    this.setAim(away, 0);
  }

  hide() {
    this.visible = false;
    this.group.visible = false;
    this.bendAmount = 0;
    this.targetBend = 0;
    this.finger.rotation.x = Math.PI / 2;
    this.targetPullerVisibility = 0;
    this.pullerVisibility = 0;
    this.puller.visible = false;
    this.snapTime = -1;
  }

  setAim(dir: THREE.Vector3, pullT: number) {
    this.aimDir.set(dir.x, 0, dir.z).normalize();
    this.targetBend = Math.min(1, Math.max(0, pullT));

    const yaw = Math.atan2(this.aimDir.x, this.aimDir.z);
    this.base.rotation.y = yaw;

    // Position base so the fingertip's XZ projection lands on the seed
    const fingerReach = (FingerLauncher.FINGER_LEN + 0.14) * FingerLauncher.HAND_SCALE * 0.82;
    this.base.position.x = -this.aimDir.x * fingerReach;
    this.base.position.z = -this.aimDir.z * fingerReach;

    this.targetPullerVisibility = pullT > 0.02 ? 1 : 0;

    // Arrow
    this.aimArrow.rotation.y = yaw;
    const arrowDist = 1.1 + pullT * 1.0;
    this.aimArrow.position.x = this.aimDir.x * arrowDist;
    this.aimArrow.position.z = this.aimDir.z * arrowDist;
    this.aimArrow.scale.setScalar(0.85 + pullT);
    (this.aimArrow.material as THREE.MeshBasicMaterial).opacity = 0.5 + pullT * 0.4;

    // Trajectory dots
    for (let i = 0; i < this.trajDots.length; i++) {
      const d = 1.3 + i * (0.42 + pullT * 0.35);
      const dot = this.trajDots[i];
      dot.position.x = this.aimDir.x * d;
      dot.position.z = this.aimDir.z * d;
      (dot.material as THREE.MeshBasicMaterial).opacity = (0.6 - i * 0.06) * (0.5 + pullT * 0.5);
      dot.visible = pullT > 0.02;
    }
  }

  snap() {
    this.snapTime = 0;
    this.targetPullerVisibility = 0;
  }

  resetPull() {
    this.targetBend = 0;
    this.targetPullerVisibility = 0;
  }

  update(dt: number) {
    if (this.snapTime >= 0) {
      this.snapTime += dt;
      const t = this.snapTime;
      let target: number;
      if (t < 0.05) {
        target = Math.max(this.bendAmount, 1.15);       // anticipation: extra pull-back
      } else if (t < 0.18) {
        const k = (t - 0.05) / 0.13;
        target = lerp(1.15, -0.35, easeInCubic(k));     // sweep DOWN through arc past horizontal
      } else if (t < 0.32) {
        const k = (t - 0.18) / 0.14;
        target = lerp(-0.35, 0, easeOutQuad(k));         // settle back to flat
      } else {
        target = 0;
      }
      this.bendAmount += (target - this.bendAmount) * Math.min(1, dt * 44);
    } else {
      this.bendAmount += (this.targetBend - this.bendAmount) * Math.min(1, dt * 26);
    }

    // Positive bendAmount → tip up-and-back (angle < PI/2). Negative → tip past horizontal, "follow through" slightly into ground.
    const maxBackAngle = 1.55;
    const angle = Math.PI / 2 - this.bendAmount * maxBackAngle;
    this.finger.rotation.x = angle;
    // Natural joint flex: pulled back, the finger arches backwards; on the
    // follow-through it curls a little; at rest the tip droops to the dirt.
    const b = this.bendAmount;
    const [j0, j1, j2] = this.fingerJoints;
    if (j0 && j1 && j2) {
      j0.rotation.x = b > 0 ? -0.10 * b : -0.25 * b;
      j1.rotation.x = b > 0 ? 0.10 - 0.32 * b : 0.10 - 0.5 * b;
      j2.rotation.x = b > 0 ? 0.08 - 0.22 * b : 0.08 - 0.35 * b;
    }

    // Puller fades
    this.pullerVisibility += (this.targetPullerVisibility - this.pullerVisibility) * Math.min(1, dt * 22);
    this.puller.visible = this.pullerVisibility > 0.02;
    // Puller sits along the finger's tip-outward direction (tipAnchor local +Y).
    // At full pull the tip points nearly straight up → puller is above tip.
    const pullOffset = 0.10 + Math.max(0, this.bendAmount) * 0.35;
    this.puller.position.set(0, pullOffset, 0);
    this.puller.scale.setScalar(0.65 + this.pullerVisibility * 0.55);
  }
}

/**
 * A finger as a chain of tapered phalanges along local +Y with a joint group at
 * each knuckle (rotate joints[i].rotation.x to curl), skin creases at the
 * joints, and a nail on the back (local -Z) of the last segment.
 */
function makeFinger(
  skin: THREE.Material, nailMat: THREE.Material, creaseMat: THREE.Material,
  lengths: number[], radius: number,
) {
  const root = new THREE.Group();
  const joints: THREE.Group[] = [];
  let parent: THREE.Object3D = root;
  let r = radius;
  let offset = 0;
  lengths.forEach((len, i) => {
    const joint = new THREE.Group();
    joint.position.y = offset;
    parent.add(joint);
    const r2 = r * 0.9; // taper along each segment
    const geo = new THREE.CylinderGeometry(r2, r, Math.max(0.001, len - r * 0.4), 14, 1, true);
    geo.translate(0, len / 2, 0);
    scaleGeo(geo, 1.08, 1, 0.9); // fingers are a bit wider than tall
    const seg = new THREE.Mesh(geo, skin);
    seg.castShadow = true;
    joint.add(seg);
    // rounded knuckle at the base of each segment
    const ball = new THREE.Mesh(new THREE.SphereGeometry(r * 1.02, 14, 10), skin);
    ball.scale.set(1.08, 1, 0.92);
    ball.castShadow = true;
    joint.add(ball);
    if (i > 0) {
      // skin crease on the back of the joint
      const c = new THREE.Mesh(new THREE.TorusGeometry(r * 0.99, r * 0.045, 4, 12, Math.PI * 0.6), creaseMat);
      c.rotation.set(Math.PI / 2, Math.PI, Math.PI * 0.1);
      c.position.y = 0.002;
      joint.add(c);
    }
    if (i === lengths.length - 1) {
      // rounded tip
      const tipBall = new THREE.Mesh(new THREE.SphereGeometry(r2 * 1.0, 14, 10), skin);
      tipBall.scale.set(1.08, 1.1, 0.9);
      tipBall.position.y = len - r * 0.2;
      tipBall.castShadow = true;
      joint.add(tipBall);
      // nail on the back of the last segment
      const nail = new THREE.Mesh(new THREE.SphereGeometry(r2 * 0.95, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), nailMat);
      nail.scale.set(0.95, 1.55, 0.35);
      nail.rotation.x = -Math.PI / 2;
      nail.position.set(0, len * 0.66, -r2 * 0.78);
      joint.add(nail);
    }
    joints.push(joint);
    parent = joint;
    offset = len - r * 0.2;
    r = r2;
  });
  const tip = new THREE.Group();
  tip.position.y = offset + r * 0.2;
  parent.add(tip);
  return { root, joints, tip };
}

/** Narrow a geometry along an axis (0 = far end scale, 1 = near end). */
function taper(g: THREE.BufferGeometry, back: number, front: number, axis: 'z') {
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getZ(i) - bb.min.z) / (bb.max.z - bb.min.z);
    const k = back + (front - back) * t;
    pos.setX(i, pos.getX(i) * k);
  }
  g.computeVertexNormals();
}

/** Push the top surface up in the middle (domed back of the hand). */
function dome(g: THREE.BufferGeometry, amount: number) {
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const hx = (bb.max.x - bb.min.x) / 2, hz = (bb.max.z - bb.min.z) / 2;
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) <= 0) continue;
    const nx = pos.getX(i) / hx, nz = pos.getZ(i) / hz;
    pos.setY(i, pos.getY(i) + amount * Math.max(0, 1 - nx * nx) * Math.max(0, 1 - nz * nz));
  }
  g.computeVertexNormals();
}

function scaleGeo(g: THREE.BufferGeometry, sx: number, sy: number, sz: number) {
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, pos.getX(i) * sx, pos.getY(i) * sy, pos.getZ(i) * sz);
  }
  g.computeVertexNormals();
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function easeInCubic(t: number) { return t * t * t; }
function easeOutQuad(t: number) { return 1 - (1 - t) * (1 - t); }
