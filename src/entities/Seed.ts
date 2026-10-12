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
    // Rotate based on velocity (rolling)
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (speed > 0.01) {
      const axis = new THREE.Vector3(-this.vel.z, 0, this.vel.x).normalize();
      const angle = (speed / this.radius) * 0.016; // per-frame guess; harmless
      this.body.rotateOnWorldAxis(axis, angle);
    }
  }

  isMoving(threshold = 0.12): boolean {
    return Math.hypot(this.vel.x, this.vel.z) > threshold;
  }
}
