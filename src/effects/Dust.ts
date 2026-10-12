import * as THREE from 'three';

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
  gravity: number;
  drag: number;
}

const MAX = 400;

export class DustSystem {
  points: THREE.Points;
  private particles: Particle[] = [];
  private positions: Float32Array;
  private sizes: Float32Array;
  private colors: Float32Array;
  private geo: THREE.BufferGeometry;

  constructor() {
    this.geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(MAX * 3);
    this.sizes = new Float32Array(MAX);
    this.colors = new Float32Array(MAX * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geo.setDrawRange(0, 0);

    const mat = new THREE.PointsMaterial({
      size: 0.22,
      map: makeDustTexture(),
      transparent: true,
      depthWrite: false,
      alphaTest: 0.01,
      vertexColors: true,
      sizeAttenuation: true,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
  }

  burst(x: number, z: number, count: number, power = 1) {
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= MAX) break;
      const a = Math.random() * Math.PI * 2;
      const spd = (0.4 + Math.random() * 1.6) * power;
      this.particles.push({
        pos: new THREE.Vector3(x + (Math.random() - 0.5) * 0.15, 0.05 + Math.random() * 0.1, z + (Math.random() - 0.5) * 0.15),
        vel: new THREE.Vector3(Math.cos(a) * spd, 0.5 + Math.random() * 1.2 * power, Math.sin(a) * spd),
        life: 0,
        maxLife: 0.5 + Math.random() * 0.5,
        size: 0.15 + Math.random() * 0.25 * power,
        gravity: 1.6,
        drag: 1.5,
      });
    }
  }

  /** Slow-drifting ambient dust motes floating over the arena. */
  ambient(count: number, arenaRadius: number) {
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= MAX) return;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * arenaRadius * 1.2;
      const wind = 0.15;
      this.particles.push({
        pos: new THREE.Vector3(Math.cos(a) * r, 0.15 + Math.random() * 1.5, Math.sin(a) * r),
        vel: new THREE.Vector3((Math.random() - 0.5) * 0.08 + wind, 0.03 + Math.random() * 0.06, (Math.random() - 0.5) * 0.08),
        life: 0,
        maxLife: 3.0 + Math.random() * 2.0,
        size: 0.06 + Math.random() * 0.09,
        gravity: -0.05, // slight buoyancy so motes drift up
        drag: 0.4,
      });
    }
  }

  trail(x: number, z: number, intensity: number) {
    if (intensity < 0.05) return;
    if (this.particles.length >= MAX) return;
    if (Math.random() > intensity * 0.4) return;
    this.particles.push({
      pos: new THREE.Vector3(x + (Math.random() - 0.5) * 0.1, 0.04, z + (Math.random() - 0.5) * 0.1),
      vel: new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.2 + Math.random() * 0.3, (Math.random() - 0.5) * 0.3),
      life: 0,
      maxLife: 0.6,
      size: 0.12 + Math.random() * 0.12,
      gravity: 1.6,
      drag: 1.5,
    });
  }

  update(dt: number) {
    let write = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) continue;
      // physics
      p.vel.y -= p.gravity * dt;
      p.vel.multiplyScalar(1 - Math.min(0.9, p.drag * dt));
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < 0.02) { p.pos.y = 0.02; p.vel.y *= -0.2; p.vel.x *= 0.7; p.vel.z *= 0.7; }

      const t = p.life / p.maxLife;
      const fade = 1 - t;
      const off = write * 3;
      this.positions[off] = p.pos.x;
      this.positions[off + 1] = p.pos.y;
      this.positions[off + 2] = p.pos.z;
      this.sizes[write] = p.size * (0.8 + t * 0.8);
      // warm dust color
      const r = 0.82 + Math.random() * 0.03;
      const g = 0.65;
      const b = 0.45;
      this.colors[off] = r * fade;
      this.colors[off + 1] = g * fade;
      this.colors[off + 2] = b * fade;

      // keep this particle (compact)
      this.particles[write] = p;
      write++;
    }
    this.particles.length = write;
    this.geo.setDrawRange(0, write);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}

function makeDustTexture(): THREE.CanvasTexture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255, 220, 180, 1)');
  grad.addColorStop(0.4, 'rgba(220, 180, 130, 0.7)');
  grad.addColorStop(1, 'rgba(160, 120, 80, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
