import * as THREE from 'three';
import type { Editor } from './editor';
import type { MeshData, PendingTransform } from './types';
import { geometryCenter } from './transform';
import type { History } from './history';

/**
 * Transform tool (R2): whole-object rotate/translate/scale with numeric
 * fields or gizmo; nothing touches the geometry until "Apply" bakes it in
 * (like Blender's Apply Transform). Pending values live in this tool; the
 * preview is shown by setting the mesh node's matrix.
 */
export class TransformTool {
  active = false;

  pending: PendingTransform = { rotX: 0, rotY: 0, rotZ: 0, tx: 0, ty: 0, tz: 0, sx: 1, sy: 1, sz: 1 };

  private editor: Editor;
  private history: History;
  private getMesh: () => MeshData | null;
  private onChanged: () => void;

  private proxy = new THREE.Object3D();
  private dragStart: {
    q: THREE.Quaternion;
    s: THREE.Vector3;
    p: THREE.Vector3;
    pending: PendingTransform;
  } | null = null;

  constructor(editor: Editor, history: History, getMesh: () => MeshData | null, onChanged: () => void) {
    this.editor = editor;
    this.history = history;
    this.getMesh = getMesh;
    this.onChanged = onChanged;

    this.proxy.name = 'TransformGizmoProxy';
    editor.scene.add(this.proxy); // TransformControls requires scene-graph membership

    this.editor.addGizmoDragStartListener(() => this.onGizmoDragStart());
    this.editor.addGizmoDragEndListener(() => this.onGizmoDragEnd());
    this.editor.gizmo.addEventListener('objectChange', () => this.onGizmoChange());
  }

  setActive(v: boolean): void {
    this.active = v;
    if (v) {
      this.attachGizmo(this.gizmoMode);
      this.preview();
    } else {
      this.editor.detachGizmo();
      this.clearPreview();
    }
    this.onChanged();
  }

  gizmoMode: 'translate' | 'rotate' | 'scale' = 'rotate';

  setGizmoMode(mode: 'translate' | 'rotate' | 'scale'): void {
    this.gizmoMode = mode;
    if (this.active) this.attachGizmo(mode);
  }

  private attachGizmo(mode: 'translate' | 'rotate' | 'scale'): void {
    const mesh = this.getMesh();
    if (!mesh) return;
    const c = geometryCenter(mesh);
    this.proxy.position.copy(c);
    this.proxy.quaternion.identity();
    this.proxy.scale.set(1, 1, 1);
    this.editor.attachGizmo(this.proxy, mode, 'world');
  }

  // ---------- pending <-> node matrix ----------

  private matrixFromPending(): THREE.Matrix4 {
    const mesh = this.getMesh();
    const t = this.pending;
    const m = new THREE.Matrix4();
    if (!mesh) return m;
    const c = geometryCenter(mesh);
    const e = new THREE.Euler(
      THREE.MathUtils.degToRad(t.rotX),
      THREE.MathUtils.degToRad(t.rotY),
      THREE.MathUtils.degToRad(t.rotZ),
      'XYZ',
    );
    m.makeTranslation(t.tx, t.ty, t.tz);
    m.multiply(new THREE.Matrix4().makeTranslation(c.x, c.y, c.z));
    m.multiply(new THREE.Matrix4().makeRotationFromEuler(e));
    m.multiply(new THREE.Matrix4().makeScale(t.sx, t.sy, t.sz));
    m.multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
    return m;
  }

  /** Show pending transform via the node matrix (geometry untouched). */
  preview(): void {
    const mesh = this.getMesh();
    if (!mesh) return;
    mesh.object.matrixAutoUpdate = false;
    mesh.object.matrix.copy(this.matrixFromPending());
    mesh.object.matrixWorldNeedsUpdate = true;
  }

  clearPreview(): void {
    const mesh = this.getMesh();
    if (!mesh) return;
    mesh.object.matrixAutoUpdate = true;
    mesh.object.position.set(0, 0, 0);
    mesh.object.rotation.set(0, 0, 0);
    mesh.object.scale.set(1, 1, 1);
    mesh.object.updateMatrix();
  }

  // ---------- gizmo ----------

  private onGizmoDragStart(): void {
    if (!this.active) return;
    this.dragStart = {
      q: this.proxy.quaternion.clone(),
      s: this.proxy.scale.clone(),
      p: this.proxy.position.clone(),
      pending: { ...this.pending },
    };
  }

  private onGizmoChange(): void {
    if (!this.active) return;
    if (!this.dragStart) {
      this.onGizmoDragStart();
      if (!this.dragStart) return;
    }
    const ds = this.dragStart;
    const mesh = this.getMesh();
    if (!mesh) return;

    if (this.gizmoMode === 'rotate') {
      // q_delta = q_now * q_start^-1, applied about the proxy center.
      const qDelta = this.proxy.quaternion.clone().multiply(ds.q.clone().invert());
      const e = new THREE.Euler().setFromQuaternion(qDelta, 'XYZ');
      const e0 = new THREE.Euler(
        THREE.MathUtils.degToRad(ds.pending.rotX),
        THREE.MathUtils.degToRad(ds.pending.rotY),
        THREE.MathUtils.degToRad(ds.pending.rotZ),
        'XYZ',
      );
      const q0 = new THREE.Quaternion().setFromEuler(e0);
      const qNew = qDelta.multiply(q0);
      const eNew = new THREE.Euler().setFromQuaternion(qNew, 'XYZ');
      this.pending.rotX = THREE.MathUtils.radToDeg(eNew.x);
      this.pending.rotY = THREE.MathUtils.radToDeg(eNew.y);
      this.pending.rotZ = THREE.MathUtils.radToDeg(eNew.z);
    } else if (this.gizmoMode === 'translate') {
      this.pending.tx = ds.pending.tx + (this.proxy.position.x - ds.p.x);
      this.pending.ty = ds.pending.ty + (this.proxy.position.y - ds.p.y);
      this.pending.tz = ds.pending.tz + (this.proxy.position.z - ds.p.z);
    } else {
      this.pending.sx = ds.pending.sx * this.proxy.scale.x;
      this.pending.sy = ds.pending.sy * this.proxy.scale.y;
      this.pending.sz = ds.pending.sz * this.proxy.scale.z;
    }
    this.preview();
    this.onChanged();
  }

  private onGizmoDragEnd(): void {
    if (!this.active || !this.dragStart) return;
    this.dragStart = null;
    // Reset proxy (its effect is folded into pending).
    this.attachGizmo(this.gizmoMode);
    this.onChanged();
  }

  // ---------- apply / reset ----------

  get hasPending(): boolean {
    const t = this.pending;
    return (
      t.rotX !== 0 || t.rotY !== 0 || t.rotZ !== 0 ||
      t.tx !== 0 || t.ty !== 0 || t.tz !== 0 ||
      t.sx !== 1 || t.sy !== 1 || t.sz !== 1
    );
  }

  /** Bake pending into geometry (undoable). */
  apply(): boolean {
    const mesh = this.getMesh();
    if (!mesh || !this.hasPending) return false;

    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const nor = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const beforePos = new Float32Array(pos.array as Float32Array);
    const beforeNor = nor ? new Float32Array(nor.array as Float32Array) : null;
    const matrix = this.matrixFromPending();

    bakeMatrix(mesh.geometry, matrix);

    const afterPos = new Float32Array(pos.array as Float32Array);
    const afterNor = nor ? new Float32Array(nor.array as Float32Array) : null;
    const pendingBefore = { ...this.pending };

    this.history.push({
      name: 'Apply transform',
      undo: () => {
        (pos.array as Float32Array).set(beforePos);
        if (nor && beforeNor) (nor.array as Float32Array).set(beforeNor);
        pos.needsUpdate = true;
        if (nor) nor.needsUpdate = true;
        mesh.geometry.computeBoundingBox();
        mesh.geometry.computeBoundingSphere();
        this.pending = { ...pendingBefore };
        this.preview();
      },
      redo: () => {
        (pos.array as Float32Array).set(afterPos);
        if (nor && afterNor) (nor.array as Float32Array).set(afterNor);
        pos.needsUpdate = true;
        if (nor) nor.needsUpdate = true;
        mesh.geometry.computeBoundingBox();
        mesh.geometry.computeBoundingSphere();
        this.pending = { rotX: 0, rotY: 0, rotZ: 0, tx: 0, ty: 0, tz: 0, sx: 1, sy: 1, sz: 1 };
        this.clearPreview();
      },
    });

    this.pending = { rotX: 0, rotY: 0, rotZ: 0, tx: 0, ty: 0, tz: 0, sx: 1, sy: 1, sz: 1 };
    this.clearPreview();
    this.onChanged();
    return true;
  }

  resetPending(): void {
    this.pending = { rotX: 0, rotY: 0, rotZ: 0, tx: 0, ty: 0, tz: 0, sx: 1, sy: 1, sz: 1 };
    this.preview();
    this.onChanged();
  }
}

/** Bake a matrix into a geometry's position + normal buffers. */
function bakeMatrix(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): void {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const nor = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const arr = pos.array as Float32Array;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    arr[i * 3] = v.x;
    arr[i * 3 + 1] = v.y;
    arr[i * 3 + 2] = v.z;
  }
  pos.needsUpdate = true;
  if (nor) {
    const nm = new THREE.Matrix3().getNormalMatrix(matrix);
    const na = nor.array as Float32Array;
    const n = new THREE.Vector3();
    for (let i = 0; i < nor.count; i++) {
      n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      na[i * 3] = n.x;
      na[i * 3 + 1] = n.y;
      na[i * 3 + 2] = n.z;
    }
    nor.needsUpdate = true;
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}
