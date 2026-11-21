import * as THREE from 'three';
import type { MeshData } from './types';

/**
 * World-space frame of the floor plane: position, orientation and extents.
 * The plane may be tilted — all leveling math works on signed distances
 * along the plane normal, not world Y.
 */
export interface FloorFrame {
  /** Unit normal (the plane's local +Y in world space). */
  normal: THREE.Vector3;
  /** Plane center in world space. */
  point: THREE.Vector3;
  /** Unit axis along the plane's local X (its width direction). */
  xAxis: THREE.Vector3;
  /** Unit axis along the plane's local Z (its depth direction). */
  zAxis: THREE.Vector3;
  /** Half extent along xAxis. */
  halfX: number;
  /** Half extent along zAxis. */
  halfZ: number;
}

/**
 * Distance from the plane within which a vertex counts as ON the plane.
 * 0.1 mm — larger than float32 noise on scene-scale coordinates, small enough
 * that a brushed patch is recognized as level.
 */
export const PLANE_EPS = 1e-4;

/**
 * Floor plane intersection: find faces whose triangles cross the plane
 * (or sit fully below it) within the plane's footprint. "Below" means a
 * negative signed distance along the plane normal — correct for tilted
 * planes too.
 *
 * The result distinguishes the three states the highlight uses:
 *  - `crossing` triangles truly straddle the plane (one vertex above, one
 *    below) — the accurate intersection band;
 *  - `onPlane` triangles lie flat on the plane (brushed/leveled patches);
 *  - `triangles` = crossing + fully-buried triangles below the plane, the
 *    set Drop/Flatten operate on.
 * `segments` is the exact triangle/plane cut line (flat xyz pairs) for a
 * crisp contour overlay.
 */
export interface PlaneIntersection {
  /** Triangles inside the footprint with at least one vertex below the plane. */
  triangles: number[];
  /** Triangles that truly straddle the plane. */
  crossing: number[];
  /** Triangles lying flat on the plane (all vertices within PLANE_EPS). */
  onPlane: number[];
  /** Exact cut segments as flat [x1,y1,z1, x2,y2,z2, ...] world positions. */
  segments: number[];
  /** World-Y of the lowest intersecting vertex (display only). */
  minY: number;
}

/** Scratch for trianglePlaneCut (single-threaded, no reentrancy). */
const CUT_POINTS = new Float64Array(9);
/** Squared dedupe distance for cut points (0.1 mm). */
const CUT_DEDUPE2 = 1e-8;

/** Add a cut point unless it duplicates an existing one; returns new count. */
function addCutPoint(n: number, x: number, y: number, z: number): number {
  for (let k = 0; k < n; k++) {
    const dx = CUT_POINTS[k * 3] - x;
    const dy = CUT_POINTS[k * 3 + 1] - y;
    const dz = CUT_POINTS[k * 3 + 2] - z;
    if (dx * dx + dy * dy + dz * dz <= CUT_DEDUPE2) return n;
  }
  if (n < 3) {
    CUT_POINTS[n * 3] = x;
    CUT_POINTS[n * 3 + 1] = y;
    CUT_POINTS[n * 3 + 2] = z;
    return n + 1;
  }
  return n;
}

/**
 * Intersection points of one triangle with the plane, written to CUT_POINTS.
 * Returns 2 for a proper cut segment (or an edge lying on the plane), 3 for
 * a coplanar triangle, 1 for a tangent point, 0 for no contact.
 */
function trianglePlaneCut(
  arr: Float32Array,
  i0: number, i1: number, i2: number,
  s0: number, s1: number, s2: number,
  eps: number,
): number {
  let n = 0;
  if (Math.abs(s0) <= eps) n = addCutPoint(n, arr[i0 * 3], arr[i0 * 3 + 1], arr[i0 * 3 + 2]);
  if (Math.abs(s1) <= eps) n = addCutPoint(n, arr[i1 * 3], arr[i1 * 3 + 1], arr[i1 * 3 + 2]);
  if (Math.abs(s2) <= eps) n = addCutPoint(n, arr[i2 * 3], arr[i2 * 3 + 1], arr[i2 * 3 + 2]);

  const edge = (ia: number, ib: number, sa: number, sb: number): void => {
    if ((sa > eps && sb < -eps) || (sa < -eps && sb > eps)) {
      const t = sa / (sa - sb);
      const x = arr[ia * 3] + (arr[ib * 3] - arr[ia * 3]) * t;
      const y = arr[ia * 3 + 1] + (arr[ib * 3 + 1] - arr[ia * 3 + 1]) * t;
      const z = arr[ia * 3 + 2] + (arr[ib * 3 + 2] - arr[ia * 3 + 2]) * t;
      n = addCutPoint(n, x, y, z);
    }
  };
  edge(i0, i1, s0, s1);
  edge(i1, i2, s1, s2);
  edge(i2, i0, s2, s0);
  return n;
}

export function intersectFloorPlane(mesh: MeshData, frame: FloorFrame): PlaneIntersection {
  const triangles: number[] = [];
  const crossing: number[] = [];
  const onPlane: number[] = [];
  const segments: number[] = [];
  let minY = Infinity;

  const n = frame.normal;
  const px = frame.point.x;
  const py = frame.point.y;
  const pz = frame.point.z;
  const ax = frame.xAxis;
  const az = frame.zAxis;
  const eps = PLANE_EPS;

  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const idx = mesh.index;

  for (let t = 0; t < mesh.triCount; t++) {
    const i0 = idx ? idx[t * 3] : t * 3;
    const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
    const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;

    const s0 = n.x * (arr[i0 * 3] - px) + n.y * (arr[i0 * 3 + 1] - py) + n.z * (arr[i0 * 3 + 2] - pz);
    const s1 = n.x * (arr[i1 * 3] - px) + n.y * (arr[i1 * 3 + 1] - py) + n.z * (arr[i1 * 3 + 2] - pz);
    const s2 = n.x * (arr[i2 * 3] - px) + n.y * (arr[i2 * 3 + 1] - py) + n.z * (arr[i2 * 3 + 2] - pz);

    const minS = s0 < s1 ? (s0 < s2 ? s0 : s2) : (s1 < s2 ? s1 : s2);
    const maxS = s0 > s1 ? (s0 > s2 ? s0 : s2) : (s1 > s2 ? s1 : s2);
    const hasBelow = minS < -eps;
    const hasAbove = maxS > eps;
    const isCrossing = hasBelow && hasAbove;
    const isOnPlane = !isCrossing && minS >= -eps && maxS <= eps;
    if (!hasBelow && !isOnPlane) continue;

    // Footprint test: triangle centroid projected into the plane's local axes.
    const cx = (arr[i0 * 3] + arr[i1 * 3] + arr[i2 * 3]) / 3;
    const cy = (arr[i0 * 3 + 1] + arr[i1 * 3 + 1] + arr[i2 * 3 + 1]) / 3;
    const cz = (arr[i0 * 3 + 2] + arr[i1 * 3 + 2] + arr[i2 * 3 + 2]) / 3;
    const u = ax.x * (cx - px) + ax.y * (cy - py) + ax.z * (cz - pz);
    const w = az.x * (cx - px) + az.y * (cy - py) + az.z * (cz - pz);
    if (u < -frame.halfX - eps || u > frame.halfX + eps || w < -frame.halfZ - eps || w > frame.halfZ + eps) {
      continue;
    }

    if (hasBelow) {
      const m = Math.min(arr[i0 * 3 + 1], arr[i1 * 3 + 1], arr[i2 * 3 + 1]);
      if (m < minY) minY = m;
      triangles.push(t);
    }
    if (isCrossing) crossing.push(t);
    if (isOnPlane) onPlane.push(t);

    // Exact cut contour: proper crossings plus edges lying on the plane.
    if (isCrossing || (hasBelow && maxS >= -eps)) {
      const cut = trianglePlaneCut(arr, i0, i1, i2, s0, s1, s2, eps);
      if (cut === 2) {
        segments.push(
          CUT_POINTS[0], CUT_POINTS[1], CUT_POINTS[2],
          CUT_POINTS[3], CUT_POINTS[4], CUT_POINTS[5],
        );
      }
    }
  }

  return {
    triangles,
    crossing,
    onPlane,
    segments,
    minY: triangles.length ? minY : 0,
  };
}

/** Signed distance of a vertex (from the position array) to the plane. */
function signedDist(
  n: THREE.Vector3,
  px: number,
  py: number,
  pz: number,
  arr: Float32Array,
  vi: number,
): number {
  return n.x * (arr[vi * 3] - px) + n.y * (arr[vi * 3 + 1] - py) + n.z * (arr[vi * 3 + 2] - pz);
}

/**
 * Leveling — drop mode: translate the selection rigidly ALONG THE PLANE
 * NORMAL so its deepest point lands on the plane; the falloff weights blend
 * the motion at the border. Any selected vertex still below the plane
 * afterwards (band verts whose weight < 1) is clamped onto the plane.
 * Works for tilted planes: the motion direction is the plane normal.
 */
export function dropToPlane(
  mesh: MeshData,
  triangles: number[],
  frame: FloorFrame,
  vertexWeights: Float32Array | null,
): number {
  if (triangles.length === 0) return 0;
  const n = frame.normal;
  const px = frame.point.x;
  const py = frame.point.y;
  const pz = frame.point.z;

  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const idx = mesh.index;
  const touched = collectVertices(triangles, idx);

  let minS = Infinity;
  for (const vi of touched) {
    const s = signedDist(n, px, py, pz, arr, vi);
    if (s < minS) minS = s;
  }
  const shift = -minS; // world distance to move along +normal
  if (Math.abs(shift) > 1e-9) {
    for (const vi of touched) {
      const w = vertexWeights ? vertexWeights[vi] : 1;
      arr[vi * 3] += n.x * shift * w;
      arr[vi * 3 + 1] += n.y * shift * w;
      arr[vi * 3 + 2] += n.z * shift * w;
    }
  }
  // Post-clamp: level any touched vertex that remains below the plane.
  for (const vi of touched) {
    const s = signedDist(n, px, py, pz, arr, vi);
    if (s < 0) {
      arr[vi * 3] -= n.x * s;
      arr[vi * 3 + 1] -= n.y * s;
      arr[vi * 3 + 2] -= n.z * s;
    }
  }
  pos.needsUpdate = true;
  mesh.geometry.computeBoundingBox();
  mesh.geometry.computeBoundingSphere();
  return shift;
}

/**
 * Leveling — flatten mode: each vertex below the plane (negative signed
 * distance) is pulled onto it along the normal, weighted by the falloff.
 */
export function flattenToPlane(
  mesh: MeshData,
  triangles: number[],
  frame: FloorFrame,
  vertexWeights: Float32Array | null,
): void {
  if (triangles.length === 0) return;
  const n = frame.normal;
  const px = frame.point.x;
  const py = frame.point.y;
  const pz = frame.point.z;

  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const idx = mesh.index;
  const touched = collectVertices(triangles, idx);
  for (const vi of touched) {
    const s = signedDist(n, px, py, pz, arr, vi);
    if (s >= 0) continue;
    const w = vertexWeights ? vertexWeights[vi] : 1;
    arr[vi * 3] -= n.x * s * w;
    arr[vi * 3 + 1] -= n.y * s * w;
    arr[vi * 3 + 2] -= n.z * s * w;
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
