import * as THREE from 'three';
import type { Editor } from './editor';
import type { MeshData, FloorSettings, BrushSettings } from './types';
import { intersectFloorPlane, dropToPlane, flattenToPlane, type FloorFrame } from './leveling';
import { selectionFalloff, weldedVertexWeights, getAdjacency } from './falloff';
import { applyBrushDab, collectBrushHits, type BrushDabResult } from './brush';
import { makeTextSprite } from './editor';
import { PendingNodeTransform } from './objectTransform';
import type { History } from './history';

/**
 * Floor tool (R5–R7): a resizable/movable/rotatable plane; an AUTOMATIC live
 * intersection scan that distinguishes buried triangles, triangles accurately
 * straddling the plane, coplanar (brushed/leveled) triangles and the exact cut
 * contour; connected areas for rigid "drop" or "flatten" leveling; and the
 * Brush sub-mode that snaps only the nearest vertices onto the plane (push
 * down above it, pull up below it) with radius/falloff/curve controls.
 * The plane carries a full transform (Translate/Rotate/Scale gizmo) — a tilted
 * plane levels and brushes along its own normal.
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

  // ---------- brush (Floor ▸ Brush) ----------

  brushSettings: BrushSettings = {
    radius: 0.5,
    falloffRadius: 0.3,
    curve: 'smoothstep',
    hardness: 0.5,
    strength: 1,
  };
  /** True while the Brush sub-panel is active (gizmo detached, LMB paints). */
  brushMode = false;
  /** Draw the affected-vertex preview under the cursor. */
  brushShowPreview = true;
  /** Report of the latest dab (for the panel's live stats). */
  lastBrushResult: (BrushDabResult & { totalAffected: number; totalMoved: number }) | null = null;
  onBrushDab: ((res: BrushDabResult & { totalAffected: number; totalMoved: number }) => void) | null = null;

  /** Latest accurate-intersection details used by the highlight overlay. */
  crossing: Set<number> = new Set();
  onPlane: Set<number> = new Set();
  segments: Float32Array | null = null;

  /** One-time brush-size fit per model. */
  private brushFitPending = true;
  /** Signature of the last scan (mesh version + plane matrix) for auto-scan. */
  private lastScanSig = '';

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
  private hitLines: THREE.LineSegments | null = null;
  private hitLineGeo: THREE.BufferGeometry | null = null;

  // Brush visuals / stroke state.
  private brushCursor: THREE.Group;
  private brushOuter: THREE.LineLoop;
  private brushInner: THREE.LineLoop;
  private brushDisc: THREE.Mesh;
  private brushPreview: THREE.Points;
  private previewGeo: THREE.BufferGeometry;
  private previewCapacity = 0;
  private previewIndices = new Int32Array(0);
  private previewWeights = new Float32Array(0);
  private readonly previewLow = new THREE.Color(0x3fa9ff);
  private readonly previewHigh = new THREE.Color(0xffd54a);
  private readonly previewTmp = new THREE.Color();
  private pointerNdc: THREE.Vector2 | null = null;
  private brushDown = false;
  private forceDab = false;
  private lastDabNdc = new THREE.Vector2(2, 2);
  private strokeBefore: Float32Array | null = null;
  private strokeMeshUuid = '';
  private strokeAffected = 0;
  private strokeMoved = 0;
  private strokeMaxShift = 0;
  private brushVisualSig = '';

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

    // Brush cursor: outer/inner rings + translucent disc, lying on the plane.
    this.brushCursor = new THREE.Group();
    this.brushCursor.name = 'BrushCursor';
    this.brushCursor.visible = false;
    this.editor.overlayGroup.add(this.brushCursor);

    const ringGeo = (): THREE.BufferGeometry => {
      const pts: THREE.Vector3[] = [];
      const segs = 128;
      for (let i = 0; i < segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
      }
      return new THREE.BufferGeometry().setFromPoints(pts);
    };
    this.brushDisc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 96),
      new THREE.MeshBasicMaterial({
        color: 0x4f8cff, transparent: true, opacity: 0.07,
        depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    this.brushDisc.renderOrder = 18;
    this.brushDisc.raycast = () => {};
    this.brushOuter = new THREE.LineLoop(
      ringGeo(),
      new THREE.LineBasicMaterial({
        color: 0xa8dcff, transparent: true, opacity: 0.95,
        depthTest: false, depthWrite: false,
      }),
    );
    this.brushOuter.renderOrder = 20;
    this.brushOuter.raycast = () => {};
    this.brushInner = new THREE.LineLoop(
      ringGeo(),
      new THREE.LineBasicMaterial({
        color: 0x4f8cff, transparent: true, opacity: 0.85,
        depthTest: false, depthWrite: false,
      }),
    );
    this.brushInner.renderOrder = 21;
    this.brushInner.raycast = () => {};
    this.brushCursor.add(this.brushDisc, this.brushOuter, this.brushInner);

    // Affected-vertex preview (screen-space points, drawn over the model).
    this.previewGeo = new THREE.BufferGeometry();
    this.brushPreview = new THREE.Points(
      this.previewGeo,
      new THREE.PointsMaterial({
        size: 4.5, sizeAttenuation: false, vertexColors: true,
        transparent: true, opacity: 0.95, depthTest: false, depthWrite: false,
      }),
    );
    this.brushPreview.frustumCulled = false;
    this.brushPreview.renderOrder = 22;
    this.brushPreview.visible = false;
    this.brushPreview.raycast = () => {};
    this.brushPreview.name = 'BrushPreview';
    this.editor.overlayGroup.add(this.brushPreview);

    // Per-frame hook: auto intersection scan + brush painting/cursor.
    this.editor.addFrameListener(() => this.frameTick());

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
      this.endBrushStroke();
      this.brushMode = false;
      this.clearPointer();
      if (was) {
        this.editor.detachGizmo();
        this.clearHitOverlay();
        this.areas = [];
        this.selectedIds.clear();
        this.crossing.clear();
        this.onPlane.clear();
        this.segments = null;
        this.lastScanSig = '';
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
      // Entering Floor mode always starts with a fresh, automatic highlight.
      this.lastScanSig = '';
      if (this.getMesh()) this.scan();
    }
    this.updatePlane();
    this.onChanged();
  }

  setGizmoMode(mode: 'translate' | 'rotate' | 'scale'): void {
    this.gizmoMode = mode;
    if (this.active && !this.brushMode) this.nodeTransform.attachGizmo(mode);
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
    if (this.active && !this.brushMode) this.nodeTransform.attachGizmo(this.gizmoMode);
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

  /** Re-arm the one-time brush-size fit (call on model import / mesh switch). */
  armBrushFit(): void {
    this.brushFitPending = true;
  }

  /**
   * Size the brush to the model: ~3.5% of its largest dimension, clamped.
   * Runs once per model when the Brush sub-panel is first opened, so the
   * default radius is usable on both a 0.5 m scan and a 35 m terrain.
   */
  fitBrushToModel(): boolean {
    const mesh = this.getMesh();
    if (!mesh) return false;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!;
    const size = bb.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.01);
    const r = THREE.MathUtils.clamp(maxDim * 0.035, 0.02, 5);
    this.brushSettings.radius = r;
    this.brushSettings.falloffRadius = r * 0.6;
    return true;
  }

  /**
   * Enter/leave the Brush sub-panel. In brush mode the floor gizmo is
   * detached (left-drag paints instead of manipulating the plane) and the
   * brush cursor appears on the next pointer move.
   */
  setBrushMode(v: boolean): void {
    if (this.brushMode === v) {
      if (v) {
        this.brushVisualSig = '';
        this.nodeTransform.detachGizmo(); // defensive: brush mode never shows the gizmo
      }
      return;
    }
    this.brushMode = v;
    if (v) {
      this.nodeTransform.detachGizmo();
      if (this.brushFitPending && this.fitBrushToModel()) this.brushFitPending = false;
      this.brushVisualSig = '';
    } else {
      this.endBrushStroke();
      this.clearPointer();
      if (this.active) this.nodeTransform.attachGizmo(this.gizmoMode);
    }
    this.onChanged();
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
    this.lastScanSig = this.scanSignature();
    this.crossing = new Set(res.crossing);
    this.onPlane = new Set(res.onPlane);
    this.segments = res.segments.length ? new Float32Array(res.segments) : null;

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
    // Drop selections whose area id no longer exists after the re-sort.
    for (const id of [...this.selectedIds]) {
      if (id < 0 || id >= areas.length) this.selectedIds.delete(id);
    }
    this.paintHitOverlay(mesh);
    this.onChanged();
    return areas.length;
  }

  /**
   * Cheap change signature for the auto highlight: mesh + position-buffer
   * version (bumped by brush/level/FFD/transform/undo) + plane world matrix.
   * The per-frame tick rescans only when this changes, so the highlight is
   * always live without scanning when nothing moved.
   */
  private scanSignature(): string {
    const mesh = this.getMesh();
    if (!mesh) return '';
    this.floorRoot.updateMatrixWorld(true);
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    return (
      mesh.object.uuid + ':' +
      mesh.geometry.uuid + ':' +
      (pos ? pos.version : -1) + ':' +
      this.floorRoot.matrixWorld.elements.join(',')
    );
  }

  private autoScanTick(): void {
    const sig = this.scanSignature();
    if (!sig || sig === this.lastScanSig) return;
    this.scan();
  }

  private frameTick(): void {
    if (!this.active) return;
    if (this.brushMode) {
      if (this.brushDown && this.forceDab) {
        this.forceDab = false;
        this.applyBrushAtPointer();
        if (this.pointerNdc) this.lastDabNdc.copy(this.pointerNdc);
      }
      this.updateBrushVisual();
    }
    this.autoScanTick();
  }

  private paintHitOverlay(mesh: MeshData): void {
    // Build a subset geometry containing ONLY the relevant triangles, so
    // untouched faces stay clean (no black ghost over the model).
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const src = pos.array as Float32Array;
    const idx = mesh.index;

    let total = this.onPlane.size;
    for (const area of this.areas) total += area.triangles.length;

    this.clearHitMesh();
    if (total === 0) {
      this.clearHitLines();
      return;
    }

    const posArr = new Float32Array(total * 9);
    const colArr = new Float32Array(total * 9);
    const cSel = new THREE.Color(0xff5f5f); // selected area
    const cCross = new THREE.Color(0xffb347); // accurately crossing the plane
    const cBelow = new THREE.Color(0x5a4523); // buried below the plane (kept subtle)
    const cPlane = new THREE.Color(0x35c46f); // flat on the plane (brushed/leveled)
    let d = 0;
    const writeTri = (t: number, c: THREE.Color): void => {
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx[t * 3 + k] : t * 3 + k;
        posArr[d * 9 + k * 3] = src[vi * 3];
        posArr[d * 9 + k * 3 + 1] = src[vi * 3 + 1];
        posArr[d * 9 + k * 3 + 2] = src[vi * 3 + 2];
        colArr[d * 9 + k * 3] = c.r;
        colArr[d * 9 + k * 3 + 1] = c.g;
        colArr[d * 9 + k * 3 + 2] = c.b;
      }
      d++;
    };

    for (const area of this.areas) {
      const sel = this.selectedIds.has(area.id);
      for (const t of area.triangles) {
        writeTri(t, sel ? cSel : this.crossing.has(t) ? cCross : cBelow);
      }
    }
    for (const t of this.onPlane) writeTri(t, cPlane);

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

    this.paintIntersectionLines();
  }

  /** Crisp exact cut contour (bright yellow) over the crossing band. */
  private paintIntersectionLines(): void {
    this.clearHitLines();
    if (!this.segments || this.segments.length < 6) return;
    this.hitLineGeo = new THREE.BufferGeometry();
    this.hitLineGeo.setAttribute('position', new THREE.BufferAttribute(this.segments, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xffe066, transparent: true, opacity: 0.95,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.hitLines = new THREE.LineSegments(this.hitLineGeo, mat);
    this.hitLines.renderOrder = 6;
    this.hitLines.frustumCulled = false;
    this.hitLines.raycast = () => {};
    this.editor.overlayGroup.add(this.hitLines);
  }

  private clearHitMesh(): void {
    if (!this.hitMesh) return;
    this.editor.overlayGroup.remove(this.hitMesh);
    (this.hitMesh.material as THREE.Material).dispose();
    this.hitGeo?.dispose();
    this.hitMesh = null;
    this.hitGeo = null;
    this.hitColor = null;
    this.hitSource = null;
  }

  private clearHitLines(): void {
    if (!this.hitLines) return;
    this.editor.overlayGroup.remove(this.hitLines);
    (this.hitLines.material as THREE.Material).dispose();
    this.hitLineGeo?.dispose();
    this.hitLines = null;
    this.hitLineGeo = null;
  }

  clearHitOverlay(): void {
    this.clearHitMesh();
    this.clearHitLines();
  }

  /** Forget the previous scan (new model / mesh switch / import). */
  resetScan(): void {
    this.clearHitOverlay();
    this.areas = [];
    this.selectedIds.clear();
    this.crossing.clear();
    this.onPlane.clear();
    this.segments = null;
    this.lastScanSig = '';
    this.lastBrushResult = null;
  }

  repaint(): void {
    const mesh = this.getMesh();
    if (mesh && (this.hitMesh || this.hitLines)) this.paintHitOverlay(mesh);
  }

  // ---------- brush (Floor ▸ Brush) ----------

  /** Track the pointer while brush mode is active (cursor + live painting). */
  updatePointer(ndc: THREE.Vector2): void {
    const moved = !this.pointerNdc || this.pointerNdc.distanceToSquared(ndc) > 1e-12;
    this.pointerNdc = ndc.clone();
    if (moved) {
      this.brushVisualSig = '';
      if (this.brushDown) this.forceDab = true;
    }
  }

  clearPointer(): void {
    this.pointerNdc = null;
    this.hideBrushCursor();
  }

  get brushStrokeActive(): boolean {
    return this.brushDown;
  }

  /** Whether the brush rings are currently shown (tests / UI). */
  get brushCursorVisible(): boolean {
    return this.brushCursor.visible;
  }

  /** Whether the affected-vertex preview is currently shown. */
  get brushPreviewVisible(): boolean {
    return this.brushPreview.visible;
  }

  /** Number of preview points currently drawn. */
  get brushPreviewCount(): number {
    const c = this.previewGeo.drawRange.count;
    return Number.isFinite(c) ? c : 0;
  }

  /**
   * Start one undoable brush stroke. The first dab is applied immediately so
   * a plain click always snaps something; further dabs follow the pointer at
   * frame rate.
   */
  beginBrushStroke(ndc: THREE.Vector2): void {
    if (!this.active || !this.brushMode) return;
    const mesh = this.getMesh();
    if (!mesh) return;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.strokeBefore = new Float32Array(pos.array as Float32Array);
    this.strokeMeshUuid = mesh.object.uuid;
    this.strokeAffected = 0;
    this.strokeMoved = 0;
    this.strokeMaxShift = 0;
    this.brushDown = true;
    this.forceDab = false;
    this.pointerNdc = ndc.clone();
    this.lastDabNdc.set(2, 2);
    this.applyBrushAtPointer();
    this.lastDabNdc.copy(ndc);
  }

  /** Finish the stroke and push ONE undo entry for the whole drag. */
  endBrushStroke(ndc?: THREE.Vector2): void {
    if (!this.brushDown) return;
    if (ndc) {
      this.pointerNdc = ndc.clone();
      if (ndc.distanceToSquared(this.lastDabNdc) > 1e-12) {
        this.applyBrushAtPointer();
        this.lastDabNdc.copy(ndc);
      }
    }
    this.brushDown = false;
    this.forceDab = false;

    const mesh = this.getMesh();
    const before = this.strokeBefore;
    this.strokeBefore = null;
    if (!mesh || !before || mesh.object.uuid !== this.strokeMeshUuid) {
      this.strokeMeshUuid = '';
      return;
    }
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const after = new Float32Array(pos.array as Float32Array);
    let changed = false;
    for (let i = 0; i < after.length; i++) {
      if (after[i] !== before[i]) {
        changed = true;
        break;
      }
    }
    if (changed) {
      const restore = (src: Float32Array): void => {
        (pos.array as Float32Array).set(src);
        pos.needsUpdate = true;
        mesh.geometry.computeBoundingBox();
        mesh.geometry.computeBoundingSphere();
      };
      this.history.push({
        name: 'Brush: push/pull to floor',
        undo: () => restore(before),
        redo: () => restore(after),
      });
      this.onChanged();
    }
    this.strokeMeshUuid = '';
  }

  /**
   * Apply one dab at an explicit world point on the plane (tests / scripting).
   * The normal pointer path is begin/update/endBrushStroke.
   */
  applyBrushAtPoint(center: THREE.Vector3): BrushDabResult {
    const mesh = this.getMesh();
    if (!mesh) return { affected: 0, moved: 0, maxShift: 0 };
    const res = applyBrushDab(mesh, this.frame(), center, this.brushSettings);
    this.brushVisualSig = '';
    return res;
  }

  /** Where the view ray meets the (possibly tilted) floor plane. */
  brushCenterFromNdc(ndc: THREE.Vector2): THREE.Vector3 | null {
    const frame = this.frame();
    // Make sure the ray uses this frame's camera pose (orbit updates run
    // before the renderer refreshes matrices).
    this.editor.camera.updateMatrixWorld();
    this.editor.ray.setFromCamera(ndc, this.editor.camera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(frame.normal, frame.point);
    const out = new THREE.Vector3();
    return this.editor.ray.ray.intersectPlane(plane, out) ? out : null;
  }

  private applyBrushAtPointer(): void {
    if (!this.pointerNdc) return;
    const mesh = this.getMesh();
    if (!mesh) return;
    const center = this.brushCenterFromNdc(this.pointerNdc);
    if (!center) return;
    const res = applyBrushDab(mesh, this.frame(), center, this.brushSettings);
    this.strokeAffected += res.affected;
    this.strokeMoved += res.moved;
    this.strokeMaxShift = Math.max(this.strokeMaxShift, res.maxShift);
    const report = { ...res, totalAffected: this.strokeAffected, totalMoved: this.strokeMoved };
    this.lastBrushResult = report;
    this.brushVisualSig = '';
    if (this.onBrushDab) this.onBrushDab(report);
  }

  /**
   * Position/orient the cursor rings and refresh the affected-vertex preview.
   * Signature-gated: the expensive per-vertex pass only runs when the
   * pointer, the brush settings, the plane or the geometry changed.
   */
  private updateBrushVisual(): void {
    if (!this.brushMode || !this.pointerNdc) {
      this.hideBrushCursor();
      return;
    }
    const mesh = this.getMesh();
    if (!mesh) {
      this.hideBrushCursor();
      return;
    }
    this.floorRoot.updateMatrixWorld(true);
    const s = this.brushSettings;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const cam = this.editor.camera;
    cam.updateMatrixWorld();
    const sig =
      mesh.object.uuid + ':' + mesh.geometry.uuid + '|' +
      this.pointerNdc.x.toFixed(5) + ',' + this.pointerNdc.y.toFixed(5) + '|' +
      s.radius.toFixed(6) + ',' + s.falloffRadius.toFixed(6) + ',' + s.curve + ',' +
      s.hardness.toFixed(4) + ',' + s.strength.toFixed(4) + '|' +
      (this.brushShowPreview ? 1 : 0) + '|' + pos.version + '|' +
      this.floorRoot.matrixWorld.elements.join(',') + '|' +
      cam.matrixWorld.elements.join(',') + '|' + cam.projectionMatrix.elements.join(',');
    if (sig === this.brushVisualSig) return;
    this.brushVisualSig = sig;

    const center = this.brushCenterFromNdc(this.pointerNdc);
    if (!center) {
      this.hideBrushCursor();
      return;
    }
    const frame = this.frame();
    const r = Math.max(1e-4, s.radius);
    const f = Math.min(Math.max(0, s.falloffRadius), r);
    this.brushCursor.visible = true;
    this.brushCursor.position.copy(center);
    this.brushCursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), frame.normal);
    this.brushDisc.scale.set(r, r, 1);
    this.brushOuter.scale.set(r, r, 1);
    this.brushInner.scale.set(f, f, 1);
    this.updateBrushPreview(mesh, center);
  }

  private updateBrushPreview(mesh: MeshData, center: THREE.Vector3): void {
    if (!this.brushShowPreview) {
      this.brushPreview.visible = false;
      this.previewGeo.setDrawRange(0, 0);
      return;
    }
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const count = pos.count;
    if (this.previewCapacity < count) {
      this.previewCapacity = count;
      this.previewIndices = new Int32Array(count);
      this.previewWeights = new Float32Array(count);
      this.previewGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      this.previewGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    }
    const n = collectBrushHits(mesh, center, this.brushSettings, this.previewIndices, this.previewWeights);
    if (n === 0) {
      this.brushPreview.visible = false;
      this.previewGeo.setDrawRange(0, 0);
      return;
    }
    const posAttr = this.previewGeo.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = this.previewGeo.getAttribute('color') as THREE.BufferAttribute;
    const pArr = posAttr.array as Float32Array;
    const cArr = colAttr.array as Float32Array;
    const src = pos.array as Float32Array;
    const tmp = this.previewTmp;
    for (let i = 0; i < n; i++) {
      const vi = this.previewIndices[i];
      pArr[i * 3] = src[vi * 3];
      pArr[i * 3 + 1] = src[vi * 3 + 1];
      pArr[i * 3 + 2] = src[vi * 3 + 2];
      tmp.copy(this.previewLow).lerp(this.previewHigh, Math.min(1, this.previewWeights[i]));
      cArr[i * 3] = tmp.r;
      cArr[i * 3 + 1] = tmp.g;
      cArr[i * 3 + 2] = tmp.b;
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    this.previewGeo.setDrawRange(0, n);
    this.brushPreview.visible = true;
  }

  private hideBrushCursor(): void {
    this.brushCursor.visible = false;
    this.brushPreview.visible = false;
    this.previewGeo.setDrawRange(0, 0);
    this.brushVisualSig = '';
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
