import * as THREE from 'three';
import type { Seed } from './Seed';

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
  private finger: THREE.Mesh;
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
    const skin = new THREE.MeshStandardMaterial({ color: 0x8a5a3a, roughness: 0.75 });
    const skinDark = new THREE.MeshStandardMaterial({ color: 0x6a4028, roughness: 0.85 });
    const nailMat = new THREE.MeshStandardMaterial({ color: 0xf5dcb8, roughness: 0.55 });

    // ---------- BASE HAND — palm DOWN, fingers extended forward ----------
    // Palm: flat oval on ground
    const palmGeo = new THREE.SphereGeometry(0.22, 20, 14);
    scaleGeo(palmGeo, 1.15, 0.42, 1.05); // flatten strongly in Y
    const palm = new THREE.Mesh(palmGeo, skin);
    palm.position.set(0, 0.06, -0.05);
    palm.castShadow = true;
    this.base.add(palm);

    // Wrist trailing back
    const wrist = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.10, 0.38, 14),
      skinDark
    );
    wrist.rotation.x = -Math.PI / 2;
    wrist.position.set(0, 0.05, -0.36);
    wrist.castShadow = true;
    this.base.add(wrist);

    // Extended flat fingers (index, ring, pinky) — capsules lying along ground pointing +Z
    const otherFingers: { x: number; len: number; scale: number }[] = [
      { x: -0.12, len: 0.42, scale: 1.0 },   // index
      { x:  0.12, len: 0.44, scale: 0.98 },  // ring
      { x:  0.21, len: 0.38, scale: 0.9 },   // pinky
    ];
    for (const f of otherFingers) {
      const cap = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.058 * f.scale, f.len - 0.12, 4, 12),
        skin
      );
      // orient along +Z (forward)
      cap.rotation.x = Math.PI / 2;
      cap.position.set(f.x, 0.055, 0.10 + f.len / 2);
      cap.castShadow = true;
      this.base.add(cap);
      // fingernail
      const nail = new THREE.Mesh(
        new THREE.SphereGeometry(0.055 * f.scale, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        nailMat
      );
      nail.rotation.x = -Math.PI / 2;
      nail.position.set(f.x, 0.078, 0.10 + f.len);
      this.base.add(nail);
    }

    // Thumb: pointing sideways along ground (out from palm side)
    const thumb = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.062, 0.20, 4, 12),
      skin
    );
    thumb.rotation.z = Math.PI / 2;    // lay along X
    thumb.rotation.y = -0.35;          // angle slightly forward
    thumb.position.set(-0.22, 0.06, 0.02);
    thumb.castShadow = true;
    this.base.add(thumb);

    // ---------- MIDDLE FINGER (the launcher) ----------
    // Pivot at knuckle (front edge of palm). At rest, finger extends forward along ground.
    this.fingerPivot.position.set(0, 0.055, 0.14);
    this.base.add(this.fingerPivot);

    // Knuckle bump
    const knuckle = new THREE.Mesh(new THREE.SphereGeometry(0.10, 14, 10), skin);
    this.fingerPivot.add(knuckle);
    knuckle.castShadow = true;

    // Finger capsule, pivot at base
    const fingerLen = FingerLauncher.FINGER_LEN;
    const fingerGeo = new THREE.CapsuleGeometry(0.082, fingerLen - 0.17, 6, 14);
    fingerGeo.translate(0, fingerLen / 2, 0); // pivot at origin end
    this.finger = new THREE.Mesh(fingerGeo, skin);
    this.finger.castShadow = true;
    // Rest orientation: finger flat on ground pointing +Z
    this.finger.rotation.x = Math.PI / 2;
    this.fingerPivot.add(this.finger);

    // Tip anchor: follows fingertip
    this.tipAnchor.position.set(0, fingerLen, 0);
    this.finger.add(this.tipAnchor);

    // Fingernail at tip
    const nailTip = new THREE.Mesh(
      new THREE.SphereGeometry(0.088, 12, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      nailMat
    );
    nailTip.rotation.x = -Math.PI / 2;
    nailTip.position.set(0, 0.015, 0);
    this.tipAnchor.add(nailTip);

    // ---------- PULLER HAND — reaches DOWN from above, pinches tip ----------
    this.puller = new THREE.Group();

    // Pinching hand: small palm oriented so open side faces the fingertip (i.e., down).
    // We build with local -Y as "down toward tip", +Y as "up-back toward puller's forearm".
    const pPalmGeo = new THREE.SphereGeometry(0.20, 18, 12);
    scaleGeo(pPalmGeo, 1.0, 0.6, 1.0);
    const pPalm = new THREE.Mesh(pPalmGeo, skin);
    pPalm.position.set(0, 0.14, -0.02); // palm sits above the grip
    pPalm.castShadow = true;
    this.puller.add(pPalm);

    // Thumb of pincher curling down toward tip (in local -Y direction)
    const pThumb = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.055, 0.18, 4, 10),
      skin
    );
    pThumb.rotation.x = 0.5; // tilt fingertip-ward
    pThumb.position.set(-0.10, 0.02, 0.10);
    pThumb.castShadow = true;
    this.puller.add(pThumb);

    // Index finger of pincher (opposing thumb)
    const pIndex = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.055, 0.20, 4, 10),
      skin
    );
    pIndex.rotation.x = -0.5;
    pIndex.position.set(0.09, 0.02, -0.02);
    pIndex.castShadow = true;
    this.puller.add(pIndex);

    // Two curled remaining fingers (bumps)
    for (let i = 0; i < 2; i++) {
      const bump = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), skinDark);
      bump.position.set(0.14 + i * 0.06, 0.10, -0.05);
      bump.castShadow = true;
      this.puller.add(bump);
    }

    // Forearm going up-back from puller
    const pWrist = new THREE.Mesh(
      new THREE.CylinderGeometry(0.10, 0.09, 0.55, 12),
      skinDark
    );
    pWrist.position.set(0, 0.42, -0.10);
    pWrist.rotation.x = 0.35; // tilts back
    pWrist.castShadow = true;
    this.puller.add(pWrist);

    // Attach puller at the tip; we'll position/orient in update
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
