import * as THREE from 'three';

/**
 * Topie blast extras: an expanding fiery shockwave ring on the ground, a
 * second fainter ring, and a quick flash of orange light.
 */
export class ShockwaveSystem {
  group = new THREE.Group();
  private waves: { mesh: THREE.Mesh; t: number; dur: number; maxR: number }[] = [];
  private light = new THREE.PointLight(0xff8a2a, 0, 14, 1.6);

  constructor() {
    this.group.add(this.light);
  }

  blast(x: number, z: number, power = 1) {
    this.ring(x, z, 0.55, 3.6 * power, 0xffb24a, 0.95);
    this.ring(x, z, 0.9, 5.5 * power, 0xff6a1a, 0.55);
    this.light.position.set(x, 1.2, z);
    this.light.intensity = 9 * power;
  }

  private ring(x: number, z: number, dur: number, maxR: number, color: number, opacity: number) {
    const geo = new THREE.RingGeometry(0.82, 1, 64);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0.04, z);
    mesh.scale.setScalar(0.1);
    this.group.add(mesh);
    this.waves.push({ mesh, t: 0, dur, maxR });
  }

  update(dt: number) {
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.t += dt;
      const k = Math.min(1, w.t / w.dur);
      const ease = 1 - (1 - k) ** 3;
      w.mesh.scale.setScalar(0.1 + ease * w.maxR);
      const m = w.mesh.material as THREE.MeshBasicMaterial;
      m.opacity *= 1 - Math.min(1, dt * 3.2);
      if (k >= 1) {
        this.group.remove(w.mesh);
        w.mesh.geometry.dispose();
        m.dispose();
        this.waves.splice(i, 1);
      }
    }
    this.light.intensity = Math.max(0, this.light.intensity - dt * 22);
  }
}
