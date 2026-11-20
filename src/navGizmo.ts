import * as THREE from 'three';
import type { Editor } from './editor';

/**
 * Blender-style navigation gizmo in its OWN overlay space:
 * a dedicated small canvas (top-right, left of the tool panel) rendered with
 * its own WebGL context, plus its own DOM buttons. It shares nothing with the
 * model's canvas — pointer events over it never reach the 3D view and it is
 * always drawn on top, so it stays visible and interactable at any zoom/pan.
 *
 *  - 6 axis balls (+X/Y/Z solid, −X/Y/Z hollow rings). Click snaps to that
 *    view (Right/Left/Top/Bottom/Front/Back) with a short smooth turn.
 *  - Drag on the gizmo = orbit (trackball).
 *  - Zoom in/out + perspective/orthographic toggle (Blender's vertical stack).
 *  - Numpad keys: 1/3/7 (+Ctrl = opposite), 5 = ortho, +/- = zoom.
 *  - Caption below shows the current view + projection.
 *
 * Y-up convention: +Y is Top, −Z is the side the default camera sits on, so
 * the +Z ball is "Front" (Blender's −Y = Front, mapped to this app's axes).
 */
interface AxisBall {
  key: string;
  name: string;
  dir: THREE.Vector3;
  mesh: THREE.Mesh;
  torus?: THREE.Mesh;
  /** Invisible pick proxy: disk for +axis balls, ring band for −axis balls. */
  pick: THREE.Mesh;
}

const BALL_R = 1.0;
const AXIS_COLOR: Record<'x' | 'y' | 'z', number> = {
  x: 0xe0554e,
  y: 0x8bc34a,
  z: 0x42a5f5,
};
/** cos(0.5°) — "aligned to an axis" threshold for auto-ortho / flip logic. */
const AXIS_COS_EPS = Math.cos(THREE.MathUtils.degToRad(0.5));

export class NavigationGizmo {
  scene = new THREE.Scene();
  camera: THREE.OrthographicCamera;
  size = 96;
  margin = 8;
  /** Distance from the top of the viewport (below the 38px topbar). */
  topOffset = 46;

  private editor: Editor;
  private container!: HTMLDivElement;
  private gizmoCanvas!: HTMLCanvasElement;
  private hudRenderer!: THREE.WebGLRenderer;
  private balls: AxisBall[] = [];
  /** Invisible pick proxies: ring bands for −axis balls, disks for +axis balls. */
  private pickRings: THREE.Mesh[] = [];
  private pickDisks: THREE.Mesh[] = [];
  private hoverKey: string | null = null;
  private drag: { lastX: number; lastY: number; moved: number; ball: string | null } | null = null;
  private tween: {
    from: THREE.Quaternion;
    to: THREE.Quaternion;
    up: THREE.Vector3;
    t: number;
    dur: number;
    dist: number;
    target: THREE.Vector3;
    label: string;
  } | null = null;

  private tooltip!: HTMLDivElement;
  private viewLabel!: HTMLDivElement;
  private btnToggle!: HTMLButtonElement;

  /** True while an axis view auto-switched the projection to orthographic. */
  private autoOrtho = false;
  /** Projection to restore when the user rotates away from the axis view. */
  private projectionBeforeAutoOrtho: 'persp' | 'ortho' | null = null;

  constructor(editor: Editor) {
    this.editor = editor;

    // Gizmo camera: orthographic, fixed distance; orientation synced to the
    // main camera every frame so the balls rotate with the view.
    this.camera = new THREE.OrthographicCamera(-1.45, 1.45, 1.45, -1.45, 0.1, 20);
    this.camera.position.set(0, 0, 6);

    this.buildGizmo();
    this.buildDom();

    // Pointer events live on the gizmo's own canvas — the 3D view never sees
    // them, so no listener-order fights with OrbitControls or the tools.
    this.gizmoCanvas.addEventListener('pointerdown', this.onPointerDown);
    this.gizmoCanvas.addEventListener('pointermove', this.onHoverMove);
    this.gizmoCanvas.addEventListener('pointerleave', this.onHoverLeave);
    window.addEventListener('keydown', this.onKeyDown);

    // Keep the top-right position in sync with the tool panel width.
    const panel = document.getElementById('panel');
    if (panel && 'ResizeObserver' in window) {
      const ro = new ResizeObserver(() => this.updatePosition());
      ro.observe(panel);
    }
    this.updatePosition();
  }

  // ---------- layout ----------

  /** Width of the fixed right tool panel (the gizmo must clear it). */
  private panelWidth(): number {
    const panel = document.getElementById('panel');
    return panel ? panel.offsetWidth : 0;
  }

  /** Pin the overlay to the top-right corner, left of the panel. */
  private updatePosition(): void {
    this.container.style.top = `${this.topOffset}px`;
    this.container.style.right = `${this.panelWidth() + this.margin}px`;
  }

  /**
   * Bounding rect of the gizmo canvas in PAGE coordinates
   * ({ x: left, y: top, size }), for tests and tooltip math.
   */
  rect(): { x: number; y: number; size: number } {
    const r = this.gizmoCanvas.getBoundingClientRect();
    return { x: r.left, y: r.top, size: r.width };
  }

  private canvasPoint(e: PointerEvent): { x: number; y: number } {
    return { x: e.offsetX, y: e.offsetY };
  }

  private ballAt(p: { x: number; y: number }): string | null {
    const nx = (p.x / this.size) * 2 - 1;
    const ny = -((p.y / this.size) * 2 - 1);
    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    // Nearest hit wins (Blender): the near solid ball's disk beats a far
    // ball's disk when aligned; away from the center the far ball's larger
    // disk (dot + ring band) is the only hit → opposite view.
    const hits = this.raycaster.intersectObjects([...this.pickDisks, ...this.pickRings], false);
    return hits.length ? (hits[0].object.userData.key as string) : null;
  }

  private raycaster = new THREE.Raycaster();

  /** Page-space pixel position of a ball (for tests + tooltip placement). */
  screenPosOf(key: string): { x: number; y: number } {
    const ball = this.balls.find((b) => b.key === key);
    if (!ball) return { x: 0, y: 0 };
    const r = this.gizmoCanvas.getBoundingClientRect();
    const v = ball.mesh.position.clone().project(this.camera);
    return {
      x: r.left + ((v.x + 1) / 2) * r.width,
      y: r.top + ((1 - v.y) / 2) * r.height,
    };
  }

  // ---------- construction ----------

  private buildGizmo(): void {
    const defs = [
      { key: 'posX', name: 'Right', dir: new THREE.Vector3(1, 0, 0), axis: 'x' as const, sign: 1 },
      { key: 'negX', name: 'Left', dir: new THREE.Vector3(-1, 0, 0), axis: 'x' as const, sign: -1 },
      { key: 'posY', name: 'Top', dir: new THREE.Vector3(0, 1, 0), axis: 'y' as const, sign: 1 },
      { key: 'negY', name: 'Bottom', dir: new THREE.Vector3(0, -1, 0), axis: 'y' as const, sign: -1 },
      // Y-up app: the default camera sits on the +Z side looking −Z, so that
      // side is "Front" (Blender's −Y ball = Front, mapped to this app's +Z).
      { key: 'posZ', name: 'Front', dir: new THREE.Vector3(0, 0, 1), axis: 'z' as const, sign: 1 },
      { key: 'negZ', name: 'Back', dir: new THREE.Vector3(0, 0, -1), axis: 'z' as const, sign: -1 },
    ];

    for (const d of defs) {
      const color = AXIS_COLOR[d.axis];
      let mesh: THREE.Mesh;
      let torus: THREE.Mesh | undefined;
      let pick: THREE.Mesh;
      if (d.sign > 0) {
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.14, 20, 14),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }),
        );
        // Pick target: a disk covering the solid ball (plus a little slack).
        pick = new THREE.Mesh(
          new THREE.CircleGeometry(0.16, 24),
          new THREE.MeshBasicMaterial({ visible: false }),
        );
      } else {
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.115, 20, 14),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false }),
        );
        torus = new THREE.Mesh(
          new THREE.TorusGeometry(0.115, 0.02, 8, 28),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }),
        );
        torus.renderOrder = 3;
        mesh.add(torus);
        // Pick target: a GENEROUS full disk around the far ball (dot + ring
        // band, ~0.22 world ≈ 7px+). Blender resolves overlap by nearest-hit:
        // aligned center click → near solid ball; the ring band → far ball.
        pick = new THREE.Mesh(
          new THREE.CircleGeometry(0.22, 32),
          new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
        );
      }
      pick.position.copy(d.dir).multiplyScalar(BALL_R);
      pick.userData = { key: d.key, name: d.name };
      if (d.sign > 0) this.pickDisks.push(pick);
      else this.pickRings.push(pick);
      this.scene.add(pick);
      mesh.position.copy(d.dir).multiplyScalar(BALL_R);
      mesh.renderOrder = 2;
      mesh.userData = { key: d.key, name: d.name };
      this.scene.add(mesh);
      this.balls.push({ key: d.key, name: d.name, dir: d.dir, mesh, torus, pick });
    }

    // Axis spokes: center → each ball (positive bright, negative dim).
    for (const d of defs) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        d.dir.clone().multiplyScalar(BALL_R * 0.84),
      ]);
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({
          color: AXIS_COLOR[d.axis],
          transparent: true,
          opacity: d.sign > 0 ? 0.85 : 0.28,
          depthTest: false,
          depthWrite: false,
        }),
      );
      line.renderOrder = 1;
      this.scene.add(line);
    }
  }

  private buildDom(): void {
    const dom = this.editor.dom;

    // Own overlay container — visually and interactively separate from the
    // model's canvas. pointer-events: none on the container; auto on the
    // canvas (circle) and buttons, so clicks pass through everywhere else.
    const container = document.createElement('div');
    container.className = 'navgizmo';
    dom.appendChild(container);
    this.container = container;

    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    this.gizmoCanvas = canvas;
    this.hudRenderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.hudRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.hudRenderer.setSize(this.size, this.size);
    this.hudRenderer.setClearColor(0x000000, 0);

    // Vertical button stack below the gizmo (Blender's layout):
    // zoom in, zoom out, perspective/ortho toggle.
    const row = document.createElement('div');
    row.className = 'navgizmo-btns';
    container.appendChild(row);
    const mkBtn = (svg: string, title: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = 'navgizmo-btn';
      b.title = title;
      b.innerHTML = svg;
      b.addEventListener('click', onClick);
      row.appendChild(b);
      return b;
    };
    mkBtn(ICON_ZOOM_IN, 'Zoom in', () => this.editor.dollyBy(1.3));
    mkBtn(ICON_ZOOM_OUT, 'Zoom out', () => this.editor.dollyBy(1 / 1.3));
    this.btnToggle = mkBtn(ICON_PERSP, 'Toggle perspective/orthographic (currently Perspective)', () =>
      this.toggleProjection(),
    );

    const label = document.createElement('div');
    label.className = 'navgizmo-viewlabel';
    label.textContent = 'User Perspective';
    container.appendChild(label);
    this.viewLabel = label;

    const tooltip = document.createElement('div');
    tooltip.className = 'navgizmo-tooltip hidden';
    container.appendChild(tooltip);
    this.tooltip = tooltip;
  }

  // ---------- pointer handling ----------

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();

    // A click during a view-snap tween finishes the tween immediately.
    if (this.tween) this.finishTween();

    const p = this.canvasPoint(e);
    this.drag = { lastX: e.clientX, lastY: e.clientY, moved: 0, ball: this.ballAt(p) };
    // Capture the pointer so the drag keeps tracking even outside the gizmo
    // and the 3D view receives nothing until we release.
    try {
      this.gizmoCanvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.gizmoCanvas.style.cursor = 'grabbing';
    this.hideTooltip();
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.onPointerUp);
  };

  private onDragMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    const dx = e.clientX - this.drag.lastX;
    const dy = e.clientY - this.drag.lastY;
    this.drag.lastX = e.clientX;
    this.drag.lastY = e.clientY;
    this.drag.moved += Math.abs(dx) + Math.abs(dy);
    if (this.drag.moved < 2) return;

    this.orbitByPixels(dx, dy);
    this.setViewLabel(`User ${this.editor.isOrtho ? 'Orthographic' : 'Perspective'}`);
  };

  private onPointerUp = (): void => {
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.gizmoCanvas.style.cursor = '';
    const wasClick = this.drag && this.drag.moved < 5;
    const ball = this.drag?.ball;
    const didRotate = this.drag && this.drag.moved >= 2;
    this.drag = null;
    if (wasClick && ball) {
      // Blender behavior: clicking the ball of the view you are ALREADY in
      // (aligned within ~0.5°) flips to the opposite side; any other click
      // snaps to that ball's view.
      const ballObj = this.balls.find((b) => b.key === ball)!;
      const fwd = new THREE.Vector3();
      this.editor.camera.getWorldDirection(fwd);
      if (fwd.dot(ballObj.dir) < -AXIS_COS_EPS) {
        const oppositeKey = ball.startsWith('pos') ? `neg${ball[3]}` : `pos${ball[3]}`;
        this.snapTo(oppositeKey);
      } else {
        this.snapTo(ball);
      }
    } else if (didRotate) {
      // Rotated away from an axis view by hand → restore projection.
      this.disarmAutoOrtho();
    }
  };

  private onHoverMove = (e: PointerEvent): void => {
    if (this.drag || this.tween) return;
    const key = this.ballAt(this.canvasPoint(e));
    if (key !== this.hoverKey) {
      if (this.hoverKey) this.setBallHover(this.hoverKey, false);
      this.hoverKey = key;
      if (key) {
        this.setBallHover(key, true);
        const name = this.balls.find((b) => b.key === key)!.name;
        this.tooltip.textContent = name;
        this.tooltip.classList.remove('hidden');
      } else {
        this.hideTooltip();
      }
    }
  };

  private onHoverLeave = (): void => {
    this.hideTooltip();
  };

  private hideTooltip(): void {
    if (this.hoverKey) this.setBallHover(this.hoverKey, false);
    this.hoverKey = null;
    this.tooltip.classList.add('hidden');
  }

  private setBallHover(key: string, on: boolean): void {
    const ball = this.balls.find((b) => b.key === key);
    if (ball) ball.mesh.scale.setScalar(on ? 1.22 : 1);
  }

  // ---------- keyboard (Blender numpad conventions) ----------

  private onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const map: Record<string, string> = {
      Numpad1: ctrl ? 'negZ' : 'posZ', // Front / Back
      Numpad3: ctrl ? 'negX' : 'posX', // Right / Left
      Numpad7: ctrl ? 'negY' : 'posY', // Top / Bottom
    };
    const key = map[e.code];
    if (key) {
      e.preventDefault();
      this.snapTo(key);
      return;
    }
    if (e.code === 'Numpad5' && !ctrl) {
      e.preventDefault();
      this.toggleProjection();
    } else if (e.code === 'NumpadAdd' || (e.code === 'Equal' && !ctrl)) {
      e.preventDefault();
      this.editor.dollyBy(1.3);
    } else if (e.code === 'NumpadSubtract' || (e.code === 'Minus' && !ctrl)) {
      e.preventDefault();
      this.editor.dollyBy(1 / 1.3);
    }
  };

  // ---------- navigation actions ----------

  /** Orbit the active camera by pixel deltas (same convention as OrbitControls). */
  private orbitByPixels(dx: number, dy: number): void {
    const cam = this.editor.camera;
    const target = this.editor.orbit.target;
    cam.up.set(0, 1, 0); // user interaction returns to world-up roll
    const offset = new THREE.Vector3().subVectors(cam.position, target);
    const sph = new THREE.Spherical().setFromVector3(offset);
    const factor = Math.PI / this.size; // half a turn across the gizmo
    sph.theta -= dx * factor;
    sph.phi = THREE.MathUtils.clamp(sph.phi - dy * factor, 0.01, Math.PI - 0.01);
    offset.setFromSpherical(sph);
    cam.position.copy(target).add(offset);
    cam.lookAt(target);
  }

  /** Smoothly turn the view to the given axis ball (Blender view snap). */
  snapTo(key: string): void {
    const ball = this.balls.find((b) => b.key === key);
    if (!ball) return;
    const cam = this.editor.camera;
    const target = this.editor.orbit.target.clone();
    const dist = cam.position.distanceTo(target);
    // Horizontal views roll with world-up; pole views keep the map-like roll
    // (screen-up = −Z) by using −Z as the camera up vector.
    const up = ball.dir.y !== 0 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const eye = target.clone().addScaledVector(ball.dir, dist);
    const m = new THREE.Matrix4().lookAt(eye, target, up);
    const to = new THREE.Quaternion().setFromRotationMatrix(m);
    // Blender: landing on an exact axis view switches to orthographic;
    // rotating away restores the projection the user had before.
    this.armAutoOrtho();
    this.tween = {
      from: cam.quaternion.clone(),
      to,
      up,
      t: 0,
      dur: 0.28,
      dist,
      target,
      label: `${ball.name} ${this.editor.isOrtho ? 'Orthographic' : 'Perspective'}`,
    };
    this.editor.orbit.enabled = false;
  }

  /**
   * Entering an axis view: if currently perspective, switch to orthographic
   * (remembering the user's projection so it can be restored). If already
   * orthographic (user-set or a previous auto switch), keep it.
   */
  private armAutoOrtho(): void {
    if (!this.autoOrtho) {
      if (!this.editor.isOrtho) {
        this.projectionBeforeAutoOrtho = 'persp';
        this.setProjection(true);
      } else {
        this.projectionBeforeAutoOrtho = 'ortho';
      }
    }
    this.autoOrtho = true;
  }

  /**
   * Leaving the axis view (user orbit/drag): restore the projection that was
   * active before the auto switch, if it was auto-switched.
   */
  private disarmAutoOrtho(): void {
    if (this.autoOrtho && this.projectionBeforeAutoOrtho === 'persp') {
      this.setProjection(false);
      if (!this.tween) this.setViewLabel(`User ${this.editor.isOrtho ? 'Orthographic' : 'Perspective'}`);
    }
    this.autoOrtho = false;
    this.projectionBeforeAutoOrtho = null;
  }

  /** Projection switch that PRESERVES the auto-ortho association. */
  private setProjection(ortho: boolean): void {
    if (this.editor.isOrtho === ortho) return;
    this.editor.toggleProjection();
    this.updateToggleButton();
  }

  private updateToggleButton(): void {
    this.btnToggle.title = `Toggle perspective/orthographic (currently ${this.editor.isOrtho ? 'Orthographic' : 'Perspective'})`;
    this.btnToggle.innerHTML = this.editor.isOrtho ? ICON_ORTHO : ICON_PERSP;
  }

  private finishTween(): void {
    if (!this.tween) return;
    const tw = this.tween;
    const cam = this.editor.camera;
    cam.quaternion.copy(tw.to);
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(cam.quaternion);
    cam.position.copy(tw.target).addScaledVector(dir, tw.dist);
    const label = `${tw.label.split(' ')[0]} ${this.editor.isOrtho ? 'Orthographic' : 'Perspective'}`;
    this.tween = null;
    cam.up.copy(tw.up); // pole snaps keep their roll until the user orbits
    this.editor.orbit.enabled = true;
    this.editor.orbit.update();
    this.setViewLabel(label);
  }

  dolly(factor: number): void {
    this.editor.dollyBy(factor);
  }

  /**
   * User-facing toggle (button / Numpad 5). A manual switch is a user
   * override: it breaks the auto-ortho association, so rotating away keeps
   * the user's explicit choice.
   */
  toggleProjection(): void {
    this.setProjection(!this.editor.isOrtho);
    this.autoOrtho = false;
    this.projectionBeforeAutoOrtho = null;
    if (!this.tween) this.setViewLabel(`User ${this.editor.isOrtho ? 'Orthographic' : 'Perspective'}`);
    this.updateToggleButton();
  }

  markUser(): void {
    if (!this.tween) this.setViewLabel(`User ${this.editor.isOrtho ? 'Orthographic' : 'Perspective'}`);
  }

  /**
   * Called from the editor on every user-driven orbit (OrbitControls change).
   * If the view is no longer aligned to an axis while auto-ortho is active,
   * restore the user's original projection.
   */
  onUserOrbit(): void {
    if (!this.autoOrtho || this.tween || this.drag) return;
    const fwd = new THREE.Vector3();
    this.editor.camera.getWorldDirection(fwd);
    const aligned =
      Math.abs(fwd.x) > AXIS_COS_EPS ||
      Math.abs(fwd.y) > AXIS_COS_EPS ||
      Math.abs(fwd.z) > AXIS_COS_EPS;
    if (!aligned) this.disarmAutoOrtho();
  }

  private setViewLabel(text: string): void {
    this.viewLabel.textContent = text;
  }

  // ---------- per-frame ----------

  get busy(): boolean {
    return this.tween !== null || this.drag !== null;
  }

  update(dt: number): void {
    const cam = this.editor.camera;

    // View-snap tween: slerp orientation, keep distance to orbit target.
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const k = tw.t * tw.t * (3 - 2 * tw.t);
      cam.quaternion.slerpQuaternions(tw.from, tw.to, k);
      const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(cam.quaternion);
      cam.position.copy(tw.target).addScaledVector(dir, tw.dist);
      if (tw.t >= 1) this.finishTween();
    }

    // Sync the gizmo camera to the view: orientation copied, and the camera
    // placed ON the synced view axis at a fixed distance, so the gizmo center
    // (scene origin) projects exactly to the canvas center at all times —
    // during idle, drags, and snap tweens alike (rotation spins around it).
    this.camera.quaternion.copy(cam.quaternion);
    this.camera.position.set(0, 0, 6).applyQuaternion(this.camera.quaternion);
    for (const b of this.balls) {
      if (b.torus) b.torus.quaternion.copy(this.camera.quaternion);
      b.pick.quaternion.copy(this.camera.quaternion); // billboard pick disks/rings
    }
    // Draw closer balls on top.
    const ordered = this.balls
      .map((b) => ({ b, z: b.mesh.position.clone().applyMatrix4(this.camera.matrixWorldInverse).z }))
      .sort((p, q) => q.z - p.z);
    ordered.forEach((o, i) => (o.b.mesh.renderOrder = 2 + i));

    // Render into the gizmo's OWN canvas (own space, always on top).
    this.hudRenderer.render(this.scene, this.camera);
  }
}

// ---------- button icons (inline SVG) ----------

const ICON_ZOOM_IN = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
  <circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5 L14 14"/><path d="M7 4.8 V9.2 M4.8 7 H9.2"/></svg>`;
const ICON_ZOOM_OUT = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
  <circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5 L14 14"/><path d="M4.8 7 H9.2"/></svg>`;
const ICON_PERSP = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
  <path d="M2 3.5 L14 2 V14 L2 12.5 Z"/><path d="M5.5 3.1 V12.9 M9 2.7 V13.3"/></svg>`;
const ICON_ORTHO = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
  <rect x="2.5" y="2.5" width="11" height="11"/><path d="M6 2.5 V13.5 M9.5 2.5 V13.5"/></svg>`;
