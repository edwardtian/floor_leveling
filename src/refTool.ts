import * as THREE from 'three';
import type { Editor } from './editor';
import { baseName } from './modelUtils';
import { PendingNodeTransform } from './objectTransform';
import type { History } from './history';

const Z_AXIS = new THREE.Vector3(0, 0, 1);

function normalizeDeg(d: number): number {
  let x = ((d + 180) % 360 + 360) % 360 - 180;
  if (Math.abs(x) < 1e-9) x = 0;
  return x;
}

/**
 * Reference image tool: a camera-facing billboard guide.
 *
 * The image always faces the camera (a 2D overlay anchored in world space).
 * Only Ref Image mode attaches the gizmo and exposes the transform fields:
 *   - translate (world XYZ),
 *   - scale (local X/Y — width/height),
 *   - rotate (local Z only — a 2D screen-plane spin).
 * In every other mode the transform is locked; the topbar Ref toggle only
 * shows/hides the image. The billboard orientation still follows the camera
 * so the guide remains readable while you orbit.
 */
export class RefTool {
  active = false;

  group = new THREE.Group(); // position + billboard quaternion + width/height scale
  private plane: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private baseW = 1;
  private baseH = 1;
  private texture: THREE.Texture | null = null;
  private imageName = '';

  private editor: Editor;
  private onChanged: () => void;

  /** Pending translation/scale (preview → apply/reset), like the model's. */
  readonly nodeTransform: PendingNodeTransform;

  gizmoMode: 'translate' | 'rotate' | 'scale' = 'translate';

  /** Committed 2D screen-plane spin (degrees). */
  private spinDeg = 0;
  /** Cache so the per-frame billboard update is cheap when nothing changed. */
  private billboardSig = '';
  private spinDragStart = 0;
  private spinDragQuat: THREE.Quaternion | null = null;

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
      // A reference guide should stay readable over the model, like tracing
      // paper. It is a billboard, so it never presents an edge-on plane.
      depthTest: false,
    });
    this.plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    // The plane's local XY is the image; the group quaternion billboards it.
    this.plane.renderOrder = 6;
    this.group.add(this.plane);
    this.group.name = 'ReferenceImage';
    this.group.visible = false;
    editor.scene.add(this.group);
    this.nodeTransform.setTarget(this.group);

    // Billboard every frame — including in Model/Floor mode, where the image
    // is locked but must still face the camera.
    editor.addFrameListener(() => this.updateBillboard());
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
      this.updateBillboard();
      this.attachGizmo();
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
    if (this.active && this.hasImage) this.attachGizmo();
  }

  /** Re-seat the gizmo after a drag / numeric edit. */
  refreshGizmo(): void {
    if (this.active && this.hasImage) this.attachGizmo();
  }

  private attachGizmo(): void {
    const space = this.gizmoMode === 'translate' ? 'world' : 'local';
    this.nodeTransform.attachGizmo(this.gizmoMode, space);
    // Translate: world XYZ. Scale: local X/Y (Z is the image normal).
    // Rotate: local Z only (2D screen-plane spin).
    const g = this.editor.gizmo;
    if (this.gizmoMode === 'rotate') {
      g.showX = false;
      g.showY = false;
      g.showZ = true;
    } else if (this.gizmoMode === 'scale') {
      g.showX = true;
      g.showY = true;
      g.showZ = false;
    } else {
      g.showX = true;
      g.showY = true;
      g.showZ = true;
    }
  }

  /** Bake the pending translation/scale into the image node (undoable). */
  applyTransform(): boolean {
    const ok = this.nodeTransform.apply();
    if (ok) {
      this.updateBillboard();
      this.onChanged();
    }
    return ok;
  }

  /** Discard the pending translation/scale. */
  resetTransform(): void {
    this.nodeTransform.reset();
    this.updateBillboard();
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

    // One square plane; the world size lives entirely in the group scale.
    const aspect = (tex.image?.width ?? 1) / (tex.image?.height ?? 1);
    this.baseW = 1;
    this.baseH = 1;
    this.plane.geometry.dispose();
    this.plane.geometry = new THREE.PlaneGeometry(1, 1);
    this.spinDeg = 0;
    this.billboardSig = '';
    this.spinDragQuat = null;

    let footprint = 2;
    let center = new THREE.Vector3();
    this.editor.modelRoot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.editor.modelRoot);
    if (!box.isEmpty()) {
      const size = box.getSize(new THREE.Vector3());
      footprint = Math.max(size.x, size.z);
      center = box.getCenter(new THREE.Vector3());
    }
    const w = footprint * 0.6;
    const h = w / Math.max(aspect, 1e-6);
    this.group.scale.set(w, h, 1);
    this.group.position.copy(center);
    this.group.quaternion.copy(this.editor.camera.quaternion);
    this.group.visible = true;
    this.group.updateMatrixWorld(true);
    this.nodeTransform.setTarget(this.group); // fresh base, no pending
    this.updateBillboard();
    if (this.active) this.attachGizmo();
    this.onChanged();
  }

  clearImage(): void {
    if (this.texture) this.texture.dispose();
    this.texture = null;
    this.mat.map = null;
    this.mat.needsUpdate = true;
    this.imageName = '';
    this.spinDeg = 0;
    this.billboardSig = '';
    this.spinDragQuat = null;
    this.group.visible = false;
    if (this.active) this.editor.detachGizmo();
    this.onChanged();
  }

  setOpacity(v: number): void {
    this.mat.opacity = THREE.MathUtils.clamp(v, 0.05, 1);
    this.onChanged();
  }

  get opacity(): number {
    return this.mat.opacity;
  }

  /** Set the image width/height in world units (local X/Y). */
  setSize(width: number, height: number): void {
    width = Math.max(1e-4, width);
    height = Math.max(1e-4, height);
    this.nodeTransform.setWorldScale({ x: width / this.baseW, y: height / this.baseH });
    this.onChanged();
  }

  /** Width-only edit: preserves the CURRENT height (not a build-time snapshot). */
  setWidth(width: number): void {
    const { h } = this.getSize();
    this.setSize(width, h);
  }

  /** Height-only edit: preserves the CURRENT width (not a build-time snapshot). */
  setHeight(height: number): void {
    const { w } = this.getSize();
    this.setSize(w, height);
  }

  /** Current local size (width × height in meters), independent of spin. */
  getSize(): { w: number; h: number } {
    const s = this.nodeTransform.previewedTRS().scale;
    return {
      w: this.baseW * Math.abs(s.x),
      h: this.baseH * Math.abs(s.y),
    };
  }

  /**
   * Numeric placement edits go through the SAME pending transform as the
   * Transform sub-panel (preview on type; Apply bakes; Reset discards).
   */
  setY(y: number): void {
    this.nodeTransform.setWorldPosition({ y });
    this.onChanged();
  }

  /** Set the 2D screen-plane spin immediately (billboard-relative). */
  setAngleDeg(deg: number): void {
    this.spinDeg = normalizeDeg(deg);
    this.billboardSig = '';
    this.updateBillboard();
    this.onChanged();
  }

  /** Read back values after gizmo interaction. */
  syncFields(): void {
    this.onChanged();
  }

  get state(): { x: number; y: number; z: number; angleDeg: number; w: number; h: number } {
    const trs = this.nodeTransform.previewedTRS();
    const size = this.getSize();
    return {
      x: trs.pos.x,
      y: trs.pos.y,
      z: trs.pos.z,
      angleDeg: this.spinDeg,
      w: size.w,
      h: size.h,
    };
  }

  setVisible(v: boolean): void {
    this.group.visible = v && this.hasImage;
  }

  // ---------- billboard ----------

  /** Keep the image facing the camera; spin is applied around the view axis. */
  updateBillboard(): void {
    if (!this.hasImage) return;
    const camQ = this.editor.camera.quaternion;
    const sig =
      `${camQ.x.toFixed(6)},${camQ.y.toFixed(6)},${camQ.z.toFixed(6)},${camQ.w.toFixed(6)}` +
      `|${this.spinDeg.toFixed(6)}`;
    if (sig === this.billboardSig) return;
    this.billboardSig = sig;

    const q = camQ.clone().multiply(
      new THREE.Quaternion().setFromAxisAngle(Z_AXIS, THREE.MathUtils.degToRad(this.spinDeg)),
    );
    this.group.quaternion.copy(q);
    this.nodeTransform.refreshBase();
    this.group.updateMatrixWorld(true);
  }

  // ---------- gizmo drags ----------

  onGizmoStart(): void {
    this.nodeTransform.onGizmoStart();
    this.spinDragStart = this.spinDeg;
    this.spinDragQuat = this.nodeTransform.proxy.quaternion.clone();
  }

  onGizmoChange(): void {
    if (this.gizmoMode === 'rotate') {
      if (!this.spinDragQuat) return;
      // The rotate gizmo is local-Z-only; extract the signed 2D angle from
      // the proxy's quaternion delta and keep the image in the screen plane.
      const rel = this.spinDragQuat.clone().invert().multiply(this.nodeTransform.proxy.quaternion);
      const e = new THREE.Euler().setFromQuaternion(rel, 'XYZ');
      this.spinDeg = normalizeDeg(this.spinDragStart + THREE.MathUtils.radToDeg(e.z));
      this.billboardSig = '';
      this.updateBillboard();
      this.onChanged();
      return;
    }
    this.nodeTransform.onGizmoChange(this.gizmoMode);
  }

  onGizmoEnd(): void {
    this.spinDragQuat = null;
    this.attachGizmo();
    this.onChanged();
  }
}
