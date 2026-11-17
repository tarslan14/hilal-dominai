import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { countryAt, type World } from '../data/world';
import { MapPainter, mix, type RGB } from './painter';

const D2R = Math.PI / 180;

export function llToVec(lon: number, lat: number, r = 1, out = new THREE.Vector3()): THREE.Vector3 {
  const phi = (lon + 180) * D2R;
  const theta = (90 - lat) * D2R;
  return out.set(-r * Math.cos(phi) * Math.sin(theta), r * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta));
}

interface Arc { line: THREE.Line; head: THREE.Sprite; pts: THREE.Vector3[]; t: number }
interface Pulse { mesh: THREE.Mesh; t: number; life: number; size: number }
interface Fade { id: string; from: RGB; to: RGB; t: number }

export class Globe {
  readonly painter: MapPainter;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private sphere: THREE.Mesh;
  private texture: THREE.CanvasTexture;
  private raycaster = new THREE.Raycaster();
  private hoverLine: THREE.LineSegments;
  private selectLine: THREE.LineSegments;
  private fxGroup = new THREE.Group();
  private glowGroup = new THREE.Group();
  private glowTex: THREE.Texture;
  private arcs: Arc[] = [];
  private pulses: Pulse[] = [];
  private fades: Fade[] = [];
  private fly: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
  private fronts: string[] = [];
  private frontTimer = 0;
  private clock = new THREE.Clock();
  private downAt: [number, number] | null = null;
  private hoverId: string | null = null;
  autoRotate = true;
  onHover: (id: string | null, x: number, y: number) => void = () => {};
  onClick: (id: string | null) => void = () => {};

  constructor(private host: HTMLElement, private world: World) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x02040a);
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
    this.camera.position.copy(llToVec(15, 25, 3.3));

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.18;
    this.controls.maxDistance = 6;
    this.controls.addEventListener('start', () => { this.autoRotate = false; this.fly = null; });

    this.painter = new MapPainter(world);
    this.texture = new THREE.CanvasTexture(this.painter.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), new THREE.MeshBasicMaterial({ map: this.texture }));
    this.scene.add(this.sphere);

    this.addStars();
    this.addAtmosphere();
    this.hoverLine = this.makeOutline(0xffffff, 0.55);
    this.selectLine = this.makeOutline(0x00e5ff, 1);
    this.scene.add(this.fxGroup, this.glowGroup);
    this.glowTex = this.makeGlowTexture();

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => this.handleMove(e));
    el.addEventListener('pointerleave', () => { this.setHover(null); this.onHover(null, 0, 0); });
    el.addEventListener('pointerdown', (e) => (this.downAt = [e.clientX, e.clientY]));
    el.addEventListener('pointerup', (e) => {
      if (!this.downAt) return;
      const moved = Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]);
      this.downAt = null;
      if (moved < 5 && e.button === 0) this.onClick(this.pick(e.clientX, e.clientY));
    });
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private resize() {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private addStars() {
    const n = 2600;
    const pos = new Float32Array(n * 3);
    let seed = 12345;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const u = r() * 2 - 1, a = r() * Math.PI * 2, d = 40 + r() * 20, q = Math.sqrt(1 - u * u);
      pos.set([d * q * Math.cos(a), d * u, d * q * Math.sin(a)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9fb8d8, size: 0.12, sizeAttenuation: true, transparent: true, opacity: 0.75 })));
  }

  private addAtmosphere() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying vec3 vN; void main(){ float i = pow(0.68 - dot(vN, vec3(0.0,0.0,1.0)), 3.0); gl_FragColor = vec4(0.1,0.75,1.0,1.0) * i; }',
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.13, 64, 48), mat));
  }

  private makeGlowTexture(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  private makeOutline(color: number, opacity: number): THREE.LineSegments {
    const l = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: true }));
    l.visible = false;
    this.scene.add(l);
    return l;
  }

  private setOutline(line: THREE.LineSegments, id: string | null, r: number) {
    if (!id) { line.visible = false; return; }
    const c = this.world.byId[id];
    const arr: number[] = [];
    const v = new THREE.Vector3(), w = new THREE.Vector3();
    for (const poly of c.polygons) for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        llToVec(ring[i][0], ring[i][1], r, v);
        llToVec(ring[i + 1][0], ring[i + 1][1], r, w);
        arr.push(v.x, v.y, v.z, w.x, w.y, w.z);
      }
    }
    line.geometry.dispose();
    line.geometry = new THREE.BufferGeometry();
    line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    line.visible = true;
  }

  private pick(cx: number, cy: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.sphere)[0];
    if (!hit || !hit.uv) return null;
    return countryAt(this.world, hit.uv.x * 360 - 180, hit.uv.y * 180 - 90);
  }

  private handleMove(e: PointerEvent) {
    if (e.buttons) return;
    const id = this.pick(e.clientX, e.clientY);
    this.setHover(id);
    this.onHover(id, e.clientX, e.clientY);
  }

  private setHover(id: string | null) {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.setOutline(this.hoverLine, id, 1.0015);
    this.renderer.domElement.style.cursor = id ? 'pointer' : 'grab';
  }

  select(id: string | null) {
    this.setOutline(this.selectLine, id, 1.002);
  }

  flyTo(id: string) {
    const c = this.world.byId[id];
    if (!c) return;
    const dist = Math.min(Math.max(this.camera.position.length(), 1.9), 2.7);
    this.fly = { from: this.camera.position.clone(), to: llToVec(c.centroid[0], c.centroid[1], dist), t: 0 };
    this.autoRotate = false;
  }

  /** Animated colour change for a conquered country. */
  fade(id: string, from: RGB, to: RGB) {
    this.fades = this.fades.filter((f) => f.id !== id);
    this.fades.push({ id, from, to, t: 0 });
  }

  arc(fromId: string, toId: string, color = '#00e5ff') {
    const a = this.world.byId[fromId], b = this.world.byId[toId];
    if (!a || !b || this.arcs.length > 40) return;
    const va = llToVec(a.centroid[0], a.centroid[1]), vb = llToVec(b.centroid[0], b.centroid[1]);
    const ang = va.angleTo(vb);
    const pts: THREE.Vector3[] = [];
    const N = 48;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = new THREE.Vector3().copy(va).lerp(vb, t).normalize();
      p.multiplyScalar(1.004 + Math.sin(Math.PI * t) * (0.04 + ang * 0.16));
      pts.push(p);
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    geo.setDrawRange(0, 0);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 }));
    const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    head.scale.setScalar(0.05);
    this.fxGroup.add(line, head);
    this.arcs.push({ line, head, pts, t: 0 });
  }

  pulse(id: string, color = '#ff3b4e', size = 0.07) {
    const c = this.world.byId[id];
    if (!c || this.pulses.length > 60) return;
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 1, 40),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    const p = llToVec(c.centroid[0], c.centroid[1], 1.004);
    mesh.position.copy(p);
    mesh.lookAt(p.clone().multiplyScalar(2));
    this.fxGroup.add(mesh);
    this.pulses.push({ mesh, t: 0, life: 1.3, size });
  }

  /** Countries currently fought over: they emit recurring red pulses. */
  setFronts(ids: string[]) {
    this.fronts = ids.slice(0, 24);
  }

  /** Red glow sprites over high-chaos countries. */
  setUnrest(list: { id: string; level: number }[]) {
    while (this.glowGroup.children.length) {
      const ch = this.glowGroup.children.pop() as THREE.Sprite;
      (ch.material as THREE.Material).dispose();
    }
    for (const u of list.slice(0, 70)) {
      const c = this.world.byId[u.id];
      if (!c) continue;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xff2030, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5 }));
      sp.position.copy(llToVec(c.centroid[0], c.centroid[1], 1.006));
      const size = Math.min(0.28, 0.05 + Math.sqrt(c.area) * 0.004);
      sp.scale.setScalar(size);
      sp.userData = { base: size, level: u.level, phase: c.centroid[0] };
      this.glowGroup.add(sp);
    }
  }

  private frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    const time = this.clock.elapsedTime;

    if (this.fly) {
      this.fly.t = Math.min(1, this.fly.t + dt / 0.9);
      const k = this.fly.t < 0.5 ? 2 * this.fly.t * this.fly.t : 1 - Math.pow(-2 * this.fly.t + 2, 2) / 2;
      const a = this.fly.from.clone().normalize(), b = this.fly.to.clone().normalize();
      const len = this.fly.from.length() + (this.fly.to.length() - this.fly.from.length()) * k;
      const dir = a.lerp(b, k).normalize();
      if (dir.lengthSq() > 0.5) this.camera.position.copy(dir.multiplyScalar(len));
      if (this.fly.t >= 1) this.fly = null;
    } else if (this.autoRotate) {
      this.camera.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), dt * 0.05);
    }
    this.controls.rotateSpeed = Math.min(1, (this.camera.position.length() - 1) * 0.55);
    this.controls.update();

    // conquest colour fades (repaints only the affected countries)
    for (const f of this.fades) {
      f.t = Math.min(1, f.t + dt / 0.9);
      const flash = Math.sin(f.t * Math.PI) * 0.5;
      this.painter.paint(f.id, mix(mix(f.from, f.to, f.t), [255, 255, 255], flash));
    }
    this.fades = this.fades.filter((f) => f.t < 1);

    for (const a of this.arcs) {
      a.t += dt;
      const grow = Math.min(1, a.t / 0.8);
      a.line.geometry.setDrawRange(0, Math.floor(grow * a.pts.length));
      const mat = a.line.material as THREE.LineBasicMaterial;
      mat.opacity = a.t < 0.8 ? 0.95 : Math.max(0, 0.95 * (1 - (a.t - 0.8) / 0.7));
      a.head.position.copy(a.pts[Math.min(a.pts.length - 1, Math.floor(grow * (a.pts.length - 1)))]);
      (a.head.material as THREE.SpriteMaterial).opacity = mat.opacity;
      if (a.t > 1.5) { this.fxGroup.remove(a.line, a.head); a.line.geometry.dispose(); mat.dispose(); a.head.material.dispose(); }
    }
    this.arcs = this.arcs.filter((a) => a.t <= 1.5);

    for (const p of this.pulses) {
      p.t += dt;
      const k = p.t / p.life;
      p.mesh.scale.setScalar(p.size * (0.2 + k));
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 * (1 - k));
      if (k >= 1) { this.fxGroup.remove(p.mesh); p.mesh.geometry.dispose(); (p.mesh.material as THREE.Material).dispose(); }
    }
    this.pulses = this.pulses.filter((p) => p.t < p.life);

    this.frontTimer -= dt;
    if (this.frontTimer <= 0 && this.fronts.length) {
      this.frontTimer = 1.6;
      for (const id of this.fronts) this.pulse(id, '#ff3b4e', 0.05);
    }
    for (const ch of this.glowGroup.children) {
      const u = ch.userData as { base: number; level: number; phase: number };
      const w = 0.5 + 0.5 * Math.sin(time * 2.2 + u.phase);
      (ch as THREE.Sprite).scale.setScalar(u.base * (0.9 + 0.25 * w));
      ((ch as THREE.Sprite).material as THREE.SpriteMaterial).opacity = (0.25 + 0.4 * w) * u.level;
    }

    if (this.painter.dirty) {
      this.texture.needsUpdate = true;
      this.painter.dirty = false;
    }
    this.renderer.render(this.scene, this.camera);
  }
}
