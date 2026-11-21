import * as THREE from 'three';
import type { MeshData } from './types';
import { METER_TO_UNIT } from './units';
import type { MeasurementUnits } from './units';

export interface TransformValues {
  rotX: number; // degrees
  rotY: number;
  rotZ: number;
  tx: number;
  ty: number;
  tz: number;
  sx: number;
  sy: number;
  sz: number;
}

export const DEFAULT_TRANSFORM: TransformValues = {
  rotX: 0, rotY: 0, rotZ: 0,
  tx: 0, ty: 0, tz: 0,
  sx: 1, sy: 1, sz: 1,
};

export function transformChanged(t: TransformValues): boolean {
  return (
    t.rotX !== 0 || t.rotY !== 0 || t.rotZ !== 0 ||
    t.tx !== 0 || t.ty !== 0 || t.tz !== 0 ||
    t.sx !== 1 || t.sy !== 1 || t.sz !== 1
  );
}

/**
 * TransformControls' planar scale handles (XY/YZ/XZ) compute an INDEPENDENT
 * factor per axis, so dragging diagonally stretches one axis more than the
 * other. A plane handle should scale both axes by the same ratio: average the
 * two per-axis factors and apply that single factor to both.
 * Single-axis handles and the uniform XYZ handle pass through unchanged.
 */
export function planarScaleRatios(
  axis: string | null | undefined,
  rx: number,
  ry: number,
  rz: number,
): { x: number; y: number; z: number } {
  if (axis === 'XY') {
    const r = (rx + ry) / 2;
    return { x: r, y: r, z: 1 };
  }
  if (axis === 'YZ') {
    const r = (ry + rz) / 2;
    return { x: 1, y: r, z: r };
  }
  if (axis === 'XZ') {
    const r = (rx + rz) / 2;
    return { x: r, y: 1, z: r };
  }
  return { x: rx, y: ry, z: rz };
}

/** Rotation pivot: bounding-box center of the current (already baked) geometry. */
export function geometryCenter(mesh: MeshData): THREE.Vector3 {
  mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox!.getCenter(new THREE.Vector3());
}

/**
 * Full matrix for pending transform values:
 *   M = T(translation) * T(center) * R * S * T(-center)
 * Rotation and scale happen around the geometry bbox center, like Blender's
 * median-point pivot; translation is applied after, in world axes.
 */
export function computeMatrix(mesh: MeshData, t: TransformValues): THREE.Matrix4 {
  const out = new THREE.Matrix4();
  if (!transformChanged(t)) return out;
  const c = geometryCenter(mesh);
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(t.rotX),
    THREE.MathUtils.degToRad(t.rotY),
    THREE.MathUtils.degToRad(t.rotZ),
    'XYZ',
  );
  out.makeTranslation(t.tx, t.ty, t.tz);
  out.multiply(new THREE.Matrix4().makeTranslation(c.x, c.y, c.z));
  out.multiply(new THREE.Matrix4().makeRotationFromEuler(euler));
  out.multiply(new THREE.Matrix4().makeScale(t.sx, t.sy, t.sz));
  out.multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
  return out;
}

/** Bake pending transform into geometry position + normal buffers. */
export function applyTransform(mesh: MeshData, t: TransformValues): void {
  if (!transformChanged(t)) return;
  bakeMatrix(mesh, computeMatrix(mesh, t), null);
}

/** Apply pending transform only to the given vertex indices (segment selection). */
export function applyTransformToVertices(
  mesh: MeshData,
  t: TransformValues,
  vertexIndices: ArrayLike<number>,
  pivotOverride?: THREE.Vector3,
): void {
  if (!transformChanged(t) || vertexIndices.length === 0) return;
  const pivot = pivotOverride ?? geometryCenter(mesh);
  const c = pivot;
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(t.rotX),
    THREE.MathUtils.degToRad(t.rotY),
    THREE.MathUtils.degToRad(t.rotZ),
    'XYZ',
  );
  const matrix = new THREE.Matrix4()
    .makeTranslation(t.tx, t.ty, t.tz)
    .multiply(new THREE.Matrix4().makeTranslation(c.x, c.y, c.z))
    .multiply(new THREE.Matrix4().makeRotationFromEuler(euler))
    .multiply(new THREE.Matrix4().makeScale(t.sx, t.sy, t.sz))
    .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
  bakeMatrix(mesh, matrix, vertexIndices);
}

function bakeMatrix(
  mesh: MeshData,
  matrix: THREE.Matrix4,
  only: ArrayLike<number> | null,
): void {
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const nor = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const arr = pos.array as Float32Array;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const nm = new THREE.Matrix3().getNormalMatrix(matrix);
  const count = only ? only.length : pos.count;

  for (let k = 0; k < count; k++) {
    const i = only ? only[k] : k;
    v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    arr[i * 3] = v.x;
    arr[i * 3 + 1] = v.y;
    arr[i * 3 + 2] = v.z;
    if (nor) {
      n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      const na = nor.array as Float32Array;
      na[i * 3] = n.x;
      na[i * 3 + 1] = n.y;
      na[i * 3 + 2] = n.z;
    }
  }
  pos.needsUpdate = true;
  if (nor) nor.needsUpdate = true;
  mesh.geometry.computeBoundingBox();
  mesh.geometry.computeBoundingSphere();
}

export interface NormalizationResult {
  scale: number;
  offset: THREE.Vector3;
  heightMeters: number;
}

/**
 * R7 normalization: uniform scale so the box's max dimension == 1 m,
 * center XZ, feet (bbox min Y) at y = 0. One box for the WHOLE scene — never
 * per mesh, or a multi-mesh assembly collapses onto the origin.
 */
export function computeNormalizationForBox(box: THREE.Box3): NormalizationResult {
  if (box.isEmpty()) {
    return { scale: 1, offset: new THREE.Vector3(), heightMeters: 0 };
  }
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = maxDim > 1e-9 ? 1 / maxDim : 1;
  const center = box.getCenter(new THREE.Vector3());
  const offset = new THREE.Vector3(-center.x, -box.min.y, -center.z);
  return { scale, offset, heightMeters: size.y * scale };
}

/** Single-mesh convenience wrapper. */
export function computeNormalization(mesh: MeshData): NormalizationResult {
  mesh.geometry.computeBoundingBox();
  return computeNormalizationForBox(mesh.geometry.boundingBox!);
}

export function normalizationSummaryForBox(box: THREE.Box3, units: MeasurementUnits): string {
  const r = computeNormalizationForBox(box);
  const u = METER_TO_UNIT[units];
  const f = (x: number) => (x * u).toFixed(2);
  // The export matrix is S·T (translate first, then scale), so describe that
  // order with the pre-scale offset.
  return `translate (${f(r.offset.x)}, ${f(r.offset.y)}, ${f(r.offset.z)}) ${units}, then scale ×${r.scale.toFixed(4)}`;
}

export function normalizationSummary(mesh: MeshData, units: MeasurementUnits): string {
  mesh.geometry.computeBoundingBox();
  return normalizationSummaryForBox(mesh.geometry.boundingBox!, units);
}
