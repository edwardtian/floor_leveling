import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import type { MeshData } from './types';
import { collectMeshes, makeMeshData, fileExtension } from './modelUtils';
import { t } from './i18n';

export interface ImportResult {
  root: THREE.Group;
  meshes: MeshData[];
  warnings: string[];
}

/**
 * Load a model file into a flat group of meshes.
 * Each mesh's node world transform is BAKED into the geometry buffers (with
 * normals), so what you see in the editor is exactly where the file places
 * the model — original scale/units preserved (Q6). Node transforms are then
 * identity, so the editor's pending-transform math starts from a clean state.
 * The whole model is recentered in XZ to the world origin (Y untouched).
 */
export async function importModel(file: File): Promise<ImportResult> {
  const ext = fileExtension(file.name);
  const buffer = await file.arrayBuffer();
  const warnings: string[] = [];

  let root: THREE.Object3D;
  if (ext === 'glb' || ext === 'gltf') {
    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(buffer, '');
    root = gltf.scene;
    if (gltf.animations && gltf.animations.length > 0) {
      warnings.push(t('import.animationIgnored', { n: gltf.animations.length }));
    }
  } else if (ext === 'fbx') {
    const loader = new FBXLoader();
    root = loader.parse(buffer as ArrayBuffer, '');
    if ((root as any).animations?.length) {
      warnings.push(t('import.animationIgnored', { n: (root as any).animations.length }));
    }
  } else if (ext === 'obj') {
    const text = new TextDecoder().decode(buffer as ArrayBuffer);
    const loader = new OBJLoader();
    root = loader.parse(text);
    warnings.push(t('import.objMaterials'));
  } else {
    throw new Error(t('import.unsupported', { ext }));
  }

  const group = new THREE.Group();
  group.name = 'ImportedModel';

  const rawMeshes = collectMeshes(root);
  if (rawMeshes.length === 0) throw new Error(t('import.noMeshes'));

  const meshes: MeshData[] = [];
  rawMeshes.forEach((mesh, i) => {
    mesh.updateWorldMatrix(true, false);
    const skinned = (mesh as any).isSkinnedMesh === true;
    if (skinned) warnings.push(t('import.skinned', { name: mesh.name || i }));

    const geom = mesh.geometry.clone();
    geom.applyMatrix4(mesh.matrixWorld); // transforms positions + normals + tangents

    const newMesh = new THREE.Mesh(geom, mesh.material ?? defaultMaterial());
    newMesh.name = mesh.name || `mesh_${i}`;
    group.add(newMesh);
    meshes.push(makeMeshData(newMesh, newMesh.name));
  });

  // Recenter XZ so the model sits at the world origin (Y untouched).
  const box = new THREE.Box3().setFromObject(group);
  if (!box.isEmpty()) {
    const c = box.getCenter(new THREE.Vector3());
    const m = new THREE.Matrix4().makeTranslation(-c.x, 0, -c.z);
    for (const md of meshes) md.geometry.applyMatrix4(m);
  }

  return { root: group, meshes, warnings };
}

function defaultMaterial(): THREE.Material {
  return new THREE.MeshStandardMaterial({ color: 0xb0b6bf, roughness: 0.85, metalness: 0.05 });
}
