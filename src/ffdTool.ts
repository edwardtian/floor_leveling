import * as THREE from 'three';
import type { Editor } from './editor';
import type { MeshData, FFDSettings } from './types';
import { FFDLattice } from './ffd';
import type { History } from './history';

/**
 * Free-Form Deformation tool (3ds Max style): an nx×ny×nz lattice of control
 * points wraps the whole model. Vertices keep their parametric (u,v,w) inside
 * the cage; moving/rotating/scaling selected control points re-evaluates the
 * surface smoothly — the classic FFD(box) modifier workflow. Each drag
 * commits an undoable command; other tools' edits invalidate the lattice
 * (Max's "collapse" happens implicitly).
 */
export class FFDTool {
  active = false;

  settings: FFDSettings = { nx: 3, ny: 3, nz: 3, margin: 0.05 };

  /** The live lattice, or null when not built (or invalidated). */
  lattice: FFDLattice | null = null;

  /** Selected control-point indices. */
  selected: Set<number> = new Set();

  gizmoMode: 'translate' | 'rotate' | 'scale' = 'translate';

  private editor: Editor;
  private history: History;
  private getMesh: () => MeshData | null;
  private onChanged: () => void;

  /** Vertex (u,v,w) params captured when the lattice was built. */
  private local: Float32Array | null = null;
  /** Vertex positions at lattice build time — deform always evaluates from these. */
  private restPositions: Float32Array | null = null;
  /** Cheap identity of the mesh state at build time (stale-detection). */
  private buildChecksum = '';

  // Visuals
  private cageLines: THREE.LineSegments | null = null;
  private cageGeo: THREE.BufferGeometry | null = null;
  private pointsMesh: THREE.InstancedMesh | null = null;
  private pointsGeo: THREE.BufferGeometry | null = null;

  // Gizmo drag state
  readonly gizmoProxy = new THREE.Object3D();
  private dragMode: 'translate' | 'rotate' | 'scale' | null = null;
  private dragStartCage: Float32Array | null = null;
  private dragPivot = new THREE.Vector3();
  private dragStartPos = new THREE.Vector3();
  private dragStartQuat = new THREE.Quaternion();

  constructor(editor: Editor, history: History, getMesh: () => MeshData | null, onChanged: () => void) {
    this.editor = editor;
    this.history = history;
    this.getMesh = getMesh;
    this.onChanged = onChanged;
    this.gizmoProxy.name = 'FFDGizmoProxy';
    editor.scene.add(this.gizmoProxy); // TransformControls requires scene-graph membership
  }

  // ---------- lattice lifecycle ----------

  /** Build (or rebuild) the lattice around the mesh bbox + margin. */
  build(): boolean {
    const mesh = this.getMesh();
    if (!mesh) return false;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!.clone();
    const size = bb.getSize(new THREE.Vector3());
    const m = THREE.MathUtils.clamp(this.settings.margin, 0, 0.5);
    bb.min.addScaledVector(size, -m / 2);
    bb.max.addScaledVector(size, m / 2);

    this.lattice = new FFDLattice(bb, this.settings.nx, this.settings.ny, this.settings.nz);
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.restPositions = new Float32Array(pos.array as Float32Array);
    this.local = FFDLattice.localCoordsFor(this.restPositions, bb);
    this.buildChecksum = this.meshChecksum();
    this.selected.clear();
    this.gizmoProxy.position.set(0, 0, 0);
    this.gizmoProxy.quaternion.identity();
    this.gizmoProxy.scale.set(1, 1, 1);
    this.ensureVisuals();
    this.syncVisuals();
    this.onChanged();
    return true;
  }

  /** Reset control points to the rest cage (mesh returns to build shape). */
  reset(): void {
    const mesh = this.getMesh();
    if (!mesh || !this.lattice) return;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const before = new Float32Array(pos.array as Float32Array);
    const cageBefore = new Float32Array(this.lattice.controlPoints);
    this.lattice.controlPoints.set(this.lattice.restPoints);
    this.applyDeform();
    this.syncVisuals();
    const after = new Float32Array(pos.array as Float32Array);
    const cageAfter = new Float32Array(this.lattice.controlPoints);
    const local = this.local!;
    const undo = () => {
      (pos.array as Float32Array).set(before);
      this.lattice!.controlPoints.set(cageBefore);
      this.lattice!.deform(local, pos.array as Float32Array);
      pos.needsUpdate = true;
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
      this.syncVisuals();
    };
    const redo = () => {
      (pos.array as Float32Array).set(after);
      this.lattice!.controlPoints.set(cageAfter);
      pos.needsUpdate = true;
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
      this.syncVisuals();
    };
    this.history.push({ name: 'Reset lattice', undo, redo });
    this.onChanged();
  }

  /** Drop the lattice entirely (mesh keeps its current baked shape). */
  collapse(): void {
    this.lattice = null;
    this.local = null;
    this.restPositions = null;
    this.selected.clear();
    this.disposeVisuals();
    this.editor.detachGizmo();
    this.onChanged();
  }

  /**
   * Called when another tool edits mesh vertices (floor leveling, transform
   * apply, model import/switch): the captured rest state is stale, so the
   * cage is dropped — like collapsing the modifier in Max.
   */
  invalidate(): void {
    if (this.lattice) this.collapse();
  }

  // ---------- deformation ----------

  /** Re-evaluate the mesh surface from rest positions + current cage. */
  private applyDeform(): void {
    const mesh = this.getMesh();
    if (!mesh || !this.lattice || !this.local) return;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.lattice.deform(this.local, pos.array as Float32Array);
    pos.needsUpdate = true;
    mesh.geometry.computeBoundingBox();
    mesh.geometry.computeBoundingSphere();
  }

  private pushCageHistory(name: string, _beforeCage: Float32Array, _afterCage: Float32Array): void {
    // (unused — history entries capture mesh positions; see beginGizmoDrag/reset)
  }

  // ---------- visuals ----------

  private ensureVisuals(): void {
    if (this.cageLines) return;
    const lat = this.lattice!;
    // Line cage: segments between adjacent control points along each axis.
    const segs: number[] = [];
    for (let i = 0; i < lat.nx; i++) {
      for (let j = 0; j < lat.ny; j++) {
        for (let k = 0; k < lat.nz; k++) {
          if (i + 1 < lat.nx) segs.push(lat.index(i, j, k), lat.index(i + 1, j, k));
          if (j + 1 < lat.ny) segs.push(lat.index(i, j, k), lat.index(i, j + 1, k));
          if (k + 1 < lat.nz) segs.push(lat.index(i, j, k), lat.index(i, j, k + 1));
        }
      }
    }
    this.cageGeo = new THREE.BufferGeometry();
    this.cageGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs.length * 3), 3));
    const idx = new Uint32Array(segs.length);
    for (let s = 0; s < segs.length; s++) idx[s] = segs[s];
    this.cageGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.cageLines = new THREE.LineSegments(
      this.cageGeo,
      new THREE.LineBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.cageLines.renderOrder = 5;
    this.cageLines.frustumCulled = false;
    this.editor.overlayGroup.add(this.cageLines);

    // Control points as instanced spheres (pickable via instanceId).
    this.pointsGeo = new THREE.SphereGeometry(Math.max(0.02, this.pointRadius()), 12, 8);
    this.pointsMesh = new THREE.InstancedMesh(
      this.pointsGeo,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false }),
      lat.count,
    );
    this.pointsMesh.renderOrder = 6;
    this.pointsMesh.frustumCulled = false;
    this.editor.overlayGroup.add(this.pointsMesh);
    this.paintSelection();
  }

  /** Sphere radius relative to the lattice diagonal, so points stay grabbable. */
  private pointRadius(): number {
    if (!this.lattice) return 0.05;
    const s = this.lattice.box.getSize(new THREE.Vector3()).length();
    return Math.max(0.02, s * 0.012);
  }

  private syncVisuals(): void {
    const lat = this.lattice;
    if (!lat || !this.cageLines || !this.pointsMesh) return;
    (this.cageGeo!.getAttribute('position') as THREE.BufferAttribute).array.set(lat.controlPoints);
    (this.cageGeo!.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    for (let i = 0; i < lat.count; i++) {
      v.set(lat.controlPoints[i * 3], lat.controlPoints[i * 3 + 1], lat.controlPoints[i * 3 + 2]);
      m.makeTranslation(v.x, v.y, v.z);
      this.pointsMesh.setMatrixAt(i, m);
    }
    this.pointsMesh.instanceMatrix.needsUpdate = true;
  }

  private paintSelection(): void {
    const lat = this.lattice;
    if (!lat || !this.pointsMesh) return;
    // instanceColor is created lazily by the first setColorAt call.
    this.pointsMesh.setColorAt(0, new THREE.Color(0xffffff));
    const c = new THREE.Color();
    for (let i = 0; i < lat.count; i++) {
      c.setHex(this.selected.has(i) ? 0xff5f5f : 0x9fd8ff);
      this.pointsMesh.setColorAt(i, c);
    }
    if (this.pointsMesh.instanceColor) this.pointsMesh.instanceColor.needsUpdate = true;
  }

  private disposeVisuals(): void {
    if (this.cageLines) {
      this.editor.overlayGroup.remove(this.cageLines);
      (this.cageLines.material as THREE.Material).dispose();
      this.cageGeo?.dispose();
      this.cageLines = null;
      this.cageGeo = null;
    }
    if (this.pointsMesh) {
      this.editor.overlayGroup.remove(this.pointsMesh);
      (this.pointsMesh.material as THREE.Material).dispose();
      this.pointsGeo?.dispose();
      this.pointsMesh = null;
      this.pointsGeo = null;
    }
  }

  repaint(): void {
    this.syncVisuals();
    this.paintSelection();
  }

  // ---------- picking ----------

  /** Control point under the cursor (nearest raycast hit), or -1. */
  pointAt(ndc: THREE.Vector2): number {
    if (!this.pointsMesh || !this.lattice) return -1;
    this.editor.ray.setFromCamera(ndc, this.editor.camera);
    const hits = this.editor.ray.intersectObject(this.pointsMesh, false);
    return hits.length ? hits[0].instanceId ?? -1 : -1;
  }

  /** All control points whose screen projection falls inside the rect. */
  pointsInRect(rect: { x0: number; y0: number; x1: number; y1: number }): number[] {
    const lat = this.lattice;
    if (!lat || !this.pointsMesh) return [];
    const w = this.editor.size.width;
    const h = this.editor.size.height;
    const v = new THREE.Vector3();
    const ids: number[] = [];
    for (let i = 0; i < lat.count; i++) {
      v.set(lat.controlPoints[i * 3], lat.controlPoints[i * 3 + 1], lat.controlPoints[i * 3 + 2]).project(this.editor.camera);
      const x = ((v.x + 1) / 2) * w;
      const y = ((1 - v.y) / 2) * h;
      if (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) ids.push(i);
    }
    return ids;
  }

  // ---------- selection ----------

  select(ids: Iterable<number>, additive: boolean): void {
    if (!additive) this.selected.clear();
    for (const id of ids) this.selected.add(id);
    this.paintSelection();
    this.attachSelectionGizmo();
    this.onChanged();
  }

  selectAll(): void {
    if (!this.lattice) return;
    for (let i = 0; i < this.lattice.count; i++) this.selected.add(i);
    this.paintSelection();
    this.attachSelectionGizmo();
    this.onChanged();
  }

  clearSelection(): void {
    this.selected.clear();
    this.paintSelection();
    this.editor.detachGizmo();
    this.onChanged();
  }

  // ---------- gizmo manipulation ----------

  setGizmoMode(mode: 'translate' | 'rotate' | 'scale'): void {
    this.gizmoMode = mode;
    if (this.active && this.lattice && this.selected.size > 0) this.attachSelectionGizmo();
  }

  attachSelectionGizmo(): void {
    const lat = this.lattice;
    if (!lat || this.selected.size === 0) {
      this.editor.detachGizmo();
      return;
    }
    this.gizmoProxy.position.copy(this.selectionPivot());
    this.gizmoProxy.quaternion.identity();
    this.gizmoProxy.scale.set(1, 1, 1);
    this.editor.attachGizmo(this.gizmoProxy, this.gizmoMode, 'world');
  }

  selectionPivot(): THREE.Vector3 {
    const lat = this.lattice;
    const c = new THREE.Vector3();
    if (!lat || this.selected.size === 0) return c;
    for (const id of this.selected) {
      c.x += lat.controlPoints[id * 3];
      c.y += lat.controlPoints[id * 3 + 1];
      c.z += lat.controlPoints[id * 3 + 2];
    }
    c.divideScalar(this.selected.size);
    return c;
  }

  /** Called on gizmo drag start (before the proxy moves). */
  beginGizmoDrag(): void {
    const mesh = this.getMesh();
    if (!mesh || !this.lattice || this.selected.size === 0) return;
    this.dragMode = this.gizmoMode;
    this.dragStartCage = new Float32Array(this.lattice.controlPoints);
    this.dragPivot.copy(this.selectionPivot());
    this.dragStartPos.copy(this.gizmoProxy.position);
    this.dragStartQuat.copy(this.gizmoProxy.quaternion);
    // Snapshot mesh positions under the OLD cage for history.
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    (this as unknown as { pendingBefore?: Float32Array }).pendingBefore = new Float32Array(pos.array as Float32Array);
  }

  handlesGizmo(obj: THREE.Object3D): boolean {
    return obj === this.gizmoProxy;
  }

  /** Live update while the gizmo proxy moves/rotates/scales. */
  updateGizmoDrag(): void {
    if (!this.dragMode || !this.lattice || !this.dragStartCage) return;
    const lat = this.lattice;
    const g = this.gizmoProxy;
    const p = this.dragPivot;

    if (this.dragMode === 'translate') {
      const dt = new THREE.Vector3().subVectors(g.position, this.dragStartPos);
      for (const id of this.selected) {
        lat.controlPoints[id * 3] = this.dragStartCage[id * 3] + dt.x;
        lat.controlPoints[id * 3 + 1] = this.dragStartCage[id * 3 + 1] + dt.y;
        lat.controlPoints[id * 3 + 2] = this.dragStartCage[id * 3 + 2] + dt.z;
      }
    } else if (this.dragMode === 'rotate') {
      const qDelta = g.quaternion.clone().multiply(this.dragStartQuat.clone().invert());
      const m = new THREE.Matrix4().makeRotationFromQuaternion(qDelta);
      const v = new THREE.Vector3();
      for (const id of this.selected) {
        v.set(
          this.dragStartCage[id * 3] - p.x,
          this.dragStartCage[id * 3 + 1] - p.y,
          this.dragStartCage[id * 3 + 2] - p.z,
        ).applyMatrix4(m);
        lat.controlPoints[id * 3] = p.x + v.x;
        lat.controlPoints[id * 3 + 1] = p.y + v.y;
        lat.controlPoints[id * 3 + 2] = p.z + v.z;
      }
    } else {
      const s = g.scale;
      for (const id of this.selected) {
        lat.controlPoints[id * 3] = p.x + (this.dragStartCage[id * 3] - p.x) * s.x;
        lat.controlPoints[id * 3 + 1] = p.y + (this.dragStartCage[id * 3 + 1] - p.y) * s.y;
        lat.controlPoints[id * 3 + 2] = p.z + (this.dragStartCage[id * 3 + 2] - p.z) * s.z;
      }
    }

    this.applyDeform();
    this.syncVisuals();
  }

  /** Commit the drag as an undoable command; returns false if nothing changed. */
  endGizmoDrag(): boolean {
    const mesh = this.getMesh();
    if (!this.dragMode || !this.lattice || !mesh) return false;
    const pendingBefore = (this as unknown as { pendingBefore?: Float32Array }).pendingBefore;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const after = new Float32Array(pos.array as Float32Array);
    const movedCage = !this.dragStartCage ||
      this.dragStartCage.some((v, i) => Math.abs(v - this.lattice!.controlPoints[i]) > 1e-9);

    if (movedCage && pendingBefore && this.dragStartCage) {
      const before = pendingBefore;
      const cageBefore = new Float32Array(this.dragStartCage);
      const cageAfter = new Float32Array(this.lattice.controlPoints);
      const local = this.local!;
      const undo = () => {
        (pos.array as Float32Array).set(before);
        pos.needsUpdate = true;
        mesh.geometry.computeBoundingBox();
        mesh.geometry.computeBoundingSphere();
        // Restore the cage so further edits continue from the undone state.
        this.lattice!.controlPoints.set(cageBefore);
        this.syncVisuals();
      };
      const redo = () => {
        this.lattice!.controlPoints.set(cageAfter);
        this.lattice!.deform(local, pos.array as Float32Array);
        pos.needsUpdate = true;
        mesh.geometry.computeBoundingBox();
        mesh.geometry.computeBoundingSphere();
        this.syncVisuals();
      };
      this.history.push({ name: `FFD ${this.dragMode}`, undo, redo });
    }

    (this as unknown as { pendingBefore?: Float32Array }).pendingBefore = undefined;
    this.dragMode = null;
    this.dragStartCage = null;
    this.attachSelectionGizmo();
    this.onChanged();
    return movedCage;
  }

  // ---------- tool lifecycle ----------

  setActive(v: boolean): void {
    this.active = v;
    if (v) {
      // Another tool may have edited vertices since the lattice was built
      // (transform apply, floor leveling, undo/redo) — detect and drop.
      if (this.lattice && this.buildChecksum !== this.meshChecksum()) {
        this.collapse();
        this.onChanged();
        return;
      }
      if (this.lattice) {
        this.ensureVisuals();
        this.syncVisuals();
        this.paintSelection();
        this.attachSelectionGizmo();
      }
    } else {
      this.editor.detachGizmo();
      this.disposeVisuals();
    }
  }

  /** Vertex count + bbox extent — changes when anything edits the mesh. */
  private meshChecksum(): string {
    const mesh = this.getMesh();
    if (!mesh) return '';
    mesh.geometry.computeBoundingBox();
    const b = mesh.geometry.boundingBox!;
    return [
      mesh.geometry.getAttribute('position').count,
      b.min.x.toFixed(4), b.min.y.toFixed(4), b.min.z.toFixed(4),
      b.max.x.toFixed(4), b.max.y.toFixed(4), b.max.z.toFixed(4),
    ].join('|');
  }
}
