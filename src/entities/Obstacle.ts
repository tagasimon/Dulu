import * as THREE from 'three';
import { mulberry32, type ObstacleSpec, type ObstacleKind } from '../../shared/arena';

export type { ObstacleKind };

export class Obstacle {
  mesh: THREE.Object3D;
  pos = new THREE.Vector3();
  radius: number; // collision radius (XZ)
  height: number;
  kind: ObstacleKind;
  restitution: number;
  significant: boolean; // large enough to cause "blasted into obstacle" end

  /**
   * Built from a layout spec (see shared/arena.js). Position, kind and collision
   * radius come from the spec so every player gets identical physics; the
   * visual shape is seeded from spec.shapeSeed.
   */
  constructor(spec: ObstacleSpec) {
    const { kind, x, z } = spec;
    const rng = mulberry32(spec.shapeSeed);
    this.kind = kind;
    this.pos.set(x, 0, z);

    if (kind === 'boulder') {
      // Big weathered boulder: two merged lumps, partly sunk into the dirt.
      this.radius = spec.radius;
      this.height = this.radius * 1.2;
      this.restitution = 0.6;
      this.significant = true;
      const group = new THREE.Group();
      const m = new THREE.MeshStandardMaterial({ color: 0x55382a, roughness: 0.97, flatShading: true });
      const g1 = new THREE.DodecahedronGeometry(this.radius, 1);
      distort(g1, 0.22, rng);
      const main = new THREE.Mesh(g1, m);
      main.scale.y = 0.75;
      main.position.y = this.radius * 0.45;
      const g2 = new THREE.DodecahedronGeometry(this.radius * 0.55, 0);
      distort(g2, 0.2, rng);
      const side = new THREE.Mesh(g2, new THREE.MeshStandardMaterial({ color: 0x4a3022, roughness: 1, flatShading: true }));
      const a = rng() * Math.PI * 2;
      side.position.set(Math.cos(a) * this.radius * 0.6, this.radius * 0.25, Math.sin(a) * this.radius * 0.6);
      for (const mesh of [main, side]) { mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); }
      group.position.set(x, 0, z);
      group.rotation.y = rng() * Math.PI;
      this.mesh = group;
    } else if (kind === 'hole') {
      // A dug hole: dark pit with a lighter crumbly rim. Not solid — seeds
      // that roll in slow down and slide toward the middle (see PhysicsWorld).
      this.radius = spec.radius;
      this.height = 0;
      this.restitution = 0;
      this.significant = false;
      const group = new THREE.Group();
      const rim = new THREE.Mesh(
        new THREE.RingGeometry(this.radius * 0.92, this.radius * 1.18, 28, 1),
        new THREE.MeshStandardMaterial({ color: 0x8a5232, roughness: 1, transparent: true, opacity: 0.9 }),
      );
      rim.rotation.x = -Math.PI / 2;
      rim.position.y = 0.006;
      // irregular rim
      const rp = rim.geometry.attributes.position;
      for (let i = 0; i < rp.count; i++) {
        const k = 1 + (rng() - 0.5) * 0.12;
        rp.setXY(i, rp.getX(i) * k, rp.getY(i) * k);
      }
      const pit = new THREE.Mesh(
        new THREE.CircleGeometry(this.radius * 0.95, 28),
        new THREE.MeshStandardMaterial({ color: 0x1c0d06, roughness: 1 }),
      );
      pit.rotation.x = -Math.PI / 2;
      pit.position.y = 0.008;
      const core = new THREE.Mesh(
        new THREE.CircleGeometry(this.radius * 0.55, 20),
        new THREE.MeshBasicMaterial({ color: 0x080302 }),
      );
      core.rotation.x = -Math.PI / 2;
      core.position.y = 0.01;
      pit.receiveShadow = true;
      group.add(rim, pit, core);
      group.position.set(x, 0, z);
      group.rotation.y = rng() * Math.PI;
      this.mesh = group;
    } else if (kind === 'rock') {
      this.radius = spec.radius;
      this.height = this.radius * 1.1;
      this.restitution = 0.55;
      this.significant = true;
      const g = new THREE.DodecahedronGeometry(this.radius, 0);
      distort(g, 0.12, rng);
      const m = new THREE.MeshStandardMaterial({ color: 0x4d3121, roughness: 0.95 });
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, this.radius * 0.55, z);
      mesh.rotation.y = rng() * Math.PI;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.mesh = mesh;
    } else if (kind === 'pebble') {
      this.radius = spec.radius;
      this.height = this.radius * 0.9;
      this.restitution = 0.4;
      this.significant = false;
      const g = new THREE.IcosahedronGeometry(this.radius, 0);
      distort(g, 0.08, rng);
      const m = new THREE.MeshStandardMaterial({ color: 0x5a3a24, roughness: 1 });
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, this.radius * 0.45, z);
      mesh.rotation.y = rng() * Math.PI;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.mesh = mesh;
    } else if (kind === 'stick') {
      this.height = 0.14;
      this.restitution = 0.3;
      this.significant = false;
      const len = spec.len;
      const group = new THREE.Group();
      const g = new THREE.CylinderGeometry(0.05, 0.06, len, 8);
      const m = new THREE.MeshStandardMaterial({ color: 0x3a2110, roughness: 1 });
      const rod = new THREE.Mesh(g, m);
      rod.rotation.z = Math.PI / 2;
      rod.castShadow = true;
      rod.receiveShadow = true;
      group.add(rod);
      group.position.set(x, 0.06, z);
      group.rotation.y = rng() * Math.PI;
      this.mesh = group;
      // Longer collision radius approximation (computed in shared/arena.js)
      this.radius = spec.radius;
    } else {
      // bump — visual only, but still small collision
      this.radius = spec.radius;
      this.height = 0.05;
      this.restitution = 0.2;
      this.significant = false;
      const g = new THREE.SphereGeometry(this.radius, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      const m = new THREE.MeshStandardMaterial({ color: 0x7a4327, roughness: 1 });
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, 0, z);
      mesh.scale.y = 0.25;
      mesh.receiveShadow = true;
      this.mesh = mesh;
    }
  }
}

function distort(geo: THREE.BufferGeometry, amount: number, rng: () => number) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) * (1 + (rng() - 0.5) * amount);
    const y = pos.getY(i) * (1 + (rng() - 0.5) * amount);
    const z = pos.getZ(i) * (1 + (rng() - 0.5) * amount);
    pos.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
}
