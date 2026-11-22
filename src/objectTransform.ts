import * as THREE from 'three';
import type { Editor } from './editor';
import { DEFAULT_TRANSFORM, TransformValues, planarScaleRatios, transformChanged } from './transform';
import { t } from './i18n';
import type { History } from './history';

/**
 * Pending node transform for tool objects (floor plane, reference image):
 * the same preview-then-apply workflow the model's Transform tool uses.
 * The gizmo drives a proxy; deltas fold into `pending`; the node previews the
 * combined matrix (base ∘ pending); Apply bakes into the node (undoable);
 * Reset discards the pending part. Pivot = the node's own origin.
 */
export class PendingNodeTransform {
  pending: TransformValues = { ...DEFAULT_TRANSFORM };
  readonly proxy = new THREE.Object3D();

  private editor: Editor;
  private history: History | null;
  private onChanged: () => void;
  private base = {
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    scale: new THREE.Vector3(1, 1, 1),
  };
  private dragStart: {
    q: THREE.Quaternion;
    s: THREE.Vector3;
    p: THREE.Vector3;
    pending: TransformValues;
  } | null = null;
  /** Mode the proxy is currently attached with (for re-seating). */
  private gizmoMode: 'translate' | 'rotate' | 'scale' = 'translate';
  /** Space used by the current gizmo (ref image uses local for 2D rotate/scale). */
  private gizmoSpace: 'world' | 'local' = 'world';
  private changeListeners: (() => void)[] = [];

  constructor(editor: Editor, history: History | null, onChanged: () => void, proxyName: string) {
    this.editor = editor;
    this.history = history;
    this.onChanged = onChanged;
    this.proxy.name = proxyName;
    editor.scene.add(this.proxy);
  }

  /** Subscribe to preview/apply/reset (used to mirror the pending state). */
  addChangeListener(fn: () => void): void {
    this.changeListeners.push(fn);
  }

  private notifyChanged(): void {
    for (const fn of this.changeListeners) fn();
  }

  /** Snapshot the node's current TRS as the baked base (clears pending). */
  captureBase(): void {
    this.base.pos.copy(this.node.position);
    this.base.quat.copy(this.node.quaternion);
    this.base.scale.copy(this.node.scale);
    Object.assign(this.pending, DEFAULT_TRANSFORM);
  }

  /**
   * Re-snapshot the node's TRS as base while KEEPING the pending transform —
   * it continues to ride on top of the new base (re-previews). Used when
   * object parameters (floor size/center, image size) are edited: those write
   * the base, never bake the pending gizmo transform.
   */
  refreshBase(): void {
    this.base.pos.copy(this.node.position);
    this.base.quat.copy(this.node.quaternion);
    this.base.scale.copy(this.node.scale);
    if (this.hasPending) this.preview();
  }

  private get node(): THREE.Object3D {
    return this.proxy.userData.targetNode as THREE.Object3D;
  }

  /** Point the helper at a node (and capture its current TRS as base). */
  setTarget(node: THREE.Object3D): void {
    this.proxy.userData.targetNode = node;
    this.captureBase();
  }

  get hasPending(): boolean {
    return transformChanged(this.pending);
  }

  /** M = T(base.pos + t) · R_pend · R_base · S_pend ∘ S_base (about node origin). */
  private matrixFromPending(): THREE.Matrix4 {
    const t = this.pending;
    const e = new THREE.Euler(
      THREE.MathUtils.degToRad(t.rotX),
      THREE.MathUtils.degToRad(t.rotY),
      THREE.MathUtils.degToRad(t.rotZ),
      'XYZ',
    );
    const qPend = new THREE.Quaternion().setFromEuler(e);
    const sPend = new THREE.Vector3(t.sx, t.sy, t.sz);
    const m = new THREE.Matrix4()
      .makeTranslation(this.base.pos.x + t.tx, this.base.pos.y + t.ty, this.base.pos.z + t.tz)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(qPend.multiply(this.base.quat)))
      .multiply(new THREE.Matrix4().scale(sPend.multiply(this.base.scale)));
    return m;
  }

  /** Show pending via the node matrix (node TRS untouched). */
  preview(): void {
    const n = this.node;
    if (!n) return;
    n.matrixAutoUpdate = false;
    n.matrix.copy(this.matrixFromPending());
    n.matrixWorldNeedsUpdate = true;
    this.syncGizmoIfIdle();
    this.notifyChanged();
  }

  /** Restore direct TRS control (used by reset). */
  private clearPreview(): void {
    const n = this.node;
    if (!n) return;
    n.matrixAutoUpdate = true;
    n.position.copy(this.base.pos);
    n.quaternion.copy(this.base.quat);
    n.scale.copy(this.base.scale);
    n.updateMatrix();
  }

  /**
   * Re-seat the proxy on the PREVIEWED pivot/orientation while no drag is in
   * flight. Scale mode in TransformControls is local-space, so a world-aligned
   * proxy would scale along the wrong axes once the object is rotated.
   */
  private syncGizmoIfIdle(): void {
    if (this.editor.gizmoDraggingNow) return;
    if (this.editor.gizmo.object !== this.proxy) return;
    this.attachGizmo(this.gizmoMode);
  }

  /** Gizmo attach at the previewed pivot, oriented to the previewed rotation. */
  attachGizmo(mode: 'translate' | 'rotate' | 'scale', space: 'world' | 'local' = this.gizmoSpace): void {
    const n = this.node;
    if (!n) return;
    this.gizmoMode = mode;
    this.gizmoSpace = space;
    const trs = this.previewedTRS();
    this.proxy.position.copy(trs.pos);
    this.proxy.quaternion.copy(this.previewedQuaternion());
    this.proxy.scale.set(1, 1, 1);
    this.editor.attachGizmo(this.proxy, mode, space);
  }

  detachGizmo(): void {
    this.editor.detachGizmo();
  }

  /** Call on gizmo drag start (before TransformControls moves the proxy). */
  onGizmoStart(): void {
    this.dragStart = {
      q: this.proxy.quaternion.clone(),
      s: this.proxy.scale.clone(),
      p: this.proxy.position.clone(),
      pending: { ...this.pending },
    };
  }

  /** Call on every gizmo objectChange; folds the proxy delta into pending. */
  onGizmoChange(mode: 'translate' | 'rotate' | 'scale'): void {
    const ds = this.dragStart;
    if (!ds) this.onGizmoStart();
    const start = this.dragStart!;
    if (mode === 'rotate') {
      const qDelta = this.proxy.quaternion.clone().multiply(start.q.clone().invert());
      const e0 = new THREE.Euler(
        THREE.MathUtils.degToRad(start.pending.rotX),
        THREE.MathUtils.degToRad(start.pending.rotY),
        THREE.MathUtils.degToRad(start.pending.rotZ),
        'XYZ',
      );
      const qNew = qDelta.multiply(new THREE.Quaternion().setFromEuler(e0));
      const eNew = new THREE.Euler().setFromQuaternion(qNew, 'XYZ');
      this.pending.rotX = THREE.MathUtils.radToDeg(eNew.x);
      this.pending.rotY = THREE.MathUtils.radToDeg(eNew.y);
      this.pending.rotZ = THREE.MathUtils.radToDeg(eNew.z);
    } else if (mode === 'translate') {
      this.pending.tx = start.pending.tx + (this.proxy.position.x - start.p.x);
      this.pending.ty = start.pending.ty + (this.proxy.position.y - start.p.y);
      this.pending.tz = start.pending.tz + (this.proxy.position.z - start.p.z);
    } else {
      // TransformControls starts each drag from the proxy's CURRENT scale
      // (object.scale = _scaleStart * dragFactor). pending must therefore
      // multiply by the drag RATIO, not by the absolute proxy scale —
      // otherwise consecutive drags compound (2× then 1.5× became 6×).
      const rx = start.s.x !== 0 ? this.proxy.scale.x / start.s.x : 1;
      const ry = start.s.y !== 0 ? this.proxy.scale.y / start.s.y : 1;
      const rz = start.s.z !== 0 ? this.proxy.scale.z / start.s.z : 1;
      const r = planarScaleRatios(this.editor.gizmo.axis, rx, ry, rz);
      this.pending.sx = start.pending.sx * r.x;
      this.pending.sy = start.pending.sy * r.y;
      this.pending.sz = start.pending.sz * r.z;
    }
    this.preview();
    this.onChanged();
  }

  /** Bake pending into the node TRS (undoable when history is provided). */
  apply(): boolean {
    const n = this.node;
    if (!n || !this.hasPending) return false;
    const before = {
      pos: n.position.clone(), quat: n.quaternion.clone(), scale: n.scale.clone(),
    };
    const m = this.matrixFromPending();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    m.decompose(pos, quat, scale);
    n.position.copy(pos);
    n.quaternion.copy(quat);
    n.scale.copy(scale);
    n.matrixAutoUpdate = true;
    n.updateMatrix();
    this.captureBase();

    if (this.history) {
      const after = { pos: pos.clone(), quat: quat.clone(), scale: scale.clone() };
      const applyTRS = (trs: typeof after) => {
        n.position.copy(trs.pos);
        n.quaternion.copy(trs.quat);
        n.scale.copy(trs.scale);
        n.updateMatrix();
        this.captureBase();
        this.syncGizmoIfIdle();
      };
      this.history.push({
        name: t('history.applyTransform'),
        undo: () => applyTRS(before),
        redo: () => applyTRS(after),
      });
    }
    this.syncGizmoIfIdle();
    this.onChanged();
    return true;
  }

  /** Discard pending (node returns to its baked base). */
  reset(): void {
    if (!this.hasPending) return;
    Object.assign(this.pending, DEFAULT_TRANSFORM);
    this.clearPreview();
    this.syncGizmoIfIdle();
    this.onChanged();
  }

  /**
   * Force pending to the given values (numeric entry) and preview.
   */
  setPending(t: TransformValues): void {
    Object.assign(this.pending, t);
    this.preview();
    this.onChanged();
  }

  // ---------- previewed-state views (single source for ALL field panels) ----------

  /** The node's local matrix including pending (base ∘ pending). */
  previewedMatrix(): THREE.Matrix4 {
    if (this.hasPending) return this.matrixFromPending();
    const n = this.node;
    // TRS is authoritative when no preview is armed; make sure the local
    // matrix reflects direct TRS writes (loadImage, updatePlane, tests).
    if (n && n.matrixAutoUpdate) n.updateMatrix();
    return n ? n.matrix : new THREE.Matrix4();
  }

  /** Previewed world orientation (base ∘ pending). */
  previewedQuaternion(): THREE.Quaternion {
    const q = new THREE.Quaternion();
    this.previewedMatrix().decompose(new THREE.Vector3(), q, new THREE.Vector3());
    return q;
  }

  /** Previewed TRS: position, rotation (deg, XYZ Euler), scale. */
  previewedTRS(): { pos: THREE.Vector3; rotDeg: THREE.Euler; scale: THREE.Vector3 } {
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    this.previewedMatrix().decompose(pos, quat, scale);
    const rotDeg = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
    return { pos, rotDeg, scale };
  }

  /**
   * Set the PREVIEWED world position (axes not given are preserved) by
   * deriving the pending translation: t = desired − base.pos.
   */
  setWorldPosition(part?: { x?: number; y?: number; z?: number }): void {
    const cur = this.previewedTRS().pos;
    const want = new THREE.Vector3(
      part?.x ?? cur.x,
      part?.y ?? cur.y,
      part?.z ?? cur.z,
    );
    this.pending.tx = want.x - this.base.pos.x;
    this.pending.ty = want.y - this.base.pos.y;
    this.pending.tz = want.z - this.base.pos.z;
    this.preview();
    this.onChanged();
  }

  /**
   * Set the PREVIEWED scale (componentwise; unspecified axes preserved):
   * pending.s = desired / base.s.
   */
  setWorldScale(part?: { x?: number; y?: number; z?: number }): void {
    const cur = this.previewedTRS().scale;
    const want = new THREE.Vector3(
      part?.x ?? cur.x,
      part?.y ?? cur.y,
      part?.z ?? cur.z,
    );
    this.pending.sx = this.base.scale.x !== 0 ? want.x / this.base.scale.x : 1;
    this.pending.sy = this.base.scale.y !== 0 ? want.y / this.base.scale.y : 1;
    this.pending.sz = this.base.scale.z !== 0 ? want.z / this.base.scale.z : 1;
    this.preview();
    this.onChanged();
  }

  /**
   * Set the PREVIEWED rotation (deg, XYZ Euler; unspecified axes preserved):
   * q_pend = q_desired · q_base⁻¹.
   */
  setWorldRotationDeg(part?: { x?: number; y?: number; z?: number }): void {
    const cur = this.previewedTRS().rotDeg;
    const e = new THREE.Euler(
      THREE.MathUtils.degToRad(part?.x ?? THREE.MathUtils.radToDeg(cur.x)),
      THREE.MathUtils.degToRad(part?.y ?? THREE.MathUtils.radToDeg(cur.y)),
      THREE.MathUtils.degToRad(part?.z ?? THREE.MathUtils.radToDeg(cur.z)),
      'XYZ',
    );
    const qWant = new THREE.Quaternion().setFromEuler(e);
    const qPend = qWant.multiply(this.base.quat.clone().invert());
    const ePend = new THREE.Euler().setFromQuaternion(qPend, 'XYZ');
    this.pending.rotX = THREE.MathUtils.radToDeg(ePend.x);
    this.pending.rotY = THREE.MathUtils.radToDeg(ePend.y);
    this.pending.rotZ = THREE.MathUtils.radToDeg(ePend.z);
    this.preview();
    this.onChanged();
  }
}
