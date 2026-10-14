import * as THREE from 'three';

import { ARENA_RADIUS } from '../../shared/arena';
export { ARENA_RADIUS };

export class SceneManager {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  private baseCamPos = new THREE.Vector3(0, 12, 11);
  private baseCamLook = new THREE.Vector3(0, 0, 0);
  private shakeOffset = new THREE.Vector3();
  private shakeAmount = 0;
  private groundGroup = new THREE.Group();
  private target = new THREE.Vector3(0, 0, 0);
  private targetLook = new THREE.Vector3(0, 0, 0);

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x1a0d08);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 200);
    this.camera.position.copy(this.baseCamPos);
    this.camera.lookAt(this.baseCamLook);
    this.target.copy(this.baseCamPos);
    this.targetLook.copy(this.baseCamLook);

    this.setupLighting();
    this.buildGround();

    this.scene.add(this.groundGroup);
    this.scene.fog = new THREE.Fog(0x2a1608, ARENA_RADIUS * 2.6, ARENA_RADIUS * 6.5);

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private setupLighting() {
    const hemi = new THREE.HemisphereLight(0xffd8a8, 0x2a1608, 0.55);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffe0b3, 1.25);
    sun.position.set(-8, 20, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60;
    const s = ARENA_RADIUS + 4;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);

    // subtle warm rim light
    const rim = new THREE.DirectionalLight(0xff9a5a, 0.35);
    rim.position.set(6, 4, -6);
    this.scene.add(rim);
  }

  private buildGround() {
    // Main dirt disc
    const geo = new THREE.CircleGeometry(ARENA_RADIUS + 6, 96);
    // gentle bumps
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const r = Math.sqrt(x * x + y * y);
      const bump = (Math.sin(x * 1.9) * Math.cos(y * 1.7) + Math.sin(x * 4.3 + y * 2.1) * 0.5) * 0.03;
      const dip = -Math.max(0, 1.2 - r) * 0.02;
      pos.setZ(i, bump + dip);
    }
    geo.computeVertexNormals();
    geo.rotateX(-Math.PI / 2);

    const dirtTex = makeDirtTexture(512);
    dirtTex.wrapS = dirtTex.wrapT = THREE.RepeatWrapping;
    dirtTex.repeat.set(3, 3);

    const mat = new THREE.MeshStandardMaterial({
      map: dirtTex,
      color: 0x8a4a2a,
      roughness: 0.95,
      metalness: 0.02,
    });
    const ground = new THREE.Mesh(geo, mat);
    ground.receiveShadow = true;
    this.groundGroup.add(ground);

    // Outer sand ring darker
    const outer = new THREE.Mesh(
      new THREE.RingGeometry(ARENA_RADIUS + 5.8, ARENA_RADIUS + 14, 64),
      new THREE.MeshStandardMaterial({ color: 0x3a1c10, roughness: 1 })
    );
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.01;
    outer.receiveShadow = true;
    this.groundGroup.add(outer);

    // Ring boundary — subtle drawn circle
    const ringGeo = new THREE.RingGeometry(ARENA_RADIUS - 0.05, ARENA_RADIUS + 0.03, 128);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x3a1a0a, transparent: true, opacity: 0.35 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.005;
    this.groundGroup.add(ring);

    // scatter small pebbles as visual detail (non-physical)
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = ARENA_RADIUS - 0.2 + Math.random() * 5;
      const px = Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      const size = 0.03 + Math.random() * 0.08;
      const peb = new THREE.Mesh(
        new THREE.IcosahedronGeometry(size, 0),
        new THREE.MeshStandardMaterial({ color: 0x4a2a18, roughness: 1 })
      );
      peb.position.set(px, size * 0.4, pz);
      peb.rotation.y = Math.random() * Math.PI;
      peb.receiveShadow = true;
      this.groundGroup.add(peb);
    }

    // grass tufts at very outer edge
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2 + Math.random() * 0.1;
      const r = ARENA_RADIUS + 8 + Math.random() * 3;
      const tuft = makeGrassTuft();
      tuft.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      tuft.rotation.y = Math.random() * Math.PI;
      this.groundGroup.add(tuft);
    }

    // Trees ringing the play area — stylized, casting long soft shadows
    const treeCount = 10;
    for (let i = 0; i < treeCount; i++) {
      const a = (i / treeCount) * Math.PI * 2 + Math.random() * 0.35;
      const r = ARENA_RADIUS + 9 + Math.random() * 5;
      const tree = makeTree(0.9 + Math.random() * 0.6);
      tree.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      tree.rotation.y = Math.random() * Math.PI;
      this.groundGroup.add(tree);
    }

    // A couple of smaller scrub bushes closer in
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = ARENA_RADIUS + 6 + Math.random() * 3;
      const bush = makeBush(0.4 + Math.random() * 0.3);
      bush.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      this.groundGroup.add(bush);
    }
  }

  addObstacle(mesh: THREE.Object3D) { this.groundGroup.add(mesh); }
  add(obj: THREE.Object3D) { this.scene.add(obj); }
  remove(obj: THREE.Object3D) { this.scene.remove(obj); }

  setCameraTargets(focus: THREE.Vector3, zoom = 1) {
    // Pull camera back proportionally to zoom, keep a slight lean, and look
    // directly at the focus point so framing stays honest.
    this.target.copy(this.baseCamPos).multiplyScalar(zoom);
    this.target.x += focus.x * 0.12;
    this.target.z += focus.z * 0.05;
    this.targetLook.copy(focus);
  }

  shake(amount: number) {
    this.shakeAmount = Math.max(this.shakeAmount, amount);
  }

  update(dt: number) {
    this.camera.position.lerp(this.target, Math.min(1, dt * 2.5));
    this.baseCamLook.lerp(this.targetLook, Math.min(1, dt * 3));

    // camera shake decays
    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 2.5);
    if (this.shakeAmount > 0.001) {
      const s = this.shakeAmount;
      this.shakeOffset.set(
        (Math.random() - 0.5) * s,
        (Math.random() - 0.5) * s * 0.6,
        (Math.random() - 0.5) * s
      );
      this.camera.position.add(this.shakeOffset);
    }
    this.camera.lookAt(this.baseCamLook);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Tighter FOV on landscape / laptops, wider on tall portrait
    const portrait = h > w;
    this.camera.fov = portrait ? 58 : 42;
    // Tighter framing so the marble-sized seeds and the hand read clearly
    const dist = portrait ? 11 : 8.5;
    const height = portrait ? 10 : 8.5;
    this.baseCamPos.set(0, height, dist);
    // Keep target close to base when nothing is focused
    this.target.copy(this.baseCamPos);
    this.camera.updateProjectionMatrix();
  }

  screenToGround(screen: THREE.Vector2): THREE.Vector3 | null {
    const ndc = new THREE.Vector2(
      (screen.x / window.innerWidth) * 2 - 1,
      -(screen.y / window.innerHeight) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const target = new THREE.Vector3();
    if (ray.ray.intersectPlane(plane, target)) return target;
    return null;
  }

  clearObstacles(keepUuids: Set<string>) {
    // Not used; obstacles managed externally
  }
}

function makeDirtTexture(size: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  // base gradient
  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.7);
  grad.addColorStop(0, '#a3623a');
  grad.addColorStop(1, '#6b3a1e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  // noise speckles
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (Math.random() - 0.5) * 45;
    data[i] = clamp(data[i] + n, 0, 255);
    data[i + 1] = clamp(data[i + 1] + n * 0.8, 0, 255);
    data[i + 2] = clamp(data[i + 2] + n * 0.6, 0, 255);
  }
  ctx.putImageData(img, 0, 0);
  // dark grain flecks
  for (let i = 0; i < 200; i++) {
    ctx.fillStyle = `rgba(30, 15, 8, ${0.15 + Math.random() * 0.3})`;
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, Math.random() * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  // light flecks
  for (let i = 0; i < 120; i++) {
    ctx.fillStyle = `rgba(230, 190, 140, ${0.1 + Math.random() * 0.2})`;
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, Math.random() * 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }

function makeGrassTuft(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x6b6a24, roughness: 1, side: THREE.DoubleSide });
  for (let i = 0; i < 5; i++) {
    const h = 0.25 + Math.random() * 0.35;
    const blade = new THREE.Mesh(new THREE.PlaneGeometry(0.05, h), mat);
    blade.position.y = h / 2;
    blade.rotation.y = Math.random() * Math.PI;
    blade.rotation.z = (Math.random() - 0.5) * 0.3;
    g.add(blade);
  }
  return g;
}

function makeTree(scale: number): THREE.Group {
  const g = new THREE.Group();
  // Bark brown with a little variation (the old version added a random number to
  // the whole RGB value, which spilled into green/blue and made odd trunks).
  const trunkColor = new THREE.Color().setHSL(0.07 + Math.random() * 0.02, 0.45, 0.13 + Math.random() * 0.05);
  const trunkMat = new THREE.MeshStandardMaterial({ color: trunkColor, roughness: 1 });
  const trunkH = (1.6 + Math.random() * 0.9) * scale;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16 * scale, 0.24 * scale, trunkH, 8),
    trunkMat
  );
  trunk.position.y = trunkH / 2;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  g.add(trunk);

  // Foliage: 3-4 overlapping spheres of dusty olive/green
  const green = new THREE.Color().setHSL(
    0.20 + Math.random() * 0.08,      // yellowish-green
    0.35,
    0.28 + Math.random() * 0.08
  );
  const foliageMat = new THREE.MeshStandardMaterial({ color: green, roughness: 1 });
  const clusters = 3 + Math.floor(Math.random() * 2);
  for (let i = 0; i < clusters; i++) {
    const r = (0.55 + Math.random() * 0.35) * scale;
    const s = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), foliageMat);
    s.position.set(
      (Math.random() - 0.5) * 0.5 * scale,
      trunkH + (Math.random() * 0.4 + 0.2) * scale,
      (Math.random() - 0.5) * 0.5 * scale,
    );
    s.scale.y = 0.85 + Math.random() * 0.2;
    s.castShadow = true;
    g.add(s);
  }
  return g;
}

function makeBush(scale: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x556025, roughness: 1 });
  for (let i = 0; i < 3; i++) {
    const r = (0.28 + Math.random() * 0.18) * scale;
    const s = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat);
    s.position.set((Math.random() - 0.5) * 0.4 * scale, r * 0.6, (Math.random() - 0.5) * 0.4 * scale);
    s.scale.y = 0.7;
    s.castShadow = true;
    g.add(s);
  }
  return g;
}
