import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { MeasurementUnits } from './types';
import { METER_TO_UNIT } from './units';

/**
 * The three.js core: renderer, camera, orbit, gizmo, grid ruler with meter
 * labels, model root, overlay group, rect-select UI, raycast helpers.
 * Scene space: 1 unit = 1 meter (R7). Display units are cosmetic only.
 */
export class Editor {
  dom: HTMLElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  orbit: OrbitControls;

  modelRoot = new THREE.Group();
  overlayGroup = new THREE.Group();
  helperGroup = new THREE.Group();

  gizmo: TransformControls;
  gizmoHelper: THREE.Object3D;
  gizmoDragging = false;

  private gizmoDragStartListeners: (() => void)[] = [];
  private gizmoDragEndListeners: (() => void)[] = [];

  /** Subscribe to gizmo drag start/end (multiple tools can listen). */
  addGizmoDragStartListener(fn: () => void): void {
    this.gizmoDragStartListeners.push(fn);
  }

  addGizmoDragEndListener(fn: () => void): void {
    this.gizmoDragEndListeners.push(fn);
  }

  units: MeasurementUnits = 'meter';

  private raycaster = new THREE.Raycaster();
  private rectDiv: HTMLDivElement;
  private rectActive = false;
  private rectStartPx = { x: 0, y: 0 };
  private gridVisible = true;
  private disposables: (() => void)[] = [];

  constructor(container: HTMLElement) {
    this.dom = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.dom.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1b1d21);

    this.camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.01, 500);
    this.camera.position.set(2.6, 1.9, 2.6);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.target.set(0, 0.5, 0);

    // Lights.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x33383f, 1.15);
    const dir = new THREE.DirectionalLight(0xffffff, 1.7);
    dir.position.set(3.5, 7, 4.5);
    const dir2 = new THREE.DirectionalLight(0xaac4ff, 0.5);
    dir2.position.set(-4, 3, -3);
    this.scene.add(hemi, dir, dir2);

    this.modelRoot.name = 'ModelRoot';
    this.overlayGroup.name = 'OverlayGroup';
    this.helperGroup.name = 'HelperGroup';
    this.scene.add(this.modelRoot, this.overlayGroup, this.helperGroup);

    // Gizmo (TransformControls). In newer three.js the visual helper is separate.
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    const anyGizmo = this.gizmo as any;
    this.gizmoHelper = anyGizmo.getHelper ? anyGizmo.getHelper() : (this.gizmo as unknown as THREE.Object3D);
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('dragging-changed', (e: any) => {
      this.orbit.enabled = !e.value;
      this.gizmoDragging = e.value;
      if (e.value) {
        for (const fn of this.gizmoDragStartListeners) fn();
      } else {
        for (const fn of this.gizmoDragEndListeners) fn();
      }
    });

    // Rect-select visual.
    this.rectDiv = document.createElement('div');
    this.rectDiv.className = 'rect-select';
    this.rectDiv.style.display = 'none';
    const style = document.createElement('style');
    style.textContent = `.rect-select{position:absolute;border:1px solid var(--accent);background:rgba(79,140,255,0.12);pointer-events:none;z-index:15;}`;
    document.head.appendChild(style);
    this.dom.appendChild(this.rectDiv);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.disposables.push(() => ro.disconnect());

    this.rebuildGrid();
    this.animate();
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
  };

  private resize(): void {
    const w = this.dom.clientWidth;
    const h = this.dom.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  // ---------- model ----------

  setModel(root: THREE.Object3D): void {
    this.clearModel();
    this.modelRoot.add(root);
    this.frameModel();
  }

  clearModel(): void {
    // Only clear the model; overlay children are owned by the tools
    // (segment overlay, floor plane) and manage their own lifecycle.
    this.modelRoot.clear();
    this.rebuildGrid();
  }

  frameModel(): void {
    const box = new THREE.Box3().setFromObject(this.modelRoot);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.001);
    const dist = (maxDim / 2) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.7;
    const dir = new THREE.Vector3(1, 0.65, 1).normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(maxDim / 1000, 0.001);
    this.camera.far = dist * 40;
    this.camera.updateProjectionMatrix();
    this.orbit.target.copy(center);
    this.rebuildGrid();
  }

  // ---------- grid ruler ----------

  setGridVisible(v: boolean): void {
    this.gridVisible = v;
    this.helperGroup.visible = v;
  }

  rebuildGrid(): void {
    // Remove old helpers (keep group object).
    while (this.helperGroup.children.length) {
      const c = this.helperGroup.children.pop()!;
      this.helperGroup.remove(c);
    }
    const box = new THREE.Box3().setFromObject(this.modelRoot);
    let size = 10;
    if (!box.isEmpty()) {
      const s = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(s.x, s.z);
      size = Math.max(4, Math.ceil(maxDim * 1.7 / 2) * 2);
    }

    const major = new THREE.GridHelper(size, size, 0x3d434c, 0x2c3138);
    (major.material as THREE.Material).transparent = true;
    (major.material as THREE.Material).opacity = 0.9;
    this.helperGroup.add(major);

    if (size <= 40) {
      const minor = new THREE.GridHelper(size, size * 10, 0x23262b, 0x23262b);
      (minor.material as THREE.Material).transparent = true;
      (minor.material as THREE.Material).opacity = 0.5;
      (minor as any).position.y = -0.0005;
      this.helperGroup.add(minor);
    }

    const axes = new THREE.AxesHelper(Math.min(size / 4, 1.2));
    (axes as any).position.y = 0.001;
    this.helperGroup.add(axes);

    // Meter labels along +X and +Z, plus axis captions (R7: units readable).
    const u = METER_TO_UNIT[this.units];
    const suffix = this.units === 'meter' ? 'm' : 'cm';
    const half = size / 2;
    for (let i = 1; i <= half; i++) {
      const vMeters = i;
      const label = `${(vMeters * u) % 1 === 0 ? (vMeters * u).toFixed(0) : (vMeters * u).toFixed(1)}`;
      this.helperGroup.add(makeTextSprite(label, 0x8a919b, new THREE.Vector3(vMeters, 0.003, 0.03), 0.16));
      this.helperGroup.add(makeTextSprite(label, 0x8a919b, new THREE.Vector3(0.03, 0.003, vMeters), 0.16));
    }
    this.helperGroup.add(makeTextSprite(`X (${suffix})`, 0xc76a6a, new THREE.Vector3(half + 0.45, 0.003, 0), 0.2));
    this.helperGroup.add(makeTextSprite(`Z (${suffix})`, 0x6a7fc7, new THREE.Vector3(0, 0.003, half + 0.45), 0.2));
    this.helperGroup.visible = this.gridVisible;
  }

  // ---------- picking ----------

  ndcFromEvent(e: PointerEvent | MouseEvent): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
  }

  raycastModel(ndc: THREE.Vector2): { object: THREE.Mesh; faceIndex: number; point: THREE.Vector3; distance: number } | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.modelRoot.children, true);
    for (const h of hits) {
      if (h.faceIndex !== undefined && h.faceIndex !== null && (h.object as THREE.Mesh).isMesh) {
        return { object: h.object as THREE.Mesh, faceIndex: h.faceIndex, point: h.point.clone(), distance: h.distance };
      }
    }
    return null;
  }

  /** Intersect the view ray with the horizontal plane at height y. */
  planePoint(ndc: THREE.Vector2, y: number): THREE.Vector3 | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, out) ? out : null;
  }

  /** Intersect the view ray with a vertical plane through `point`, facing the camera. */
  verticalPlanePoint(ndc: THREE.Vector2, point: THREE.Vector3): THREE.Vector3 | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    const n = new THREE.Vector3();
    this.camera.getWorldDirection(n);
    n.y = 0;
    if (n.lengthSq() < 1e-8) n.set(0, 0, 1);
    n.normalize().negate();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, point);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, out) ? out : null;
  }

  // ---------- rect select ----------

  beginRect(e: PointerEvent): void {
    this.rectActive = true;
    this.rectStartPx = { x: e.clientX, y: e.clientY };
    this.updateRect(e);
  }

  updateRect(e: PointerEvent): void {
    if (!this.rectActive) return;
    const x0 = Math.min(this.rectStartPx.x, e.clientX);
    const y0 = Math.min(this.rectStartPx.y, e.clientY);
    const w = Math.abs(e.clientX - this.rectStartPx.x);
    const h = Math.abs(e.clientY - this.rectStartPx.y);
    this.rectDiv.style.display = 'block';
    this.rectDiv.style.left = `${x0 - this.dom.getBoundingClientRect().left}px`;
    this.rectDiv.style.top = `${y0 - this.dom.getBoundingClientRect().top}px`;
    this.rectDiv.style.width = `${w}px`;
    this.rectDiv.style.height = `${h}px`;
  }

  /** Returns the drag rect in NDC {x0,y0,x1,y1}, or null if it was a tiny click. */
  endRect(e: PointerEvent): { x0: number; y0: number; x1: number; y1: number } | null {
    this.rectActive = false;
    this.rectDiv.style.display = 'none';
    const r = this.renderer.domElement.getBoundingClientRect();
    const toNdc = (cx: number, cy: number) => ({
      x: ((cx - r.left) / r.width) * 2 - 1,
      y: -((cy - r.top) / r.height) * 2 + 1,
    });
    const a = toNdc(this.rectStartPx.x, this.rectStartPx.y);
    const b = toNdc(e.clientX, e.clientY);
    const distPx = Math.hypot(e.clientX - this.rectStartPx.x, e.clientY - this.rectStartPx.y);
    if (distPx < 6) return null; // click, not drag
    return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
  }

  /** Sample screen points inside an NDC rect (grid). */
  sampleRectNdc(rect: { x0: number; y0: number; x1: number; y1: number }, steps = 10): THREE.Vector2[] {
    const pts: THREE.Vector2[] = [];
    for (let ix = 0; ix <= steps; ix++) {
      for (let iy = 0; iy <= steps; iy++) {
        pts.push(new THREE.Vector2(
          rect.x0 + ((rect.x1 - rect.x0) * ix) / steps,
          rect.y0 + ((rect.y1 - rect.y0) * iy) / steps,
        ));
      }
    }
    return pts;
  }

  // ---------- gizmo ----------

  attachGizmo(obj: THREE.Object3D, mode: 'translate' | 'rotate' | 'scale', space: 'world' | 'local' = 'world'): void {
    this.gizmo.attach(obj);
    this.gizmo.setMode(mode);
    this.gizmo.setSpace(space);
    this.gizmoHelper.visible = true;
  }

  detachGizmo(): void {
    this.gizmo.detach();
    this.gizmoHelper.visible = false;
  }

  get gizmoDraggingNow(): boolean {
    return this.gizmoDragging;
  }

  /** While segment/floor tools are active, left-drag is rect-select, so orbit moves to the right button. */
  setLeftButtonOrbit(v: boolean): void {
    this.orbit.mouseButtons = {
      LEFT: v ? THREE.MOUSE.ROTATE : null,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    } as any;
  }

  setOrbitEnabled(v: boolean): void {
    this.orbit.enabled = v;
  }

  setWireframe(v: boolean): void {
    this.modelRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && Array.isArray(mesh.material) === false && mesh.material) {
        (mesh.material as THREE.MeshStandardMaterial).wireframe = v;
      }
    });
  }

  dispose(): void {
    for (const d of this.disposables) d();
    this.renderer.dispose();
  }
}

/** Small always-facing text label as a sprite. */
export function makeTextSprite(text: string, color: number, pos: THREE.Vector3, height = 0.18): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontPx = 42;
  ctx.font = `${fontPx}px system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 12;
  canvas.width = w;
  canvas.height = fontPx + 10;
  const ctx2 = canvas.getContext('2d')!;
  ctx2.font = `${fontPx}px system-ui, sans-serif`;
  ctx2.fillStyle = `#${new THREE.Color(color).getHexString()}`;
  ctx2.textBaseline = 'middle';
  ctx2.fillText(text, 6, canvas.height / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(height * aspect, height, 1);
  sprite.position.copy(pos);
  sprite.renderOrder = 5;
  return sprite;
}
