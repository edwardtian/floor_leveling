import * as THREE from 'three';
import type { Editor } from './editor';
import type { MeshData, FloorSettings } from './types';
import { intersectFloorPlane, dropToPlane, flattenToPlane, type FloorFrame } from './leveling';
import { selectionFalloff, weldedVertexWeights } from './falloff';
import { getAdjacency } from './falloff';
import { makeTextSprite } from './editor';
import { PendingNodeTransform } from './objectTransform';
import type { History } from './history';

/**
 * Floor tool (R5–R7): a resizable/movable/rotatable plane; detect mesh faces
 * crossing/below it inside its footprint; highlight connected intersection
 * areas; select one (or several via rect) and level them: rigid "drop" or
 * "flatten" onto the plane, blended with a smooth falloff at the region
 * border. The plane carries a full transform (Translate/Rotate/Scale gizmo) —
 * a tilted plane levels along its own normal.
 */
export class FloorTool {
  active = false;

  settings: FloorSettings = { sizeX: 2, sizeZ: 2, y: 0, cx: 0, cz: 0 };

  /** Current gizmo mode for the floor plane. */
  gizmoMode: 'translate' | 'rotate' | 'scale' = 'translate';

  /** Triangle sets of the latest intersection scan (connected areas). */
  areas: { id: number; triangles: number[]; set: Set<number>; minY: number; maxY: number; count: number }[] = [];
  /** Selected area ids (multi-select supported). */
  selectedIds: Set<number> = new Set();
  /** UI visibility toggle (topbar checkbox). */
  uiVisible = true;
  lastScanMeshUuid = '';
  /** Auto-fit runs once per model (placement persists across tab switches). */
  private autoFitPending = true;

  private editor: Editor;
  private history: History;
  private getMesh: () => MeshData | null;
  private onChanged: () => void;

  /** Transform carrier — the TransformControls attach target. */
  private floorRoot: THREE.Group;
  private planeMesh: THREE.Mesh;
  private outline: THREE.LineSegments;

  /**
   * Pending node transform (preview → Apply bakes → Reset discards), exactly
   * like the model's Transform tool. Gizmo drags fold into pending; leveling
   * reads the PREVIEWED frame so what you see is what gets leveled.
   */
  readonly nodeTransform: PendingNodeTransform;

  /** Plane visuals for the topbar visibility toggle. */
  get planeVisuals(): { plane: THREE.Mesh; outline: THREE.LineSegments } {
    return { plane: this.planeMesh, outline: this.outline };
  }
  private hitMesh: THREE.Mesh | null = null;
  private hitGeo: THREE.BufferGeometry | null = null;
  private hitColor: THREE.BufferAttribute | null = null;
  private hitSource: THREE.Mesh | null = null;

  constructor(editor: Editor, history: History, getMesh: () => MeshData | null, onChanged: () => void) {
    this.editor = editor;
    this.history = history;
    this.getMesh = getMesh;
    this.onChanged = onChanged;

    this.floorRoot = new THREE.Group();
    this.floorRoot.name = 'FloorPlane';
    this.editor.overlayGroup.add(this.floorRoot);
    this.nodeTransform = new PendingNodeTransform(editor, history, onChanged, 'FloorTransformProxy');
    this.nodeTransform.setTarget(this.floorRoot);

    const planeMat = new THREE.MeshBasicMaterial({
      color: 0x2fb9b9,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.planeMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), planeMat);
    this.planeMesh.rotation.x = -Math.PI / 2; // plane local +Y = floor depth axis
    this.planeMesh.renderOrder = 2;
    this.planeMesh.raycast = () => {};
    this.floorRoot.add(this.planeMesh);

    const og = new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1));
    this.outline = new THREE.LineSegments(og, new THREE.LineBasicMaterial({ color: 0x2fb9b9, transparent: true, opacity: 0.9 }));
    this.outline.rotation.x = -Math.PI / 2;
    this.outline.renderOrder = 3;
    this.outline.raycast = () => {};
    this.floorRoot.add(this.outline);

    this.floorLabel = makeTextSprite('floor', 0x2fb9b9, new THREE.Vector3(0, 0, 0), 0.22);
    this.floorLabel.renderOrder = 6;
    this.editor.overlayGroup.add(this.floorLabel);

    // Keep `settings` a live mirror of the previewed transform, no matter
    // whether the change came from the gizmo, the Transform sub-panel, or a
    // numeric field. Otherwise a later updatePlane(true) writes stale sizes
    // and silently discards the pending scale/translation.
    this.nodeTransform.addChangeListener(() => this.syncFromGizmo());

    this.updatePlane();
  }

  private floorLabel: THREE.Sprite;

  setActive(v: boolean): void {
    const was = this.active;
    this.active = v;
    this.planeMesh.visible = v && this.uiVisible;
    this.outline.visible = v && this.uiVisible;
    this.floorRoot.visible = v;
    this.floorLabel.visible = this.planeMesh.visible;
    if (!v) {
      if (was) {
        this.editor.detachGizmo();
        this.clearHitOverlay();
        this.areas = [];
        this.selectedIds.clear();
      }
    } else {
      // Auto-fit only on the first activation per model — afterwards the
      // user's placement persists until they change it or import anew.
      // If a pending transform is armed, keep the flag set: fitting now would
      // silently do nothing (or would have to discard the pending edit).
      if (this.autoFitPending && this.fitToModel()) {
        this.autoFitPending = false;
      }
      this.nodeTransform.attachGizmo(this.gizmoMode);
      // All scale axes stay visible: hiding Y would also hide the XYZ center
      // cube, i.e. the only uniform-scale handle.
      this.editor.gizmo.showY = true;
    }
    this.updatePlane();
    this.onChanged();
  }

  setGizmoMode(mode: 'translate' | 'rotate' | 'scale'): void {
    this.gizmoMode = mode;
    if (this.active) this.nodeTransform.attachGizmo(mode);
    // Do NOT use showY=false here: TransformControls hides every handle whose
    // name contains a hidden axis (Y, XY, YZ AND XYZ). The floor is flat, so a
    // Y scale is harmless, and the XYZ center cube is needed for uniform
    // scaling of the whole plane.
    this.editor.gizmo.showY = true;
  }

  /** Pending transform of the floor node (live during gizmo drags). */
  get pendingTransform() {
    return this.nodeTransform.pending;
  }

  hasPendingTransform(): boolean {
    return this.nodeTransform.hasPending;
  }

  /** Bake the pending transform into the floor node (undoable). */
  applyTransform(): boolean {
    this.normalizeScale();
    const ok = this.nodeTransform.apply();
    if (ok) {
      this.syncFromGizmo();
      this.onChanged();
    }
    return ok;
  }

  /** Discard the pending transform (floor returns to its baked state). */
  resetTransform(): void {
    this.nodeTransform.reset();
    this.syncFromGizmo();
    this.onChanged();
  }

  /** Re-seat the gizmo on the current previewed pivot/orientation. */
  private refreshGizmo(): void {
    if (this.active) this.nodeTransform.attachGizmo(this.gizmoMode);
  }

  /**
   * A floor plane is symmetric, so a mirrored or zero pending scale is
   * meaningless and only makes the panel (which shows magnitudes) disagree
   * with the baked node. Snap the pending scale to positive magnitudes.
   */
  normalizeScale(): void {
    const p = this.nodeTransform.pending;
    const sx = Math.max(0.01, Math.abs(p.sx));
    const sy = Math.max(0.01, Math.abs(p.sy));
    const sz = Math.max(0.01, Math.abs(p.sz));
    if (sx !== p.sx || sy !== p.sy || sz !== p.sz) {
      p.sx = sx;
      p.sy = sy;
      p.sz = sz;
      this.nodeTransform.preview();
    }
  }

  /** Rotation of the plane in degrees (Euler XYZ), e.g. tilt/spin fields. */
  get rotationDeg(): { x: number; y: number; z: number } {
    // Read the previewed orientation (pending rides on the node matrix).
    if (this.hasPendingTransform()) {
      this.floorRoot.updateMatrixWorld(true);
      const q = new THREE.Quaternion();
      this.floorRoot.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3());
      const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
      return {
        x: THREE.MathUtils.radToDeg(e.x),
        y: THREE.MathUtils.radToDeg(e.y),
        z: THREE.MathUtils.radToDeg(e.z),
      };
    }
    return {
      x: THREE.MathUtils.radToDeg(this.floorRoot.rotation.x),
      y: THREE.MathUtils.radToDeg(this.floorRoot.rotation.y),
      z: THREE.MathUtils.radToDeg(this.floorRoot.rotation.z),
    };
  }

  setRotationDeg(x?: number, y?: number, z?: number): void {
    if (x !== undefined) this.floorRoot.rotation.x = THREE.MathUtils.degToRad(x);
    if (y !== undefined) this.floorRoot.rotation.y = THREE.MathUtils.degToRad(y);
    if (z !== undefined) this.floorRoot.rotation.z = THREE.MathUtils.degToRad(z);
    // Re-capture the base so a pending transform keeps riding on the new
    // rotation instead of previewing the old base quaternion.
    this.nodeTransform.refreshBase();
    this.updatePlane();
  }

  /**
   * Read back the transform after gizmo interaction: settings mirror the
   * floorRoot transform (scale clamped positive), label repositioned.
   * Cheap enough to call on every objectChange during a drag.
   */
  syncFromGizmo(): void {
    const s = this.settings;
    let pos: THREE.Vector3;
    let scale: THREE.Vector3;
    if (this.hasPendingTransform()) {
      // Pending active: the node's TRS holds the baked base while its matrix
      // holds base∘pending — read the previewed world matrix.
      this.floorRoot.updateMatrixWorld(true);
      const q = new THREE.Quaternion();
      pos = new THREE.Vector3();
      scale = new THREE.Vector3();
      this.floorRoot.matrixWorld.decompose(pos, q, scale);
    } else {
      // No pending: TRS is authoritative (matrix may be stale after direct
      // TRS writes — e.g. tests or fitToModel — without updateMatrix).
      pos = this.floorRoot.position;
      scale = this.floorRoot.scale;
    }
    s.cx = pos.x;
    s.y = pos.y;
    s.cz = pos.z;
    s.sizeX = Math.max(0.05, Math.abs(scale.x));
    s.sizeZ = Math.max(0.05, Math.abs(scale.z));
    this.positionLabel();
  }

  /** Re-arm the one-time auto-fit (call on model import / mesh switch). */
  armAutoFit(): void {
    this.autoFitPending = true;
  }

  /**
   * Center + size the plane to the model bbox footprint.
   * bakePending=true is the explicit "Fit to model" action: fold the pending
   * transform in first, then write the fit values (so the fit is not lost).
   * Returns false when a pending transform is armed and baking was not asked
   * for (the auto-fit on activation then stays armed for a later attempt).
   */
  fitToModel(bakePending = false): boolean {
    const mesh = this.getMesh();
    if (!mesh) return false;
    if (this.hasPendingTransform()) {
      if (!bakePending) return false;
      this.nodeTransform.apply();
    }
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!;
    const size = bb.getSize(new THREE.Vector3());
    const center = bb.getCenter(new THREE.Vector3());
    this.settings.sizeX = Math.max(0.1, size.x * 1.25);
    this.settings.sizeZ = Math.max(0.1, size.z * 1.25);
    this.settings.cx = center.x;
    this.settings.cz = center.z;
    this.updatePlane();
    return true;
  }

  /**
   * Write the settings-defined geometry into the BAKED base.
   * bakePending=true for EXPLICIT user input (numeric fields, Fit, @bottom):
   * the pending gizmo transform is folded in first so the written values are
   * exactly what the user typed. Passive paths (tool activation) pass false —
   * pending must survive those untouched.
   */
  updatePlane(bakePending = false): void {
    const s = this.settings;
    if (bakePending && this.hasPendingTransform()) {
      // apply() also syncs `settings` from the baked base via the change
      // listener, so a stale mirror can never overwrite the pending edit.
      this.normalizeScale();
      this.nodeTransform.apply();
    }
    if (this.hasPendingTransform()) {
      // Pending active and not baking: only the LABEL follows the preview;
      // the base TRS must not be touched (pending rides on top).
      this.positionLabel();
      this.floorRoot.updateMatrixWorld(true);
      return;
    }
    this.floorRoot.position.set(s.cx, s.y, s.cz);
    // Preserve Y: a uniform scale (or the Transform sub-panel's Y field) must
    // survive later base writes. The plane is flat, so Y has no visual effect.
    this.floorRoot.scale.set(s.sizeX, this.floorRoot.scale.y, s.sizeZ);
    this.nodeTransform.refreshBase();
    this.positionLabel();
    this.floorRoot.updateMatrixWorld(true);
    // Re-seat the gizmo on the new baked base (Fit / @bottom / passive writes).
    this.refreshGizmo();
  }

  private positionLabel(): void {
    // Follow the PREVIEWED origin, not the baked one (pending translation).
    const p = this.nodeTransform.previewedTRS().pos;
    this.floorLabel.position.copy(p);
    this.floorLabel.position.y += 0.02 + this.labelLift;
  }

  /** Label lift so the sprite stays readable for large planes. */
  private get labelLift(): number {
    return Math.max(0.1, Math.min(this.settings.sizeX, this.settings.sizeZ) * 0.06);
  }

  /**
   * World-space frame of the plane (normal, center, axes, extents) derived
   * from floorRoot's world matrix — the single source of truth for the
   * leveling math, valid for tilted planes too.
   */
  frame(): FloorFrame {
    this.floorRoot.updateMatrixWorld(true);
    const q = new THREE.Quaternion();
    this.floorRoot.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3());
    const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
    const xAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();
    const zAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
    const worldScale = new THREE.Vector3();
    this.floorRoot.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), worldScale);
    return {
      normal,
      point: this.floorRoot.getWorldPosition(new THREE.Vector3()),
      xAxis,
      zAxis,
      halfX: Math.max(0.05, Math.abs(worldScale.x)) / 2,
      halfZ: Math.max(0.05, Math.abs(worldScale.z)) / 2,
    };
  }

  // ---------- intersection scan (R6) ----------

  scan(): number {
    const mesh = this.getMesh();
    if (!mesh) return 0;
    const frame = this.frame();
    const res = intersectFloorPlane(mesh, frame);
    this.lastScanMeshUuid = mesh.object.uuid;

    // Connected components over adjacency within the intersecting set.
    const adj = getAdjacency(mesh);
    const inSet = new Set(res.triangles);
    const visited = new Set<number>();
    const areas: typeof this.areas = [];
    for (const t0 of res.triangles) {
      if (visited.has(t0)) continue;
      const tris: number[] = [];
      const stack = [t0];
      visited.add(t0);
      while (stack.length) {
        const t = stack.pop()!;
        tris.push(t);
        for (const nt of adj[t]) {
          if (inSet.has(nt) && !visited.has(nt)) {
            visited.add(nt);
            stack.push(nt);
          }
        }
      }
      if (tris.length < 2) continue; // skip specks
      let minY = Infinity, maxY = -Infinity;
      const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      const idx = mesh.index;
      for (const t of tris) {
        for (let k = 0; k < 3; k++) {
          const vi = idx ? idx[t * 3 + k] : t * 3 + k;
          const y = arr[vi * 3 + 1];
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      areas.push({ id: areas.length, triangles: tris, set: new Set(tris), minY, maxY, count: tris.length });
    }
    areas.sort((a, b) => b.count - a.count);
    areas.forEach((a, i) => (a.id = i));
    this.areas = areas;
    this.paintHitOverlay(mesh);
    this.onChanged();
    return areas.length;
  }

  private paintHitOverlay(mesh: MeshData): void {
    // Build a subset geometry containing ONLY the intersecting triangles,
    // so untouched faces stay clean (no black ghost over the model).
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const src = pos.array as Float32Array;
    const idx = mesh.index;

    // Gather triangles to draw: all scanned areas (color = selected ? red : orange).
    type Draw = { t: number; sel: boolean };
    const draw: Draw[] = [];
    for (const area of this.areas) {
      const sel = this.selectedIds.has(area.id);
      for (const t of area.triangles) draw.push({ t, sel });
    }
    if (draw.length === 0) {
      this.clearHitOverlay();
      return;
    }

    const posArr = new Float32Array(draw.length * 9);
    const colArr = new Float32Array(draw.length * 9);
    const cSel = new THREE.Color(0xff5f5f);
    const cHit = new THREE.Color(0xe0a53f);
    const c = new THREE.Color();
    for (let d = 0; d < draw.length; d++) {
      const { t, sel } = draw[d];
      c.copy(sel ? cSel : cHit);
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx[t * 3 + k] : t * 3 + k;
        posArr[d * 9 + k * 3] = src[vi * 3];
        posArr[d * 9 + k * 3 + 1] = src[vi * 3 + 1];
        posArr[d * 9 + k * 3 + 2] = src[vi * 3 + 2];
        colArr[d * 9 + k * 3] = c.r;
        colArr[d * 9 + k * 3 + 1] = c.g;
        colArr[d * 9 + k * 3 + 2] = c.b;
      }
    }

    if (this.hitMesh) {
      this.editor.overlayGroup.remove(this.hitMesh);
      (this.hitMesh.material as THREE.Material).dispose();
      this.hitGeo?.dispose();
      this.hitMesh = null;
      this.hitGeo = null;
      this.hitColor = null;
    }
    this.hitGeo = new THREE.BufferGeometry();
    this.hitGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    this.hitColor = new THREE.BufferAttribute(colArr, 3);
    this.hitGeo.setAttribute('color', this.hitColor);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.95,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
    this.hitMesh = new THREE.Mesh(this.hitGeo, mat);
    this.hitMesh.renderOrder = 4;
    this.hitMesh.frustumCulled = false;
    this.hitMesh.raycast = () => {};
    this.editor.overlayGroup.add(this.hitMesh);
    this.hitSource = mesh.object;
  }

  clearHitOverlay(): void {
    if (this.hitMesh) {
      this.editor.overlayGroup.remove(this.hitMesh);
      (this.hitMesh.material as THREE.Material).dispose();
      this.hitMesh = null;
      this.hitGeo = null; // shared attributes — do not dispose
      this.hitColor = null;
      this.hitSource = null;
    }
  }

  repaint(): void {
    const mesh = this.getMesh();
    if (mesh && this.hitMesh) this.paintHitOverlay(mesh);
  }

  /** Area under cursor: raycast triangle → which area contains it. */
  areaAt(ndc: THREE.Vector2): number {
    const mesh = this.getMesh();
    if (!mesh) return -1;
    const hit = this.editor.raycastModel(ndc);
    if (!hit) return -1;
    for (const a of this.areas) {
      if (a.set.has(hit.faceIndex)) return a.id;
    }
    return -1;
  }

  selectArea(id: number): void {
    this.selectedIds = id >= 0 ? new Set([id]) : new Set();
    const mesh = this.getMesh();
    if (mesh) this.paintHitOverlay(mesh);
    this.onChanged();
  }

  /** Select/toggle an area. additive=false replaces the selection. */
  toggleArea(id: number, additive: boolean): void {
    if (!additive) {
      this.selectedIds = new Set([id]);
    } else if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
    } else {
      this.selectedIds.add(id);
    }
    const mesh = this.getMesh();
    if (mesh) this.paintHitOverlay(mesh);
    this.onChanged();
  }

  /** Replace the whole selection (rect select). */
  setSelectedAreas(ids: number[]): void {
    this.selectedIds = new Set(ids);
    const mesh = this.getMesh();
    if (mesh) this.paintHitOverlay(mesh);
    this.onChanged();
  }

  get selectedAreas(): Set<number> {
    return this.selectedIds;
  }

  // ---------- leveling (R7) ----------

  /** Level the selected area(s). mode: 'drop' rigid | 'flatten' clamp. */
  level(mode: 'drop' | 'flatten'): boolean {
    const mesh = this.getMesh();
    if (!mesh || this.areas.length === 0) return false;
    const sel = this.areas.filter((a) => this.selectedIds.has(a.id)).flatMap((a) => a.triangles);
    if (sel.length === 0) return false;

    const frame = this.frame();
    const adj = getAdjacency(mesh);
    // Smooth band ~ proportional to region size; welded across duplicate verts.
    const band = Math.max(2, Math.round(Math.sqrt(sel.length / Math.PI) * 0.25));
    const triW = selectionFalloff(adj, new Set(sel), band);
    const vw = weldedVertexWeights(mesh, sel, triW);

    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const before = new Float32Array(pos.array as Float32Array);

    if (mode === 'drop') {
      dropToPlane(mesh, sel, frame, vw);
    } else {
      flattenToPlane(mesh, sel, frame, vw);
    }

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
    this.history.push({ name: mode === 'drop' ? 'Level: drop to floor' : 'Level: flatten to floor', undo, redo });

    // Re-scan so highlights reflect the new geometry.
    this.scan();
    return true;
  }

  /** Drop area index list for UI. */
  areaSummaries(): { id: number; count: number; minY: number; maxY: number }[] {
    return this.areas.map((a) => ({ id: a.id, count: a.count, minY: a.minY, maxY: a.maxY }));
  }
}
