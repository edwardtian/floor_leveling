import * as THREE from 'three';
import type { Editor } from './editor';
import type { MeshData, Segment, Segmentation, SegAxis, SegmentSettings } from './types';
import { buildSegmentation, getAdjacency, segmentVertices, trianglesBBox, invalidateTopologyCache } from './segmentUtils';
import { selectionFalloff, weldedVertexWeights } from './falloff';
import { applyTransformToVertices, DEFAULT_TRANSFORM, TransformValues, transformChanged } from './transform';
import type { History } from './history';

const SEG_COLORS = [
  0x4f8cff, 0x35c46f, 0xe0a53f, 0xe05555, 0x9b59d0, 0x2fb9b9,
  0xd07a2f, 0x7ac74f, 0xd04f8c, 0x4fd0c7, 0xc7b14f, 0x8c4fd0,
];

/**
 * Segment tool (R4): slice the mesh into an N×M grid on two chosen axes,
 * per-triangle assignment (no cracks), color the cells, select cells by click
 * or drag-rect, then move the selection with a gizmo (rigid block, Q3) with a
 * smooth falloff band at the borders.
 */
export class SegmentTool {
  active = false;
  segmentation: Segmentation | null = null;

  settings: SegmentSettings = {
    axisA: 'x',
    axisB: 'z',
    countA: 4,
    countB: 4,
    falloffRatio: 0.25,
  };

  private editor: Editor;
  private history: History;
  private getMesh: () => MeshData | null;
  private onChanged: () => void;

  private overlayMesh: THREE.Mesh | null = null;
  private overlayGeo: THREE.BufferGeometry | null = null;
  private overlayColorAttr: THREE.BufferAttribute | null = null;
  private overlaySource: THREE.Mesh | null = null;

  // Live gizmo drag state
  private dragPivot = new THREE.Vector3();
  private dragStart = new THREE.Vector3();
  private dragStartQuat = new THREE.Quaternion();
  private dragMode: 'translate' | 'rotate' | 'scale' | null = null;
  private basePositions: Float32Array | null = null;
  private affectedVerts: number[] = [];
  private affectedTris: number[] = [];
  private baseBBox = new THREE.Box3();
  private vertexWeights: Float32Array | null = null;
  private pendingTransform: TransformValues = { ...DEFAULT_TRANSFORM };

  constructor(editor: Editor, history: History, getMesh: () => MeshData | null, onChanged: () => void) {
    this.editor = editor;
    this.history = history;
    this.getMesh = getMesh;
    this.onChanged = onChanged;
    // TransformControls requires the attached object to live in the scene graph.
    this.gizmoProxy.name = 'SegmentGizmoProxy';
    editor.scene.add(this.gizmoProxy);
  }

  setActive(v: boolean): void {
    this.active = v;
    if (!v) {
      this.clearOverlay();
      this.editor.detachGizmo();
    }
  }

  /** (Re)build segmentation for the mesh. */
  rebuild(): { segments: Segment[]; triToSegment: Int32Array } | null {
    const mesh = this.getMesh();
    if (!mesh) return null;
    const { triToSegment, segCount, minA, minB, spanA, spanB } = buildSegmentation(
      mesh, this.settings.axisA, this.settings.axisB, this.settings.countA, this.settings.countB, this.settings.falloffRatio,
    );
    const segments: Segment[] = [];
    const perSegTris: number[][] = Array.from({ length: segCount }, () => []);
    for (let t = 0; t < triToSegment.length; t++) {
      const s = triToSegment[t];
      if (s >= 0) perSegTris[s].push(t);
    }
    for (let id = 0; id < segCount; id++) {
      const triangles = perSegTris[id];
      const vertexSet = new Set<number>();
      const idx = mesh.index;
      for (const t of triangles) {
        for (let k = 0; k < 3; k++) {
          const vi = idx ? idx[t * 3 + k] : t * 3 + k;
          vertexSet.add(vi);
        }
      }
      segments.push({
        id,
        ia: Math.floor(id / this.settings.countB),
        ib: id % this.settings.countB,
        triangles,
        vertexSet,
        bbox: trianglesBBox(mesh, triangles),
      });
    }
    this.segmentation = {
      meshUuid: mesh.object.uuid,
      settings: { ...this.settings },
      segments,
      triToSegment,
      selected: new Set(),
      falloffHops: 0,
      minA, minB, spanA, spanB,
    };
    // Falloff for *segment deformation* = per-cell border band (R4 smooth falloff).
    this.segmentation.falloffHops = this.computeFalloffHops(mesh);
    this.paintOverlay(mesh);
    this.onChanged();
    return { segments, triToSegment };
  }

  /** Band width in hops ≈ falloffRatio × average cell "radius" (in hops). */
  private computeFalloffHops(mesh: MeshData): number {
    const seg = this.segmentation!;
    const owned = seg.segments.filter((s) => s.triangles.length > 0);
    if (owned.length === 0) return 0;
    const avgTriPerCell = owned.reduce((s, x) => s + x.triangles.length, 0) / owned.length;
    // Radius of a disc with that many triangles ≈ sqrt(tris/π); border band is a ring.
    const hops = Math.sqrt(avgTriPerCell / Math.PI) * this.settings.falloffRatio;
    return Math.max(1, Math.round(hops));
  }

  // ---------- overlay ----------

  private paintOverlay(mesh: MeshData): void {
    const seg = this.segmentation;
    if (!seg) return;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const indexAttr = mesh.geometry.getIndex();

    if (!this.overlayMesh || this.overlaySource !== mesh.object) {
      this.clearOverlay();
      this.overlayGeo = new THREE.BufferGeometry();
      // Share the LIVE position/index attributes so the overlay follows edits.
      this.overlayGeo.setAttribute('position', pos);
      if (indexAttr) this.overlayGeo.setIndex(indexAttr);
      const colors = new Float32Array(pos.count * 3).fill(0.5);
      this.overlayColorAttr = new THREE.BufferAttribute(colors, 3);
      this.overlayGeo.setAttribute('color', this.overlayColorAttr);
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        side: THREE.DoubleSide,
      });
      this.overlayMesh = new THREE.Mesh(this.overlayGeo, mat);
      this.overlayMesh.renderOrder = 3;
      this.overlayMesh.frustumCulled = false;
      this.overlayMesh.raycast = () => {}; // not pickable
      this.editor.overlayGroup.add(this.overlayMesh);
      this.overlaySource = mesh.object;
    }

    // Color per segment (vertex colors).
    const colors = this.overlayColorAttr!.array as Float32Array;
    colors.fill(0);
    const c = new THREE.Color();
    const idx = mesh.index;
    const selected = seg.selected;
    for (let t = 0; t < seg.triToSegment.length; t++) {
      const sid = seg.triToSegment[t];
      if (sid < 0) continue;
      const isSel = selected.has(sid);
      c.setHex(SEG_COLORS[sid % SEG_COLORS.length]);
      const boost = isSel ? 1.6 : 1;
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx[t * 3 + k] : t * 3 + k;
        colors[vi * 3] = Math.min(1, c.r * boost);
        colors[vi * 3 + 1] = Math.min(1, c.g * boost);
        colors[vi * 3 + 2] = Math.min(1, c.b * boost);
      }
    }
    this.overlayColorAttr!.needsUpdate = true;
  }

  clearOverlay(): void {
    if (this.overlayMesh) {
      this.editor.overlayGroup.remove(this.overlayMesh);
      (this.overlayMesh.material as THREE.Material).dispose();
      this.overlayMesh = null;
      this.overlayGeo = null; // shared attributes — do not dispose
      this.overlayColorAttr = null;
      this.overlaySource = null;
    }
  }

  /** Refresh overlay colors after selection change (without rebuilding). */
  repaint(): void {
    const mesh = this.getMesh();
    if (mesh) this.paintOverlay(mesh);
  }

  // ---------- selection ----------

  select(ids: Iterable<number>, additive: boolean): void {
    const seg = this.segmentation;
    if (!seg) return;
    if (!additive) seg.selected.clear();
    for (const id of ids) {
      if (seg.segments[id]?.triangles.length) seg.selected.add(id);
    }
    this.repaint();
    this.onChanged();
  }

  selectAll(): void {
    const seg = this.segmentation;
    if (!seg) return;
    seg.selected.clear();
    for (const s of seg.segments) if (s.triangles.length) seg.selected.add(s.id);
    this.repaint();
    this.onChanged();
  }

  clearSelection(): void {
    this.segmentation?.selected.clear();
    this.repaint();
    this.onChanged();
  }

  /** Segment id under cursor (from raycast triangle), or undefined. */
  segmentAt(ndc: THREE.Vector2): { mesh: MeshData; segmentId: number } | null {
    const mesh = this.getMesh();
    if (!mesh || !this.segmentation) return null;
    const hit = this.editor.raycastModel(ndc);
    if (!hit) return null;
    // find our mesh data by uuid
    const md = mesh.object === hit.object ? mesh : null;
    if (!md) return null;
    const sid = this.segmentation.triToSegment[hit.faceIndex];
    if (sid === undefined || sid < 0) return null;
    return { mesh: md, segmentId: sid };
  }

  /** Segments inside a screen drag rect (via projecting samples onto the grid axes). */
  segmentsInRect(rect: { x0: number; y0: number; x1: number; y1: number }): number[] {
    const seg = this.segmentation;
    if (!seg) return [];
    const ids = new Set<number>();
    const pts = this.editor.sampleRectNdc(rect, 12);
    const gridH = seg.settings.axisB === 'y' || seg.settings.axisA === 'y'
      ? (seg.settings.axisA === 'y' ? seg.settings.axisB : seg.settings.axisA)
      : null;
    // Use the camera-facing vertical plane through the segment bbox center when
    // a Y axis is involved; otherwise the horizontal plane through bbox center.
    const bb = seg.segments.reduce((acc, s) => {
      if (s.triangles.length) acc.union(s.bbox);
      return acc;
    }, new THREE.Box3());
    const centerY = bb.isEmpty() ? 0 : bb.getCenter(new THREE.Vector3()).y;

    for (const ndc of pts) {
      const p = gridH ? this.editor.verticalPlanePoint(ndc, new THREE.Vector3(0, centerY, 0)) : this.editor.planePoint(ndc, centerY);
      if (!p) continue;
      const fa = (p[seg.settings.axisA] - seg.minA) / seg.spanA;
      const fb = (p[seg.settings.axisB] - seg.minB) / seg.spanB;
      if (fa < -0.02 || fa > 1.02 || fb < -0.02 || fb > 1.02) continue;
      const ia = Math.min(seg.settings.countA - 1, Math.max(0, Math.floor(fa * seg.settings.countA)));
      const ib = Math.min(seg.settings.countB - 1, Math.max(0, Math.floor(fb * seg.settings.countB)));
      const id = ia * seg.settings.countB + ib;
      if (seg.segments[id]?.triangles.length) ids.add(id);
    }
    return [...ids];
  }

  // ---------- gizmo manipulation ----------

  /** Gizmo proxy sits at the selection pivot; drag deltas fold into vertex edits. */
  readonly gizmoProxy = new THREE.Object3D();
  gizmoMode: 'translate' | 'rotate' | 'scale' = 'translate';

  setGizmoMode(mode: 'translate' | 'rotate' | 'scale'): void {
    this.gizmoMode = mode;
    if (this.active && this.segmentation && this.segmentation.selected.size > 0) {
      this.attachSelectionGizmo();
    }
  }

  /** Attach the gizmo at the selection's pivot (bbox center of selected segments). */
  attachSelectionGizmo(): void {
    const mesh = this.getMesh();
    const seg = this.segmentation;
    if (!mesh || !seg || seg.selected.size === 0) {
      this.editor.detachGizmo();
      return;
    }
    this.gizmoProxy.position.copy(this.selectionPivot());
    this.gizmoProxy.quaternion.identity();
    this.gizmoProxy.scale.set(1, 1, 1);
    this.editor.attachGizmo(this.gizmoProxy, this.gizmoMode, 'world');
  }

  selectionPivot(): THREE.Vector3 {
    const seg = this.segmentation;
    const box = new THREE.Box3();
    for (const s of seg?.segments ?? []) {
      if (seg!.selected.has(s.id)) box.union(s.bbox);
    }
    return box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  }

  beginGizmoDrag(): void {
    const mesh = this.getMesh();
    const seg = this.segmentation;
    if (!mesh || !seg || seg.selected.size === 0) return;

    this.dragMode = this.gizmoMode;
    this.dragPivot.copy(this.selectionPivot());
    this.dragStart.copy(this.gizmoProxy.position);
    this.dragStartQuat.copy(this.gizmoProxy.quaternion);
    this.pendingTransform = { ...DEFAULT_TRANSFORM };

    // Affected triangles = union of selected segments.
    this.affectedTris = [];
    for (const s of seg.segments) {
      if (seg.selected.has(s.id)) this.affectedTris.push(...s.triangles);
    }
    // Vertex list + weights from selection falloff (Q1: smooth band),
    // welded across duplicated vertices so the band deforms without cracks.
    const adj = getAdjacency(mesh);
    const triW = selectionFalloff(adj, new Set(this.affectedTris), seg.falloffHops);
    const vw = weldedVertexWeights(mesh, this.affectedTris, triW);
    this.vertexWeights = vw;
    this.affectedVerts = [];
    for (let v = 0; v < vw.length; v++) if (vw[v] > 0) this.affectedVerts.push(v);

    // Snapshot base positions for live preview.
    this.basePositions = new Float32Array((mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array);
    mesh.geometry.computeBoundingBox();
    this.baseBBox.copy(mesh.geometry.boundingBox!);
  }

  handlesGizmo(obj: THREE.Object3D): boolean {
    return obj === this.gizmoProxy;
  }

  /** Update live preview from the gizmo proxy's transform delta. */
  updateGizmoDrag(): void {
    if (!this.dragMode || !this.basePositions) return;
    const mesh = this.getMesh();
    if (!mesh) return;

    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const base = this.basePositions;
    const w = this.vertexWeights!;
    const p = this.dragPivot;
    const q = this.dragStartQuat;
    const g = this.gizmoProxy;

    if (this.dragMode === 'translate') {
      const dt = new THREE.Vector3().subVectors(g.position, this.dragStart);
      for (const vi of this.affectedVerts) {
        const k = w[vi];
        arr[vi * 3] = base[vi * 3] + dt.x * k;
        arr[vi * 3 + 1] = base[vi * 3 + 1] + dt.y * k;
        arr[vi * 3 + 2] = base[vi * 3 + 2] + dt.z * k;
      }
      this.pendingTransform = { ...DEFAULT_TRANSFORM, tx: dt.x, ty: dt.y, tz: dt.z };
    } else if (this.dragMode === 'rotate') {
      const qDelta = g.quaternion.clone().multiply(q.clone().invert());
      const m = new THREE.Matrix4().makeRotationFromQuaternion(qDelta);
      const v = new THREE.Vector3();
      for (const vi of this.affectedVerts) {
        const k = w[vi];
        v.set(base[vi * 3] - p.x, base[vi * 3 + 1] - p.y, base[vi * 3 + 2] - p.z).applyMatrix4(m);
        arr[vi * 3] = p.x + v.x * k + base[vi * 3] * (1 - k);
        arr[vi * 3 + 1] = p.y + v.y * k + base[vi * 3 + 1] * (1 - k);
        arr[vi * 3 + 2] = p.z + v.z * k + base[vi * 3 + 2] * (1 - k);
      }
      const e = new THREE.Euler().setFromQuaternion(qDelta, 'XYZ');
      this.pendingTransform = {
        ...DEFAULT_TRANSFORM,
        rotX: THREE.MathUtils.radToDeg(e.x),
        rotY: THREE.MathUtils.radToDeg(e.y),
        rotZ: THREE.MathUtils.radToDeg(e.z),
      };
    } else {
      // Scale about pivot, per-axis from gizmo proxy scale.
      const s = g.scale;
      for (const vi of this.affectedVerts) {
        const k = w[vi];
        const bx = base[vi * 3], by = base[vi * 3 + 1], bz = base[vi * 3 + 2];
        arr[vi * 3] = p.x + (bx - p.x) * s.x * k + bx * (1 - k);
        arr[vi * 3 + 1] = p.y + (by - p.y) * s.y * k + by * (1 - k);
        arr[vi * 3 + 2] = p.z + (bz - p.z) * s.z * k + bz * (1 - k);
      }
      this.pendingTransform = { ...DEFAULT_TRANSFORM, sx: s.x, sy: s.y, sz: s.z };
    }
    pos.needsUpdate = true;
    mesh.geometry.computeBoundingBox();
    mesh.geometry.computeBoundingSphere();
  }

  /** Commit the drag as an undoable command; returns false if nothing changed. */
  endGizmoDrag(): boolean {
    if (!this.dragMode || !this.basePositions) return false;
    const mesh = this.getMesh();
    if (!mesh) return false;

    const t = this.pendingTransform;
    const changed = transformChanged(t);
    const base = this.basePositions;
    const affected = this.affectedVerts;
    const mode = this.dragMode;
    const pivotSnapshot = this.dragPivot.clone();

    if (changed) {
      const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      const undo = () => {
        for (const vi of affected) {
          arr[vi * 3] = base[vi * 3];
          arr[vi * 3 + 1] = base[vi * 3 + 1];
          arr[vi * 3 + 2] = base[vi * 3 + 2];
        }
        pos.needsUpdate = true;
        mesh.geometry.computeBoundingBox();
        mesh.geometry.computeBoundingSphere();
      };
      const redo = () => {
        applyTransformToVertices(mesh, t, affected, pivotSnapshot.clone());
      };
      this.history.push({ name: `Segment ${mode}`, undo, redo });
    }

    this.dragMode = null;
    this.basePositions = null;
    this.affectedVerts = [];
    this.affectedTris = [];
    this.vertexWeights = null;
    this.attachSelectionGizmo(); // re-seat proxy at pivot
    this.onChanged();
    return changed;
  }

  /** Numeric entry: apply transform to selection directly (as a command). */
  applyNumeric(t: TransformValues, pivot: THREE.Vector3): boolean {
    const mesh = this.getMesh();
    const seg = this.segmentation;
    if (!mesh || !seg || seg.selected.size === 0 || !transformChanged(t)) return false;

    const tris: number[] = [];
    for (const s of seg.segments) if (seg.selected.has(s.id)) tris.push(...s.triangles);
    const adj = getAdjacency(mesh);
    const triW = selectionFalloff(adj, new Set(tris), seg.falloffHops);
    const vw = weldedVertexWeights(mesh, tris, triW);
    const affected: number[] = [];
    for (let v = 0; v < vw.length; v++) if (vw[v] > 0) affected.push(v);

    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const before = new Float32Array(pos.array as Float32Array);

    // Pivot-adjusted matrix: build values with pivot override.
    const moved = new Set(affected);
    applyNumericWithPivot(mesh, t, pivot, moved);

    const after = new Float32Array(pos.array as Float32Array);
    const undo = () => {
      (pos.array as Float32Array).set(before);
      pos.needsUpdate = true;
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
    };
    const redo = () => {
      (pos.array as Float32Array).set(after);
      pos.needsUpdate = true;
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
    };
    this.history.push({ name: 'Segment numeric transform', undo, redo });
    this.onChanged();
    return true;
  }

  get selectedIds(): number[] {
    return this.segmentation ? [...this.segmentation.selected].sort((a, b) => a - b) : [];
  }

  get segCount(): number {
    if (!this.segmentation) return 0;
    return this.segmentation.segments.filter((s) => s.triangles.length > 0).length;
  }
}

/** Apply transform values to a set of vertices around an explicit pivot. */
function applyNumericWithPivot(mesh: MeshData, t: TransformValues, pivot: THREE.Vector3, verts: Set<number>): void {
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(t.rotX),
    THREE.MathUtils.degToRad(t.rotY),
    THREE.MathUtils.degToRad(t.rotZ),
    'XYZ',
  );
  const m = new THREE.Matrix4()
    .makeTranslation(t.tx, t.ty, t.tz)
    .multiply(new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z))
    .multiply(new THREE.Matrix4().makeRotationFromEuler(euler))
    .multiply(new THREE.Matrix4().makeScale(t.sx, t.sy, t.sz))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const v = new THREE.Vector3();
  for (const vi of verts) {
    v.set(arr[vi * 3], arr[vi * 3 + 1], arr[vi * 3 + 2]).applyMatrix4(m);
    arr[vi * 3] = v.x;
    arr[vi * 3 + 1] = v.y;
    arr[vi * 3 + 2] = v.z;
  }
  pos.needsUpdate = true;
  mesh.geometry.computeBoundingBox();
  mesh.geometry.computeBoundingSphere();
}
