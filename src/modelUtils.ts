import * as THREE from 'three';
import type { MeshData } from './types';
import { METER_TO_UNIT, type MeasurementUnits } from './units';

/** Strip lights/cameras/armatures from an imported scene root; keep meshes. */
export function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if ((mesh as any).isMesh && mesh.geometry?.attributes?.position) out.push(mesh);
  });
  return out;
}

export function makeMeshData(mesh: THREE.Mesh, name: string): MeshData {
  const geometry = mesh.geometry;
  geometry.computeBoundingBox();
  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : geometry.getAttribute('position').count / 3;
  return {
    object: mesh,
    geometry,
    index: index ? (index.array as ArrayLike<number>) : null,
    triCount: Math.floor(triCount),
    name,
  };
}

/** Total triangle count across meshes. */
export function totalTriangles(meshes: MeshData[]): number {
  return meshes.reduce((s, m) => s + m.triCount, 0);
}

/** Total vertex count across meshes. */
export function totalVertices(meshes: MeshData[]): number {
  return meshes.reduce((s, m) => s + m.geometry.getAttribute('position').count, 0);
}

/** Unified bbox across all meshes (world space — roots are at identity). */
export function sceneBox(meshes: MeshData[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const m of meshes) {
    m.geometry.computeBoundingBox();
    box.expandByObject(m.object);
  }
  return box;
}

export function formatBox(box: THREE.Box3, units: MeasurementUnits): string {
  const size = box.getSize(new THREE.Vector3());
  const u = METER_TO_UNIT[units];
  return `${(size.x * u).toFixed(2)} × ${(size.y * u).toFixed(2)} × ${(size.z * u).toFixed(2)} ${units === 'meter' ? 'm' : 'cm'}`;
}

export function fileExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function baseName(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(0, i) : name;
}

export function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_') || 'model';
}

export function downloadBlob(data: ArrayBuffer | Blob, filename: string): void {
  const blob = data instanceof Blob ? data : new Blob([data]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
