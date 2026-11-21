import * as THREE from 'three';
import type { BrushCurve, BrushSettings, MeshData } from './types';
import type { FloorFrame } from './leveling';

/**
 * Floor brush math.
 *
 * The brush is a SPHERE centered on the floor plane at the cursor. Only
 * vertices inside the sphere are touched ("only the nearest vertices"), so
 * brushing the bottom of a tall model never yanks its distant top down.
 *
 * Every affected vertex is moved along the plane normal TOWARD the plane:
 * vertices above are pushed down, vertices below are pulled up. The distance
 * moved is `|signed distance| * weight`, so weight 1 snaps exactly onto the
 * plane and the falloff band eases the transition into untouched geometry.
 */

/** Classic smoothstep on 0…1. */
function smoothstep01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/**
 * Falloff shape across the transition band, normalized so u=0 → 1 and
 * u=1 → 0. `hardness` 0 = soft/wide shoulder, 1 = steeper transition
 * (sharper edge).
 */
export function falloffWeight(u: number, curve: BrushCurve, hardness: number): number {
  const t = Math.min(1, Math.max(0, u));
  const h = Math.min(1, Math.max(0, hardness));
  if (curve === 'gaussian') {
    // Normalized Gaussian: subtract its value at t=1 so the edge is exactly 0.
    const k = 1.5 * Math.pow(2, 2 * h); // 1.5 (soft) … 6 (hard)
    const tail = Math.exp(-k);
    return (Math.exp(-k * t * t) - tail) / (1 - tail);
  }
  // Smooth Step with an adjustable shoulder: exponent 0.5 (soft) … 2 (hard).
  const e = Math.pow(2, 2 * h - 1);
  return 1 - smoothstep01(Math.pow(t, e));
}

/**
 * Weight of a vertex at 3D distance `distance` from the brush center:
 * 1 inside the falloff (core) radius, shaped falloff to 0 at the brush
 * radius, multiplied by the strength.
 */
export function brushWeightAt(distance: number, s: BrushSettings): number {
  const radius = Math.max(1e-6, s.radius);
  if (distance >= radius) return 0;
  const core = Math.min(Math.max(0, s.falloffRadius), radius);
  const band = radius - core;
  let w = 1;
  if (distance > core && band > 1e-9) {
    w = falloffWeight((distance - core) / band, s.curve, s.hardness);
  }
  const strength = Math.min(1, Math.max(0, s.strength));
  return Math.max(0, Math.min(1, w * strength));
}

export interface BrushDabResult {
  /** Vertices inside the brush sphere (weight > 0). */
  affected: number;
  /** Vertices actually displaced by this dab. */
  moved: number;
  /** Largest displacement applied (meters). */
  maxShift: number;
}

/**
 * Apply one brush dab at `center` (a world-space point on the floor plane).
 * Mutates the position buffer in place and returns a small report for the UI.
 */
export function applyBrushDab(
  mesh: MeshData,
  frame: FloorFrame,
  center: THREE.Vector3,
  settings: BrushSettings,
): BrushDabResult {
  const result: BrushDabResult = { affected: 0, moved: 0, maxShift: 0 };
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return result;
  const arr = pos.array as Float32Array;
  const count = pos.count;
  const n = frame.normal;
  const px = frame.point.x;
  const py = frame.point.y;
  const pz = frame.point.z;

  const radius = Math.max(1e-6, settings.radius);
  const r2 = radius * radius;
  const strength = Math.min(1, Math.max(0, settings.strength));
  if (strength <= 0) return result;

  for (let i = 0; i < count; i++) {
    const ix = i * 3;
    const dx = arr[ix] - center.x;
    const dy = arr[ix + 1] - center.y;
    const dz = arr[ix + 2] - center.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) continue;

    const w = brushWeightAt(Math.sqrt(d2), settings);
    if (w <= 1e-6) continue;
    result.affected++;

    const signed = n.x * (arr[ix] - px) + n.y * (arr[ix + 1] - py) + n.z * (arr[ix + 2] - pz);
    if (Math.abs(signed) < 1e-7) continue; // already on the plane
    const shift = -signed * w;
    if (Math.abs(shift) < 1e-9) continue;

    arr[ix] += n.x * shift;
    arr[ix + 1] += n.y * shift;
    arr[ix + 2] += n.z * shift;
    result.moved++;
    const absShift = Math.abs(shift);
    if (absShift > result.maxShift) result.maxShift = absShift;
  }

  if (result.moved) {
    pos.needsUpdate = true;
    mesh.geometry.computeBoundingBox();
    mesh.geometry.computeBoundingSphere();
  }
  return result;
}

/**
 * Collect vertices the brush would touch (weight > minWeight) into caller
 * supplied scratch arrays. Used for the live vertex preview. Returns the
 * number of hits; `outIndices` / `outWeights` must hold at least pos.count
 * entries.
 */
export function collectBrushHits(
  mesh: MeshData,
  center: THREE.Vector3,
  settings: BrushSettings,
  outIndices: Int32Array,
  outWeights: Float32Array,
  minWeight = 0.02,
): number {
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return 0;
  const arr = pos.array as Float32Array;
  const count = pos.count;
  const radius = Math.max(1e-6, settings.radius);
  const r2 = radius * radius;
  let n = 0;
  for (let i = 0; i < count && n < outIndices.length; i++) {
    const ix = i * 3;
    const dx = arr[ix] - center.x;
    const dy = arr[ix + 1] - center.y;
    const dz = arr[ix + 2] - center.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) continue;
    const w = brushWeightAt(Math.sqrt(d2), settings);
    if (w < minWeight) continue;
    outIndices[n] = i;
    outWeights[n] = w;
    n++;
  }
  return n;
}
