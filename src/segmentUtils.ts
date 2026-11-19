import * as THREE from 'three';
import type { MeshData, SegAxis } from './types';
import { getAdjacency, invalidateTopologyCache } from './falloff';

export { getAdjacency, invalidateTopologyCache };

export interface SegmentHit {
  /** Mesh under the cursor at pointerdown (drag start), or undefined for a drag rect on empty space. */
  mesh?: MeshData;
  /** Triangle index under cursor (drag start). */
  triangle?: number;
  /** Segment id under cursor, if the triangle belongs to a segmentation. */
  segmentId?: number;
  /** Screen-space drag rect in NDC when dragging on empty space. */
  dragRect?: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Assign every triangle of the mesh to a segment cell via per-triangle centroid
 * binning into an N×M grid over the bbox of the two chosen axes.
 */
export function buildSegmentation(
  mesh: MeshData,
  axisA: SegAxis,
  axisB: SegAxis,
  countA: number,
  countB: number,
  falloffRatio: number,
): { triToSegment: Int32Array; segCount: number; minA: number; minB: number; spanA: number; spanB: number } {
  const triToSegment = new Int32Array(mesh.triCount).fill(-1);
  if (countA < 1 || countB < 1) return { triToSegment, segCount: 0, minA: 0, minB: 0, spanA: 1, spanB: 1 };

  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox!;
  const min = bb.min;
  const max = bb.max;
  const minA = min[axisA];
  const minB = min[axisB];
  const spanA = Math.max(max[axisA] - minA, 1e-9);
  const spanB = Math.max(max[axisB] - minB, 1e-9);

  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const idx = mesh.index;

  const axA = { x: 0, y: 1, z: 2 }[axisA];
  const axB = { x: 0, y: 1, z: 2 }[axisB];

  for (let t = 0; t < mesh.triCount; t++) {
    const i0 = idx ? idx[t * 3] : t * 3;
    const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
    const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const a = (pos.array as Float32Array)[i0 * 3 + axA] + (pos.array as Float32Array)[i1 * 3 + axA] + (pos.array as Float32Array)[i2 * 3 + axA];
    const b = (pos.array as Float32Array)[i0 * 3 + axB] + (pos.array as Float32Array)[i1 * 3 + axB] + (pos.array as Float32Array)[i2 * 3 + axB];
    const ca = Math.min(countA - 1, Math.max(0, Math.floor(((a / 3) - minA) / spanA * countA)));
    const cb = Math.min(countB - 1, Math.max(0, Math.floor(((b / 3) - minB) / spanB * countB)));
    triToSegment[t] = ca * countB + cb;
  }

  return { triToSegment, segCount: countA * countB, minA, minB, spanA, spanB };
}

export interface CellRange {
  ia0: number; ia1: number; ib0: number; ib1: number;
}

/** Convert a screen drag rect to a range of grid cells (for drag-multi-select). */
export function cellsFromDragRect(
  rect: { x0: number; y0: number; x1: number; y1: number },
  axisA: SegAxis,
  axisB: SegAxis,
  countA: number,
  countB: number,
  minA: number,
  minB: number,
  spanA: number,
  spanB: number,
  ndcToScene: (ndc: THREE.Vector2) => THREE.Vector3 | null,
): number[] {
  const ids = new Set<number>();
  const steps = 14;
  for (let ix = 0; ix <= steps; ix++) {
    for (let iy = 0; iy <= steps; iy++) {
      const nx = rect.x0 + ((rect.x1 - rect.x0) * ix) / steps;
      const ny = rect.y0 + ((rect.y1 - rect.y0) * iy) / steps;
      const p = ndcToScene(new THREE.Vector2(nx, ny));
      if (!p) continue;
      const fa = (p[axisA] - minA) / spanA;
      const fb = (p[axisB] - minB) / spanB;
      if (fa < -0.02 || fa > 1.02 || fb < -0.02 || fb > 1.02) continue;
      const ia = Math.min(countA - 1, Math.max(0, Math.floor(fa * countA)));
      const ib = Math.min(countB - 1, Math.max(0, Math.floor(fb * countB)));
      ids.add(ia * countB + ib);
    }
  }
  return [...ids];
}

/** Gather vertex indices of given segments (owned triangles' verts). */
export function segmentVertices(segmentation: {
  segments: { id: number; vertexSet: Set<number> }[];
}, ids: Iterable<number>): number[] {
  const set = new Set<number>();
  const idSet = new Set(ids);
  for (const seg of segmentation.segments) {
    if (!idSet.has(seg.id)) continue;
    for (const v of seg.vertexSet) set.add(v);
  }
  return [...set];
}

/**
 * Union-find over triangle adjacency restricted to a segment set:
 * returns connected components (each = array of triangle indices).
 */
export function connectedComponents(
  mesh: MeshData,
  adjacency: number[][],
  triangleFilter: (t: number) => boolean,
): number[][] {
  const visited = new Uint8Array(mesh.triCount);
  const comps: number[][] = [];
  for (let t0 = 0; t0 < mesh.triCount; t0++) {
    if (visited[t0] || !triangleFilter(t0)) continue;
    const comp: number[] = [];
    const stack = [t0];
    visited[t0] = 1;
    while (stack.length) {
      const t = stack.pop()!;
      comp.push(t);
      for (const nt of adjacency[t]) {
        if (!visited[nt] && triangleFilter(nt)) {
          visited[nt] = 1;
          stack.push(nt);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

/** Bounding box of a set of triangles (current positions). */
export function trianglesBBox(mesh: MeshData, triangles: number[]): THREE.Box3 {
  const box = new THREE.Box3();
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (const t of triangles) {
    for (let k = 0; k < 3; k++) {
      const vi = mesh.index ? mesh.index[t * 3 + k] : t * 3 + k;
      v.fromBufferAttribute(pos, vi);
      box.expandByPoint(v);
    }
  }
  return box;
}
