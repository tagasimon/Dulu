import * as THREE from 'three';

export type ObstacleKind = 'rock' | 'pebble' | 'stick' | 'bump';

export class Obstacle {
  mesh: THREE.Object3D;
  pos = new THREE.Vector3();
  radius: number; // collision radius (XZ)
  height: number;
  kind: ObstacleKind;
  restitution: number;
  significant: boolean; // large enough to cause "blasted into obstacle" end

  constructor(kind: ObstacleKind, x: number, z: number, rng: () => number) {
    this.kind = kind;
    this.pos.set(x, 0, z);

    if (kind === 'rock') {
      this.radius = 0.4 + rng() * 0.25;
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
      this.radius = 0.18 + rng() * 0.1;
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
      this.radius = 0.14;
      this.height = 0.14;
      this.restitution = 0.3;
      this.significant = false;
      const len = 0.6 + rng() * 0.7;
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
      // Longer collision radius approximation
      this.radius = Math.max(0.16, len * 0.3);
    } else {
      // bump — visual only, but still small collision
      this.radius = 0.35;
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
