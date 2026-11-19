import * as THREE from 'three';
import type { Editor } from './editor';
import type { MeshData, FloorSettings } from './types';
import { intersectFloorPlane, dropToPlane, flattenToPlane } from './leveling';
import { selectionFalloff, weldedVertexWeights } from './falloff';
import { getAdjacency } from './segmentUtils';
import { makeTextSprite } from './editor';
import type { History } from './history';

/**
 * Floor tool (R5–R7): a resizable XZ plane; detect mesh faces crossing/below
 * it inside its footprint; highlight connected intersection areas; select one
 * (or several via rect) and level them: rigid "drop" or "flatten" onto the
 * plane, blended with a smooth falloff at the region border.
 */
export class FloorTool {
  active = false;

  settings: FloorSettings = { sizeX: 2, sizeZ: 2, y: 0, cx: 0, cz: 0 };

  /** Triangle sets of the latest intersection scan (connected areas). */
  areas: { id: number; triangles: number[]; set: Set<number>; minY: number; maxY: number; count: number }[] = [];
  /** Selected area ids (multi-select supported). */
  selectedIds: Set<number> = new Set();
  /** UI visibility toggle (topbar checkbox). */
  uiVisible = true;
  lastScanMeshUuid = '';

  private editor: Editor;
  private history: History;
  private getMesh: () => MeshData | null;
  private onChanged: () => void;

  private planeMesh: THREE.Mesh;
  private outline: THREE.LineSegments;

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

    const planeMat = new THREE.MeshBasicMaterial({
      color: 0x2fb9b9,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.planeMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), planeMat);
    this.planeMesh.rotation.x = -Math.PI / 2;
    this.planeMesh.renderOrder = 2;
    this.planeMesh.raycast = () => {};
    this.editor.overlayGroup.add(this.planeMesh);

    const og = new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1));
    this.outline = new THREE.LineSegments(og, new THREE.LineBasicMaterial({ color: 0x2fb9b9, transparent: true, opacity: 0.9 }));
    this.outline.rotation.x = -Math.PI / 2;
    this.outline.renderOrder = 3;
    this.outline.raycast = () => {};
    this.editor.overlayGroup.add(this.outline);

    this.floorLabel = makeTextSprite('floor', 0x2fb9b9, new THREE.Vector3(0, 0, 0), 0.22);
    this.floorLabel.renderOrder = 6;
    this.editor.overlayGroup.add(this.floorLabel);
  }

  private floorLabel: THREE.Sprite;

  setActive(v: boolean): void {
    this.active = v;
    this.planeMesh.visible = v && this.uiVisible;
    this.outline.visible = v && this.uiVisible;
    this.floorLabel.visible = this.planeMesh.visible;
    if (!v) {
      this.clearHitOverlay();
      this.areas = [];
      this.selectedIds.clear();
    } else {
      this.fitToModel();
    }
    this.updatePlane();
    this.onChanged();
  }

  /** Center + size the plane to the model bbox footprint (convenience). */
  fitToModel(): void {
    const mesh = this.getMesh();
    if (!mesh) return;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!;
    const size = bb.getSize(new THREE.Vector3());
    const center = bb.getCenter(new THREE.Vector3());
    this.settings.sizeX = Math.max(0.1, size.x * 1.25);
    this.settings.sizeZ = Math.max(0.1, size.z * 1.25);
    this.settings.cx = center.x;
    this.settings.cz = center.z;
    this.updatePlane();
  }

  updatePlane(): void {
    const s = this.settings;
    this.planeMesh.scale.set(s.sizeX, s.sizeZ, 1);
    this.planeMesh.position.set(s.cx, s.y, s.cz);
    this.outline.scale.set(s.sizeX, s.sizeZ, 1);
    this.outline.position.set(s.cx, s.y, s.cz);
    this.floorLabel.position.set(s.cx, s.y + 0.02, s.cz);
    this.floorLabel.visible = this.planeMesh.visible;
    this.planeMesh.updateMatrixWorld(true);
  }

  // ---------- intersection scan (R6) ----------

  scan(): number {
    const mesh = this.getMesh();
    if (!mesh) return 0;
    const s = this.settings;
    const res = intersectFloorPlane(
      mesh, s.y,
      s.cx - s.sizeX / 2, s.cx + s.sizeX / 2,
      s.cz - s.sizeZ / 2, s.cz + s.sizeZ / 2,
    );
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

    const planeY = this.settings.y;
    const adj = getAdjacency(mesh);
    // Smooth band ~ proportional to region size; welded across duplicate verts.
    const band = Math.max(2, Math.round(Math.sqrt(sel.length / Math.PI) * 0.25));
    const triW = selectionFalloff(adj, new Set(sel), band);
    const vw = weldedVertexWeights(mesh, sel, triW);

    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const before = new Float32Array(pos.array as Float32Array);

    if (mode === 'drop') {
      dropToPlane(mesh, sel, planeY, vw);
    } else {
      flattenToPlane(mesh, sel, planeY, vw);
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
