import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import type { MeshData } from './types';
import { computeNormalizationForBox } from './transform';
import { baseName, safeName } from './modelUtils';

export interface ExportOptions {
  format: 'glb' | 'obj';
  filename: string;
  normalize: boolean;
}

/**
 * Build a clean export scene from the edited meshes:
 * clone geometries (current, baked state), optionally normalize (R7),
 * reset node transforms to identity so the buffers are the truth.
 * Floor plane / reference image / helpers are never included (Q7).
 */
export function buildExportScene(meshes: MeshData[], normalize: boolean): THREE.Group {
  const group = new THREE.Group();
  group.name = 'FloorLevelingExport';

  // Normalize the WHOLE model with one matrix. Doing this per mesh (the old
  // behavior) scaled each part to 1 m and centered it on the origin, which
  // destroys the relative placement of multi-mesh models.
  let matrix: THREE.Matrix4 | null = null;
  if (normalize) {
    const box = new THREE.Box3();
    for (const md of meshes) {
      md.geometry.computeBoundingBox();
      if (md.geometry.boundingBox) box.union(md.geometry.boundingBox);
    }
    if (!box.isEmpty()) {
      const n = computeNormalizationForBox(box);
      matrix = new THREE.Matrix4().makeTranslation(n.offset.x, n.offset.y, n.offset.z);
      // S·T: translate to the origin/feet first, then scale — the offset in
      // NormalizationResult is expressed in pre-scale units.
      matrix.premultiply(new THREE.Matrix4().makeScale(n.scale, n.scale, n.scale));
    }
  }

  for (const md of meshes) {
    const geo = md.geometry.clone();
    if (matrix) geo.applyMatrix4(matrix);
    const mesh = new THREE.Mesh(geo, (md.object as THREE.Mesh).material ?? new THREE.MeshStandardMaterial());
    mesh.name = md.name;
    group.add(mesh);
  }
  return group;
}

export async function exportModel(
  meshes: MeshData[],
  opts: ExportOptions,
): Promise<{ blob: Blob; filename: string }> {
  const scene = buildExportScene(meshes, opts.normalize);
  const base = safeName(baseName(opts.filename));

  if (opts.format === 'glb') {
    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(scene, { binary: true, onlyVisible: false });
    return { blob: new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' }), filename: `${base}.glb` };
  }
  // OBJ
  const exporter = new OBJExporter();
  const text = exporter.parse(scene);
  return { blob: new Blob([text], { type: 'text/plain' }), filename: `${base}.obj` };
}
