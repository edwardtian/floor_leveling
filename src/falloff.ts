/**
 * Vertex falloff weights: 1 deep inside a cell, smoothly to 0 at the cell
 * border, using a breadth-first graph distance over the triangle adjacency,
 * measured in *edge hops* (robust for stretched/degenerate triangles).
 *
 * A vertex whose ALL adjacent triangles belong to the same cell is interior.
 * Vertices at cell borders (adjacent triangles in ≥2 cells) are band seeds.
 * Weight = smoothstep(0, bandHops, hopDistanceFromBorder) where hopDistance
 * counts graph edges; bandHops ≈ falloffRatio * sqrt(cell triangle count).
 */

import * as THREE from 'three';
import type { MeshData } from './types';

/**
 * Triangle adjacency via shared edges, using POSITION-WELDED vertices:
 * many real-world meshes (AI/scan exports, flat-shaded exports) duplicate
 * vertices per face, so index-based adjacency collapses. Vertices with
 * (nearly) identical coordinates are treated as the same topological vertex.
 */
export function buildTriangleAdjacency(mesh: MeshData): number[][] {
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const n = pos.count;
  const index = mesh.index;
  const triCount = mesh.triCount;

  // Canonical vertex ids by quantized position (1e-5 m = 0.01 mm weld).
  const quant = new Map<string, number>();
  const canon = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const key =
      Math.round(arr[i * 3] * 1e5) + ',' +
      Math.round(arr[i * 3 + 1] * 1e5) + ',' +
      Math.round(arr[i * 3 + 2] * 1e5);
    let c = quant.get(key);
    if (c === undefined) {
      c = quant.size;
      quant.set(key, c);
    }
    canon[i] = c;
  }
  const tv = (t: number, k: number): number => canon[index ? index[t * 3 + k] : t * 3 + k];

  // Triangle-triangle adjacency via shared canonical edges.
  const adj: number[][] = new Array(triCount);
  for (let t = 0; t < triCount; t++) adj[t] = [];
  const edgeMap = new Map<string, number>();
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tv(t, k);
      const b = tv(t, (k + 1) % 3);
      if (a === b) continue;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const other = edgeMap.get(key);
      if (other !== undefined) {
        if (other !== t) {
          adj[t].push(other);
          adj[other].push(t);
        }
      } else {
        edgeMap.set(key, t);
      }
    }
  }
  return adj;
}

// ---------- topology caches (shared by all tools) ----------

const adjacencyCache = new WeakMap<THREE.BufferGeometry, number[][]>();
const canonCache = new WeakMap<THREE.BufferGeometry, { canon: Int32Array; count: number }>();

/** Triangle adjacency (position-welded), cached per geometry. */
export function getAdjacency(mesh: MeshData): number[][] {
  let adj = adjacencyCache.get(mesh.geometry);
  if (!adj) {
    adj = buildTriangleAdjacency(mesh);
    adjacencyCache.set(mesh.geometry, adj);
  }
  return adj;
}

/** Canonical (welded) vertex mapping, cached per geometry. */
export function getCanonicalVerts(mesh: MeshData): { canon: Int32Array; count: number } {
  let entry = canonCache.get(mesh.geometry);
  if (!entry) {
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const n = pos.count;
    const quant = new Map<string, number>();
    const canon = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const key =
        Math.round(arr[i * 3] * 1e5) + ',' +
        Math.round(arr[i * 3 + 1] * 1e5) + ',' +
        Math.round(arr[i * 3 + 2] * 1e5);
      let c = quant.get(key);
      if (c === undefined) {
        c = quant.size;
        quant.set(key, c);
      }
      canon[i] = c;
    }
    entry = { canon, count: quant.size };
    canonCache.set(mesh.geometry, entry);
  }
  return entry;
}

/** Drop cached topology after geometry edits (positions changed). */
export function invalidateTopologyCache(mesh: MeshData): void {
  adjacencyCache.delete(mesh.geometry);
  canonCache.delete(mesh.geometry);
}

/**
 * Per-vertex weights for a triangle selection, WELDED: coincident (duplicate)
 * vertices share the max weight of their canonical group, so duplicated-vertex
 * meshes deform without cracking along the falloff band.
 */
export function weldedVertexWeights(
  mesh: MeshData,
  triangles: number[],
  triWeights: Float32Array,
): Float32Array {
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const { canon, count } = getCanonicalVerts(mesh);
  const byCanon = new Float32Array(count);
  const idx = mesh.index;
  for (const t of triangles) {
    const w = triWeights[t];
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx[t * 3 + k] : t * 3 + k;
      const c = canon[vi];
      if (w > byCanon[c]) byCanon[c] = w;
    }
  }
  const vw = new Float32Array(n);
  for (let i = 0; i < n; i++) vw[i] = byCanon[canon[i]];
  return vw;
}

/**
 * Falloff for an arbitrary *selection* of triangles (segment selection or a
 * picked floor area): 1 deep inside the selection, smoothly to 0 across a
 * transition band at the selection boundary (measured in adjacency hops).
 * This is what makes edited regions blend smoothly into untouched geometry.
 */
export function selectionFalloff(
  adjacency: number[][],
  selectedTris: Set<number>,
  bandHops: number,
): Float32Array {
  const n = adjacency.length;
  const w = new Float32Array(n); // per triangle, 0 = untouched
  if (selectedTris.size === 0) return w;
  if (bandHops < 0.5) {
    for (const t of selectedTris) w[t] = 1;
    return w;
  }

  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;

  // Seed: selected triangles that touch unselected ones (or the open border).
  for (const t of selectedTris) {
    const nbrs = adjacency[t];
    let border = nbrs.length < 3;
    if (!border) {
      for (let i = 0; i < nbrs.length; i++) {
        if (!selectedTris.has(nbrs[i])) {
          border = true;
          break;
        }
      }
    }
    if (border) {
      dist[t] = 0;
      queue[tail++] = t;
    }
  }
  // BFS inside the selection only.
  while (head < tail) {
    const t = queue[head++];
    const d = dist[t];
    if (d >= bandHops) continue;
    const nbrs = adjacency[t];
    for (let i = 0; i < nbrs.length; i++) {
      const nt = nbrs[i];
      if (selectedTris.has(nt) && dist[nt] === -1) {
        dist[nt] = d + 1;
        queue[tail++] = nt;
      }
    }
  }
  for (const t of selectedTris) {
    const d = dist[t];
    if (d < 0 || d >= bandHops) {
      w[t] = 1;
    } else {
      const x = d / bandHops;
      w[t] = x * x * (3 - 2 * x);
    }
  }
  return w;
}
