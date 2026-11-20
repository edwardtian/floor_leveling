import * as THREE from 'three';
import type { Editor } from './editor';
import { baseName } from './modelUtils';
import { PendingNodeTransform } from './objectTransform';
import type { History } from './history';

/**
 * Reference image tool (R3): an image on a plane the user can translate,
 * rotate and scale with the gizmo (or numeric fields). Purely a guide —
 * never exported, never segmented. Gizmo drags go through a PENDING node
 * transform (preview → Apply bakes → Reset discards), like the model's
 * Transform tool.
 */
export class RefTool {
  active = false;

  group = new THREE.Group(); // position + spin (world Y)
  private plane: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private baseW = 1;
  private baseH = 1;
  private texture: THREE.Texture | null = null;
  private imageName = '';

  private editor: Editor;
  private onChanged: () => void;

  /** Pending node transform (preview → apply/reset), like the model's. */
  readonly nodeTransform: PendingNodeTransform;

  gizmoMode: 'translate' | 'rotate' | 'scale' = 'translate';

  constructor(editor: Editor, history: History | null, onChanged: () => void) {
    this.editor = editor;
    this.onChanged = onChanged;
    this.nodeTransform = new PendingNodeTransform(editor, history, onChanged, 'RefTransformProxy');

    this.mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.plane.rotation.x = -Math.PI / 2; // horizontal by default (XZ, floor-like)
    this.plane.renderOrder = 6;
    this.group.add(this.plane);
    this.group.name = 'ReferenceImage';
    this.group.visible = false;
    editor.scene.add(this.group);
    this.nodeTransform.setTarget(this.group);
  }

  get hasImage(): boolean {
    return this.texture !== null;
  }

  get name(): string {
    return this.imageName;
  }

  setActive(v: boolean): void {
    const was = this.active;
    this.active = v;
    if (v && this.hasImage) {
      this.nodeTransform.attachGizmo(this.gizmoMode);
      this.syncFields();
    } else if (!v && was) {
      // Detach only on the active→inactive transition: other tools own the
      // gizmo while they are active, and setActive(false) runs for every
      // tool switch.
      this.editor.detachGizmo();
    }
    this.onChanged();
  }

  setGizmoMode(mode: 'translate' | 'rotate' | 'scale'): void {
    this.gizmoMode = mode;
    if (this.active && this.hasImage) this.nodeTransform.attachGizmo(mode);
  }

  /** Bake the pending transform into the image node (undoable). */
  applyTransform(): boolean {
    const ok = this.nodeTransform.apply();
    if (ok) this.onChanged();
    return ok;
  }

  /** Discard the pending transform. */
  resetTransform(): void {
    this.nodeTransform.reset();
    this.syncFields();
  }

  hasPendingTransform(): boolean {
    return this.nodeTransform.hasPending;
  }

  async loadImage(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    const loader = new THREE.TextureLoader();
    const tex = await loader.loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    if (this.texture) this.texture.dispose();
    this.texture = tex;
    this.imageName = baseName(file.name);
    this.mat.map = tex;
    this.mat.needsUpdate = true;

    // Size the plane to the image aspect, defaulting to a useful size relative
    // to the model (about 60% of its footprint), centered on the model.
    const aspect = (tex.image?.width ?? 1) / (tex.image?.height ?? 1);
    this.baseW = 1;
    this.baseH = 1 / Math.max(aspect, 1e-6);
    this.plane.geometry.dispose();
    this.plane.geometry = new THREE.PlaneGeometry(this.baseW, this.baseH);

    let footprint = 2;
    let centerY = 0;
    let minY = 0;
    this.editor.modelRoot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.editor.modelRoot);
    if (!box.isEmpty()) {
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      footprint = Math.max(size.x, size.z);
      centerY = center.y;
      minY = box.min.y;
    }
    const w = footprint * 0.6;
    const h = w / Math.max(aspect, 1e-6);
    this.group.scale.set(w, 1, h);
    this.group.position.set(0, minY + 0.01, 0);
    this.group.rotation.y = 0;
    this.group.visible = true;
    this.nodeTransform.setTarget(this.group); // fresh base, no pending
    this.onChanged();
  }

  clearImage(): void {
    if (this.texture) this.texture.dispose();
    this.texture = null;
    this.mat.map = null;
    this.mat.needsUpdate = true;
    this.imageName = '';
    this.group.visible = false;
    this.editor.detachGizmo();
    this.onChanged();
  }

  setOpacity(v: number): void {
    this.mat.opacity = THREE.MathUtils.clamp(v, 0.05, 1);
    this.onChanged();
  }

  get opacity(): number {
    return this.mat.opacity;
  }

  /** Orientation: horizontal (floor-like) or vertical (wall-like); keeps world size. */
  setOrientation(o: 'horizontal' | 'vertical'): void {
    const cur = this.getSize();
    this.plane.rotation.x = o === 'horizontal' ? -Math.PI / 2 : 0;
    this.setSize(cur.w, cur.h);
  }

  getOrientation(): 'horizontal' | 'vertical' {
    return Math.abs(this.plane.rotation.x) > 0.1 ? 'horizontal' : 'vertical';
  }

  setSize(width: number, height: number): void {
    const o = this.getOrientation();
    if (o === 'horizontal') {
      this.nodeTransform.setWorldScale({ x: width, z: height });
    } else {
      this.nodeTransform.setWorldScale({ x: width, y: height });
    }
    this.onChanged();
  }

  /** Current world-space size (width × height in meters). */
  getSize(): { w: number; h: number } {
    if (this.hasPendingTransform()) this.group.updateMatrixWorld(true);
    else this.group.updateMatrix();
    const box = new THREE.Box3().setFromObject(this.plane);
    const s = box.getSize(new THREE.Vector3());
    const o = this.getOrientation();
    return o === 'horizontal' ? { w: s.x, h: s.z } : { w: s.x, h: s.y };
  }

  /**
   * Numeric placement edits go through the SAME pending transform as the
   * Transform sub-panel (preview on type; Apply bakes; Reset discards).
   */
  setY(y: number): void {
    this.nodeTransform.setWorldPosition({ y });
    this.onChanged();
  }

  setAngleDeg(deg: number): void {
    this.nodeTransform.setWorldRotationDeg({ y: deg });
    this.onChanged();
  }

  /** Read back values after gizmo interaction. */
  syncFields(): void {
    this.onChanged();
  }

  get state(): { x: number; y: number; z: number; angleDeg: number; w: number; h: number } {
    const size = this.getSize();
    return {
      x: this.group.position.x,
      y: this.group.position.y,
      z: this.group.position.z,
      angleDeg: THREE.MathUtils.radToDeg(this.group.rotation.y),
      w: size.w,
      h: size.h,
    };
  }

  setVisible(v: boolean): void {
    this.group.visible = v && this.hasImage;
  }
}
