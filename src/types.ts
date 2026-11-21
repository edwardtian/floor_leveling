import * as THREE from 'three';

/** Units for display; scene space is always meters (1 unit = 1 m). */
export type MeasurementUnits = 'meter' | 'centimeter';

/** A tool identifier. */
export type ToolId = 'select' | 'transform' | 'ffd' | 'floor' | 'ref';

/** Free-Form Deformation lattice settings (3ds Max FFD box style). */
export interface FFDSettings {
  /** Control points along X / Y / Z (≥2 each). */
  nx: number;
  ny: number;
  nz: number;
  /** Extra lattice margin around the mesh bbox (fraction of bbox size, 0..0.5). */
  margin: number;
}

export type SegAxis = 'x' | 'y' | 'z';

/** Segment grid settings. */
export interface SegmentSettings {
  axisA: SegAxis;
  axisB: SegAxis;
  countA: number;
  countB: number;
  /** 0..0.6 — portion of the average cell radius used as the smooth transition band (in graph hops). */
  falloffRatio: number;
}

/** One segment: a cell of the N×M grid with its owned triangles (per-triangle centroid rule). */
export interface Segment {
  id: number;
  ia: number;
  ib: number;
  /** Triangle indices owned by this cell. */
  triangles: number[];
  /** All vertex indices touched by owned triangles. */
  vertexSet: Set<number>;
  /** Bounding box of owned triangles (positions at build time). */
  bbox: THREE.Box3;
}

/** Per-object segmentation state. */
export interface Segmentation {
  meshUuid: string;
  settings: SegmentSettings;
  segments: Segment[];
  /** triangleIndex -> segment id. */
  triToSegment: Int32Array;
  /** Selected segment ids. */
  selected: Set<number>;
  /** Falloff band width in adjacency hops. */
  falloffHops: number;
  /** Grid mapping (for rect-select → cell lookup). */
  minA: number;
  minB: number;
  spanA: number;
  spanB: number;
}

/** Settings for the floor plane tool. */
export interface FloorSettings {
  sizeX: number;
  sizeZ: number;
  /** Plane height (scene units = meters). */
  y: number;
  /** Plane center in XZ. */
  cx: number;
  cz: number;
}

/** Falloff curve shapes available to the floor brush. */
export type BrushCurve = 'smoothstep' | 'gaussian';

/**
 * Floor brush settings: a spherical brush centered where the cursor meets the
 * floor plane. Vertices inside the sphere are snapped toward the plane (push
 * down above it, pull up below it) with a smooth falloff.
 */
export interface BrushSettings {
  /** Outer radius of the brush sphere (meters). */
  radius: number;
  /** Radius of the full-strength core (meters, 0 … radius). */
  falloffRadius: number;
  /** Shape of the falloff band between falloffRadius and radius. */
  curve: BrushCurve;
  /** 0 = soft shoulder, 1 = hard edge (shapes the curve). */
  hardness: number;
  /** 0 … 1 fraction of the snap distance applied per dab. */
  strength: number;
}

export interface RefImageSettings {
  width: number;
  height: number;
  y: number;
  angleDeg: number;
  opacity: number;
}

/** Pending object transform (R2) — applied on demand, then baked into geometry. */
export interface PendingTransform {
  rotX: number;
  rotY: number;
  rotZ: number;
  tx: number;
  ty: number;
  tz: number;
  sx: number;
  sy: number;
  sz: number;
}

export interface MeshData {
  object: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  index: ArrayLike<number> | null;
  triCount: number;
  name: string;
}
