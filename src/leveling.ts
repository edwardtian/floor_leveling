import * as THREE from 'three';
import type { MeshData } from './types';

/**
 * Floor plane intersection: find faces whose triangles cross the floor plane
 * (or sit fully below it) within the plane's XZ footprint.
 */
export interface PlaneIntersection {
  /** triangle indices intersecting (crossing or below plane, inside footprint). */
  triangles: number[];
  /** Global lowest y among intersecting triangles. */
  minY: number;
}

export function intersectFloorPlane(
  mesh: MeshData,
  planeY: number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): PlaneIntersection {
  const triangles: number[] = [];
  let minY = Infinity;

  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const idx = mesh.index;

  for (let t = 0; t < mesh.triCount; t++) {
    const i0 = idx ? idx[t * 3] : t * 3;
    const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
    const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;

    const y0 = arr[i0 * 3 + 1];
    const y1 = arr[i1 * 3 + 1];
    const y2 = arr[i2 * 3 + 1];

    const below = y0 < planeY || y1 < planeY || y2 < planeY;
    const above = y0 > planeY || y1 > planeY || y2 > planeY;
    if (!(below && above)) {
      // Also count triangles fully below the plane (buried geometry).
      if (!below) continue;
    }
    // Footprint test: triangle centroid inside the plane rect (XZ).
    const cx = (arr[i0 * 3] + arr[i1 * 3] + arr[i2 * 3]) / 3;
    const cz = (arr[i0 * 3 + 2] + arr[i1 * 3 + 2] + arr[i2 * 3 + 2]) / 3;
    if (cx < minX || cx > maxX || cz < minZ || cz > maxZ) continue;

    const m = Math.min(y0, y1, y2);
    if (m < minY) minY = m;
    triangles.push(t);
  }

  return { triangles, minY: triangles.length ? minY : 0 };
}

/**
 * Leveling — drop mode: translate the selection rigidly so its lowest point
 * lands on the plane; the falloff weights blend the motion at the border.
 * Any selected vertex still below the plane afterwards (band verts whose
 * weight < 1) is clamped onto the plane, so nothing remains underground.
 */
export function dropToPlane(
  mesh: MeshData,
  triangles: number[],
  planeY: number,
  vertexWeights: Float32Array | null,
): number {
  if (triangles.length === 0) return 0;
  let lowest = Infinity;
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const idx = mesh.index;
  const touched = collectVertices(triangles, idx);
  for (const vi of touched) {
    if (arr[vi * 3 + 1] < lowest) lowest = arr[vi * 3 + 1];
  }
  const dy = planeY - lowest;
  if (Math.abs(dy) > 1e-9) {
    for (const vi of touched) {
      const w = vertexWeights ? vertexWeights[vi] : 1;
      arr[vi * 3 + 1] += dy * w;
    }
  }
  // Post-clamp: level any selected vertex that remains below the plane.
  for (const vi of touched) {
    if (arr[vi * 3 + 1] < planeY) arr[vi * 3 + 1] = planeY;
  }
  pos.needsUpdate = true;
  mesh.geometry.computeBoundingBox();
  mesh.geometry.computeBoundingSphere();
  return dy;
}

/**
 * Leveling — flatten mode: each vertex below planeY is pulled up toward it,
 * weighted by the falloff; vertices at/above the plane are untouched.
 */
export function flattenToPlane(
  mesh: MeshData,
  triangles: number[],
  planeY: number,
  vertexWeights: Float32Array | null,
): void {
  if (triangles.length === 0) return;
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const idx = mesh.index;
  const touched = collectVertices(triangles, idx);
  for (const vi of touched) {
    const y = arr[vi * 3 + 1];
    if (y >= planeY) continue;
    const w = vertexWeights ? vertexWeights[vi] : 1;
    arr[vi * 3 + 1] = y + (planeY - y) * w;
  }
  pos.needsUpdate = true;
  mesh.geometry.computeBoundingBox();
  mesh.geometry.computeBoundingSphere();
}

function collectVertices(triangles: number[], idx: ArrayLike<number> | null): Set<number> {
  const touched = new Set<number>();
  for (const t of triangles) {
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx[t * 3 + k] : t * 3 + k;
      touched.add(vi);
    }
  }
  return touched;
}

/** Per-vertex weight array (0..1) for a triangle selection, from per-tri weights. */
export function vertexWeightsFromTri(
  mesh: MeshData,
  triangles: number[],
  triWeights: Float32Array | null,
): Float32Array {
  const vw = new Float32Array(mesh.geometry.getAttribute('position').count);
  if (!triWeights) return vw;
  const idx = mesh.index;
  for (const t of triangles) {
    const w = triWeights[t];
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx[t * 3 + k] : t * 3 + k;
      if (w > vw[vi]) vw[vi] = w;
    }
  }
  return vw;
}
