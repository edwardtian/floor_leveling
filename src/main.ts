import * as THREE from 'three';
import './style.css';
import { Editor } from './editor';
import { History } from './history';
import { importModel } from './importer';
import { exportModel } from './exporter';
import { TransformTool } from './transformTool';
import { FFDTool } from './ffdTool';
import { FloorTool } from './floorTool';
import { RefTool } from './refTool';
import type { MeshData, MeasurementUnits, ToolId } from './types';
import {
  button, checkbox, el, group, hint, modal, numField, selectField, slider,
  toast, unitField, type UnitField,
} from './ui';
import { fmtLen, fmtBytes } from './units';
import { formatBox, sceneBox, totalTriangles, totalVertices, downloadBlob, baseName } from './modelUtils';
import { computeNormalizationForBox, normalizationSummaryForBox } from './transform';

// ---------- core state ----------

const history = new History();
const viewport = document.getElementById('viewport')!;
const editor = new Editor(viewport);

let meshes: MeshData[] = [];
let activeMeshIndex = 0;
let units: MeasurementUnits = 'meter';
let importedFileName = '';
let unitRefreshers: (() => void)[] = [];
/** Syncs numeric floor fields from the tool state (called on gizmo drags). */
let floorTransformSyncers: (() => void)[] = [];

const transformTool = new TransformTool(editor, history, () => meshes[activeMeshIndex] ?? null, refreshAll);
const ffdTool = new FFDTool(editor, history, () => meshes[activeMeshIndex] ?? null, refreshAll);
const floorTool = new FloorTool(editor, history, () => meshes[activeMeshIndex] ?? null, refreshAll);
const refTool = new RefTool(editor, history, refreshAll);

editor.addGizmoDragStartListener(() => {
  if (activeModelSub() === 'ffd') ffdTool.beginGizmoDrag();
  if (currentTool === 'floor') floorTool.nodeTransform.onGizmoStart();
  if (currentTool === 'ref') refTool.nodeTransform.onGizmoStart();
});
editor.addGizmoDragEndListener(() => {
  if (activeModelSub() === 'ffd') ffdTool.endGizmoDrag();
  if (activeModelSub() === 'transform') buildPanel(); // pending values changed
  if (currentTool === 'floor') {
    // Reset the proxy (its scale/rotation is folded into pending) and re-seat
    // it on the previewed pivot before mirroring the fields.
    floorTool.normalizeScale();
    floorTool.nodeTransform.attachGizmo(floorTool.gizmoMode);
    floorTool.syncFromGizmo(); // clamp scale, mirror settings
    refreshFloorTransformFields();
    buildPanel(); // refresh pending hint / Apply state
  }
  if (currentTool === 'ref') {
    refTool.nodeTransform.attachGizmo(refTool.gizmoMode);
    buildPanel(); // re-seat fields + pending hint
  }
});
editor.gizmo.addEventListener('objectChange', () => {
  const gizmoObj = editor.gizmo.object as THREE.Object3D;
  if (activeModelSub() === 'ffd' && ffdTool.handlesGizmo(gizmoObj)) {
    ffdTool.updateGizmoDrag();
  }
  if (currentTool === 'floor' && gizmoObj === floorTool.nodeTransform.proxy) {
    floorTool.nodeTransform.onGizmoChange(floorTool.gizmoMode); // fold into pending + preview
    floorTool.syncFromGizmo(); // live-update numeric fields during the drag
    for (const fn of floorTransformSyncers) fn();
  }
  if (currentTool === 'ref' && gizmoObj === refTool.nodeTransform.proxy) {
    refTool.nodeTransform.onGizmoChange(refTool.gizmoMode);
  }
});

// ---------- hidden file inputs ----------

const modelInput = document.createElement('input');
modelInput.type = 'file';
modelInput.accept = '.glb,.gltf,.fbx,.obj';
modelInput.style.display = 'none';
document.body.appendChild(modelInput);
modelInput.addEventListener('change', () => {
  const f = modelInput.files?.[0];
  if (f) importFromFile(f);
  modelInput.value = '';
});

const imageInput = document.createElement('input');
imageInput.type = 'file';
imageInput.accept = 'image/*';
imageInput.style.display = 'none';
document.body.appendChild(imageInput);
imageInput.addEventListener('change', () => {
  const f = imageInput.files?.[0];
  if (f) {
    refTool.loadImage(f)
      .then(() => {
        toast(`Reference image "${f.name}" loaded — drag the gizmo to place it.`, 'ok');
        buildPanel();
      })
      .catch((e) => toast(String(e), 'err'));
  }
  imageInput.value = '';
});

// ---------- import / export ----------

async function importFromFile(file: File): Promise<void> {
  try {
    setStatus(`Importing ${file.name}…`);
    setTool('select');
    ffdTool.invalidate(); // new model → old lattice is meaningless
    // Discard pending object edits from the previous model; otherwise they
    // re-preview on the new mesh (and block the floor auto-fit).
    transformTool.resetPending();
    transformTool.clearPreview();
    floorTool.resetTransform();
    floorTool.clearHitOverlay();
    floorTool.areas = [];
    floorTool.selectedIds.clear();
    floorTool.armAutoFit(); // new model → re-arm the one-time auto-fit
    const res = await importModel(file);
    meshes = res.meshes;
    activeMeshIndex = 0;
    importedFileName = file.name;
    history.clear();
    editor.setModel(res.root);
    for (const w of res.warnings) toast(w, 'info');
    setStatus(
      `${file.name} — ${fmtNumber(totalTriangles(meshes))} tris · ` +
      `${fmtNumber(totalVertices(meshes))} verts · ${formatBox(sceneBox(meshes), units)}`,
    );
    (document.getElementById('btn-export-glb') as HTMLButtonElement).disabled = false;
    (document.getElementById('btn-export-obj') as HTMLButtonElement).disabled = false;
    buildPanel();
    toast(`Imported ${file.name}.`, 'ok');
  } catch (e: any) {
    console.error(e);
    toast(`Import failed: ${e?.message ?? e}`, 'err');
    setStatus('Import failed.');
  }
}

function fmtNumber(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Keep a scale component non-zero (0 collapses the mesh and zeroes normals). */
function nonZeroScale(v: number): number {
  if (Math.abs(v) >= 1e-4) return v;
  return v < 0 ? -1e-4 : 1e-4;
}

async function exportFlow(format: 'glb' | 'obj'): Promise<void> {
  if (meshes.length === 0) return;

  // 1) Unapplied transform?
  if (transformTool.hasPending) {
    const choice = await modal(
      'Unapplied transform',
      'There is a pending object transform that is only <b>previewed</b>, not baked into the mesh.<br>Apply it before exporting?',
      [
        { label: 'Apply & continue', value: 'apply', primary: true },
        { label: 'Discard pending', value: 'discard' },
        { label: 'Cancel', value: 'cancel' },
      ],
    );
    if (choice === 'cancel') return;
    if (choice === 'apply') transformTool.apply();
    else transformTool.resetPending();
  }

  // 2) Normalization reminder (Q6).
  const box = sceneBox(meshes);
  const norm = computeNormalizationForBox(box);
  const choice = await modal(
    'Export options',
    `<div class="kv"><span>Model size</span><b>${formatBox(box, units)}</b></div>
     <div class="kv"><span>Triangles</span><b>${fmtNumber(totalTriangles(meshes))}</b></div>
     <div style="margin:8px 0 4px;">Before export you may <b>normalize</b> the model
     (uniform scale to 1 m max dimension, centered in XZ, feet at y&nbsp;=&nbsp;0):</div>
     <div class="hint">${normalizationSummaryForBox(box, units)} → height ${fmtLen(norm.heightMeters, units)} (normalized).</div>
     <div class="hint" style="margin-top:6px;">Floor plane, reference image and helpers are never exported.</div>`,
    [
      { label: 'Normalize & export', value: 'normalize', primary: true },
      { label: 'Export as-is', value: 'asis' },
      { label: 'Cancel', value: 'cancel' },
    ],
  );
  if (choice === 'cancel') return;

  try {
    setStatus('Exporting…');
    const { blob, filename } = await exportModel(meshes, {
      format,
      filename: `${baseName(importedFileName || 'model')}_leveled`,
      normalize: choice === 'normalize',
    });
    downloadBlob(blob, filename);
    setStatus(`Exported ${filename} (${fmtBytes(blob.size)}).`);
    toast(`Exported ${filename}.`, 'ok');
  } catch (e: any) {
    console.error(e);
    toast(`Export failed: ${e?.message ?? e}`, 'err');
  }
}

// ---------- tool switching ----------

/**
 * Top-level object tabs: Model, Floor, Ref Image.
 * The Model tab hosts vertical sub-panels: Info / Transform / FFD.
 */
type ObjectTab = 'model' | 'floor' | 'ref';
type ModelSub = 'select' | 'transform' | 'ffd';
/** Sub-panels inside the Floor / Ref Image tabs. */
type FloorSub = 'floor' | 'transform';
type RefSub = 'image' | 'transform';
let floorSub: FloorSub = 'floor';
let refSub: RefSub = 'image';

let currentTool: ObjectTab = 'model';
let modelSub: ModelSub = 'select';

/** Which model sub-tool is active right now (for gizmo routing etc.). */
function activeModelSub(): ModelSub | null {
  return currentTool === 'model' ? modelSub : null;
}

function setTool(id: ToolId): void {
  // ToolId now carries either an object tab or a model sub-panel.
  if (id === 'select' || id === 'transform' || id === 'ffd') {
    currentTool = 'model';
    modelSub = id;
  } else {
    currentTool = id;
  }
  applyToolState();
}

function applyToolState(): void {
  const sub = activeModelSub();

  // Deactivate every tool FIRST, then activate the one that owns the gizmo.
  // Previously the new tool attached its proxy and a later setActive(false)
  // unconditionally detached it, leaving Transform/FFD without a gizmo.
  transformTool.setActive(false);
  ffdTool.setActive(false);
  floorTool.setActive(false);
  refTool.setActive(false);

  if (sub === 'transform') transformTool.setActive(true);
  else if (sub === 'ffd') ffdTool.setActive(true);
  else if (currentTool === 'floor') floorTool.setActive(true);
  else if (currentTool === 'ref') refTool.setActive(true);

  // Left-drag meaning: rect-select/FFD picking need it; orbit for the rest.
  editor.setLeftButtonOrbit(!sub || sub === 'select' || currentTool === 'ref');
  if (sub === 'select') editor.detachGizmo();
  if (!sub && currentTool !== 'floor' && currentTool !== 'ref') editor.detachGizmo();

  // Topbar tabs.
  for (const [tabId, btnId] of [
    ['model', 'tool-model'],
    ['floor', 'tool-floor'],
    ['ref', 'tool-ref'],
  ] as const) {
    document.getElementById(btnId)!.classList.toggle('active', tabId === currentTool);
  }
  // Panel title + vertical Blender-style tab strip on the right edge.
  const title = currentTool === 'model' ? 'Model' : currentTool === 'floor' ? 'Floor' : 'Reference image';
  panelTitle.textContent = title;
  const panel = document.getElementById('panel')!;
  const subtabs = document.getElementById('subtabs')!;
  subtabs.innerHTML = '';
  let count = 0;
  const addSub = (label: string, active: boolean, onPick: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.classList.toggle('active', active);
    b.addEventListener('click', onPick);
    subtabs.appendChild(b);
    count++;
  };
  if (currentTool === 'model') {
    for (const s of ['select', 'transform', 'ffd'] as const) {
      const label = s === 'select' ? 'Info' : s === 'ffd' ? 'FFD' : s[0].toUpperCase() + s.slice(1);
      addSub(label, s === modelSub, () => setTool(s));
    }
  } else if (currentTool === 'floor') {
    addSub('Floor', floorSub === 'floor', () => { floorSub = 'floor'; applyToolState(); });
    addSub('Transform', floorSub === 'transform', () => { floorSub = 'transform'; applyToolState(); });
  } else {
    addSub('Image', refSub === 'image', () => { refSub = 'image'; applyToolState(); });
    addSub('Transform', refSub === 'transform', () => { refSub = 'transform'; applyToolState(); });
  }
  panel.dataset.subtabs = String(count);
  buildPanel();
}

// ---------- UI: topbar / toolbar ----------

(document.getElementById('btn-import') as HTMLButtonElement).addEventListener('click', () => modelInput.click());
(document.getElementById('btn-export-glb') as HTMLButtonElement).addEventListener('click', () => exportFlow('glb'));
(document.getElementById('btn-export-obj') as HTMLButtonElement).addEventListener('click', () => exportFlow('obj'));
(document.getElementById('btn-undo') as HTMLButtonElement).addEventListener('click', () => doUndo());
(document.getElementById('btn-redo') as HTMLButtonElement).addEventListener('click', () => doRedo());

for (const [toolId, btnId] of [
  ['model', 'tool-model'],
  ['floor', 'tool-floor'],
  ['ref', 'tool-ref'],
] as const) {
  document.getElementById(btnId)!.addEventListener('click', () => setTool(toolId as ToolId));
}

(document.getElementById('chk-showfloor') as HTMLInputElement).addEventListener('change', (e) => {
  const v = (e.target as HTMLInputElement).checked;
  floorTool.uiVisible = v;
  floorTool.planeVisuals.plane.visible = v && floorTool.active;
  floorTool.planeVisuals.outline.visible = v && floorTool.active;
  refreshAll(); // checkbox state re-derived from objects
});
(document.getElementById('chk-showref') as HTMLInputElement).addEventListener('change', (e) => {
  refTool.setVisible((e.target as HTMLInputElement).checked);
  refreshAll();
});
(document.getElementById('chk-showwires') as HTMLInputElement).addEventListener('change', (e) => {
  editor.setWireframe((e.target as HTMLInputElement).checked);
});
(document.getElementById('chk-showgrid') as HTMLInputElement).addEventListener('change', (e) => {
  editor.setGridVisible((e.target as HTMLInputElement).checked);
});

/**
 * Mirror the topbar checkboxes to the live object state: Floor visible =
 * plane shown (tool active + uiVisible), Ref = image loaded AND shown,
 * Wire/Grid from the editor. Called on every refreshAll.
 */
function syncTopbarChecks(): void {
  const floor = floorTool.uiVisible && floorTool.active;
  (document.getElementById('chk-showfloor') as HTMLInputElement).checked = floor;
  (document.getElementById('chk-showref') as HTMLInputElement).checked = refTool.hasImage && refTool.group.visible;
  (document.getElementById('chk-showwires') as HTMLInputElement).checked = editor.isWireframe;
  (document.getElementById('chk-showgrid') as HTMLInputElement).checked = editor.isGridVisible;
}

function doUndo(): void {
  const cmd = history.undo();
  if (!cmd) {
    toast('Nothing to undo.');
    return;
  }
  afterHistoryJump(`Undo: ${cmd.name}`);
}

function doRedo(): void {
  const cmd = history.redo();
  if (!cmd) {
    toast('Nothing to redo.');
    return;
  }
  afterHistoryJump(`Redo: ${cmd.name}`);
}

function afterHistoryJump(label: string): void {
  // Undo/redo rewrites mesh vertices: rebase the FFD delta (or drop if the
  // jump crossed a lattice build/reset — rebase detects shape mismatch only
  // roughly, so a plain rebase keeps the cage and accepts the new base).
  ffdTool.rebase();
  ffdTool.repaint();
  if (floorTool.active && floorTool.areas.length) floorTool.scan();
  transformTool.preview();
  // The floor's settings mirror its node TRS; a history jump can change that
  // TRS (Apply transform undo/redo), so re-sync it before rebuilding fields.
  floorTool.syncFromGizmo();
  refreshAll();
  buildPanel();
  toast(label);
}

// ---------- keyboard shortcuts (3ds Max style) ----------

/** The manipulator of the currently active object (model / floor / ref image). */
interface ManipulatorCtx {
  getMode: () => 'translate' | 'rotate' | 'scale';
  setMode: (m: 'translate' | 'rotate' | 'scale') => void;
  /** Object label for toasts. */
  label: string;
  /** Whether the manipulator can actually act right now. */
  ready: boolean;
}

function manipulatorCtx(): ManipulatorCtx | null {
  if (currentTool === 'floor') {
    return {
      getMode: () => floorTool.gizmoMode,
      setMode: (m) => floorTool.setGizmoMode(m),
      label: 'Floor',
      ready: true,
    };
  }
  if (currentTool === 'ref') {
    return {
      getMode: () => refTool.gizmoMode,
      setMode: (m) => refTool.setGizmoMode(m),
      label: 'Ref image',
      ready: refTool.hasImage,
    };
  }
  const sub = activeModelSub();
  if (sub === 'ffd') {
    return {
      getMode: () => ffdTool.gizmoMode,
      setMode: (m) => ffdTool.setGizmoMode(m),
      label: 'FFD',
      ready: !!ffdTool.lattice,
    };
  }
  if (sub === 'transform') {
    return {
      getMode: () => transformTool.gizmoMode,
      setMode: (m) => transformTool.setGizmoMode(m),
      label: 'Model',
      ready: meshes.length > 0,
    };
  }
  return null; // Info sub-panel: no manipulator active yet
}

const MODE_LABELS = { translate: 'Move', rotate: 'Rotate', scale: 'Scale' } as const;

/**
 * Q/W/E/R/Tab act on the CURRENT object's manipulator: the model (Transform
 * or FFD tool), the floor plane, or the reference image. Q always returns to
 * the Info (Select) tool; Tab cycles the active object's Translate/Rotate/Scale.
 * Skipped while typing in fields or when a modal is open.
 */
function handleManipulatorKey(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  if (document.querySelector('.modal-overlay')) return;

  if (e.key.toLowerCase() === 'q') {
    setTool('select');
    toast('Select', 'info');
    return;
  }

  const isW = e.key.toLowerCase() === 'w';
  const isE = e.key.toLowerCase() === 'e';
  const isR = e.key.toLowerCase() === 'r';
  const isTab = e.key === 'Tab';
  if (!isW && !isE && !isR && !isTab) return;
  e.preventDefault();

  const ctx = manipulatorCtx();
  if (!ctx) {
    // Info panel: W/E/R/Tab activate the model manipulator.
    if (!meshes.length) return;
    setTool('transform');
    const mode = isW ? 'translate' : isE ? 'rotate' : isR ? 'scale' : 'translate';
    transformTool.setGizmoMode(mode);
    toast(MODE_LABELS[mode], 'info');
    return;
  }
  if (!ctx.ready) {
    toast(`${ctx.label}: nothing to manipulate yet`, 'info');
    return;
  }

  if (isTab) {
    const modes = ['translate', 'rotate', 'scale'] as const;
    const next = modes[(modes.indexOf(ctx.getMode()) + 1) % modes.length];
    ctx.setMode(next);
    toast(`${ctx.label}: ${MODE_LABELS[next]}`, 'info');
  } else {
    const mode = isW ? 'translate' : isE ? 'rotate' : 'scale';
    ctx.setMode(mode);
    toast(`${ctx.label}: ${MODE_LABELS[mode]}`, 'info');
  }
  buildPanel(); // keep the panel's T/R/S buttons in sync
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) doRedo();
    else doUndo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    doRedo();
  } else {
    handleManipulatorKey(e);
  }
});

// ---------- pointer interactions (segment / floor selection) ----------

let pointerTracking = false;
let pointerDownNdc = new THREE.Vector2();
let additiveDown = false;

editor.renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if ((editor.gizmo as any).axis) return; // gizmo handles it
  if (activeModelSub() !== 'ffd' && currentTool !== 'floor') return;
  pointerTracking = true;
  additiveDown = e.shiftKey;
  pointerDownNdc = editor.ndcFromEvent(e);
  editor.beginRect(e);
});

editor.renderer.domElement.addEventListener('pointermove', (e) => {
  if (pointerTracking) editor.updateRect(e);
});

editor.renderer.domElement.addEventListener('pointerup', (e) => {
  if (!pointerTracking) return;
  pointerTracking = false;
  const rect = editor.endRect(e);
  if (activeModelSub() === 'ffd') handleFFDPointerUp(rect, e);
  else if (currentTool === 'floor') handleFloorPointerUp(rect, e);
});

function handleFFDPointerUp(rect: ReturnType<Editor['endRect']>, _e: PointerEvent): void {
  if (!ffdTool.lattice) {
    toast('Build the FFD lattice first (press "Create lattice").');
    return;
  }
  if (rect) {
    const ids = ffdTool.pointsInRect(rect);
    ffdTool.select(ids, additiveDown);
    if (ids.length) {
      toast(`${ids.length} control point(s) selected — drag the gizmo to deform.`);
    }
  } else {
    const id = ffdTool.pointAt(pointerDownNdc);
    if (id >= 0) {
      const cur = ffdTool.selected;
      if (additiveDown && cur.has(id)) cur.delete(id);
      else if (additiveDown) cur.add(id);
      else {
        cur.clear();
        cur.add(id);
      }
      ffdTool.repaint();
      ffdTool.attachSelectionGizmo();
      refreshAll();
    } else if (!additiveDown) {
      ffdTool.clearSelection();
    }
  }
}

function handleFloorPointerUp(rect: ReturnType<Editor['endRect']>, _e: PointerEvent): void {
  if (floorTool.areas.length === 0) {
    toast('Press "Scan intersections" to find areas touching the floor plane.');
    return;
  }
  if (rect) {
    const found = new Set<number>();
    for (const ndc of editor.sampleRectNdc(rect, 8)) {
      const hit = editor.raycastModel(ndc);
      if (!hit) continue;
      for (const a of floorTool.areas) {
        if (a.set.has(hit.faceIndex)) {
          found.add(a.id);
          break;
        }
      }
    }
    if (found.size) {
      floorTool.setSelectedAreas([...found]);
      toast(`${found.size} area(s) selected.`);
    }
  } else {
    const id = floorTool.areaAt(pointerDownNdc);
    if (id >= 0) {
      floorTool.toggleArea(id, additiveDown);
      toast(`Area ${id} ${additiveDown ? 'toggled' : 'selected'} — now Drop or Flatten.`);
    } else if (!additiveDown) {
      floorTool.selectArea(-1);
    }
  }
}

// ---------- right panel ----------

const panelTitle = document.getElementById('panel-title')!;
const panelBody = document.getElementById('panel-body')!;

function buildPanel(): void {
  unitRefreshers = [];
  panelBody.innerHTML = '';
  if (currentTool === 'model') {
    const sub = activeModelSub();
    if (sub === 'select') buildSelectPanel();
    else if (sub === 'transform') buildTransformPanel();
    else if (sub === 'ffd') buildFFDPanel();
  } else if (currentTool === 'floor') {
    if (floorSub === 'transform') buildNodeTransformPanel('Floor', () => floorTool.gizmoMode, (m) => floorTool.setGizmoMode(m), () => floorTool.hasPendingTransform(), () => floorTool.applyTransform(), () => floorTool.resetTransform());
    else buildFloorPanel();
  } else if (currentTool === 'ref') {
    if (refSub === 'transform') buildNodeTransformPanel('Image', () => refTool.gizmoMode, (m) => refTool.setGizmoMode(m), () => refTool.hasPendingTransform(), () => refTool.applyTransform(), () => refTool.resetTransform());
    else buildRefPanel();
  }
}

function buildSelectPanel(): void {
  panelTitle.textContent = 'Scene';
  const g = group('Model', panelBody);
  if (meshes.length === 0) {
    g.body.appendChild(hint('No model loaded. Use "Import…" (glb / fbx / obj).'));
  } else {
    if (meshes.length > 1) {
      const sel = selectField('Mesh', meshes.map((m, i) => ({ value: String(i), label: m.name })), String(activeMeshIndex), (v) => {
        switchActiveMesh(parseInt(v, 10));
      });
      g.body.appendChild(sel.root);
    }
    const active = meshes[activeMeshIndex];
    active.geometry.computeBoundingBox();
    const info = el('div');
    info.innerHTML =
      `<div class="kv"><span>Name</span><b>${escapeHtml(active.name)}</b></div>` +
      `<div class="kv"><span>Triangles</span><b>${fmtNumber(active.triCount)}</b></div>` +
      `<div class="kv"><span>Vertices</span><b>${fmtNumber(active.geometry.getAttribute('position').count)}</b></div>` +
      `<div class="kv"><span>Size</span><b>${formatBox(sceneBox(meshes), units)}</b></div>` +
      `<div class="kv"><span>Height</span><b>${fmtLen(sceneBox(meshes).getSize(new THREE.Vector3()).y, units)}</b></div>`;
    g.body.appendChild(info);
  }
  const gu = group('Units', panelBody);
  gu.body.appendChild(
    selectField('Display', [
      { value: 'meter', label: 'meters (m)' },
      { value: 'centimeter', label: 'centimeters (cm)' },
    ], units, (v) => setUnits(v as MeasurementUnits)).root,
  );
  gu.body.appendChild(hint('Scene space is meters. Labels on the grid ruler follow this setting.'));
  const gh = group('Workflow', panelBody);
  gh.body.appendChild(hint(
    '1 Import → 2 Transform (rotate/apply) → 3 FFD (free-form deform) → 4 Floor plane → ' +
    '5 Scan intersections → 6 Drop/Flatten → repeat. Ctrl+Z undo.',
  ));
}

function switchActiveMesh(i: number): void {
  if (transformTool.hasPending) {
    transformTool.resetPending();
    transformTool.clearPreview();
    toast('Pending transform discarded (mesh switched).');
  }
  activeMeshIndex = i;
  ffdTool.invalidate(); // rest positions captured for another mesh
  floorTool.areas = [];
  floorTool.clearHitOverlay();
  floorTool.armAutoFit();
  editor.frameModel();
  buildPanel();
}

function setUnits(u: MeasurementUnits): void {
  units = u;
  editor.units = u;
  editor.rebuildGrid();
  for (const r of unitRefreshers) r();
  buildPanel();
}

function buildTransformPanel(): void {
  panelTitle.textContent = 'Transform (Apply-style)';
  if (!meshes.length) {
    panelBody.appendChild(hint('Import a model first.'));
    return;
  }
  const t = transformTool.pending;

  const gm = group('Gizmo', panelBody);
  gm.body.appendChild(gizmoModeButtons((m) => transformTool.setGizmoMode(m), transformTool.gizmoMode));
  gm.body.appendChild(hint('Drag the gizmo to preview. Nothing is baked until you press Apply.'));

  const gr = group('Rotation (degrees)', panelBody);
  for (const ax of ['x', 'y', 'z'] as const) {
    const k = `rot${ax.toUpperCase()}` as 'rotX' | 'rotY' | 'rotZ';
    gr.body.appendChild(numField(ax.toUpperCase(), t[k], (v) => { t[k] = v; transformTool.preview(); refreshAll(); }, { step: 1, axis: ax }));
  }

  const gt = group('Translation', panelBody);
  for (const ax of ['x', 'y', 'z'] as const) {
    const f = unitField(ax.toUpperCase(), t[`t${ax}`], () => units, (v) => { t[`t${ax}`] = v; transformTool.preview(); refreshAll(); }, { axis: ax });
    unitRefreshers.push(f.refresh);
    gt.body.appendChild(f.root);
  }

  const gs = group('Scale', panelBody);
  for (const ax of ['x', 'y', 'z'] as const) {
    const k = `s${ax}` as 'sx' | 'sy' | 'sz';
    gs.body.appendChild(numField(ax.toUpperCase(), t[k], (v) => { t[k] = nonZeroScale(v); transformTool.preview(); refreshAll(); }, { step: 0.05, axis: ax }));
  }

  const ga = group('Apply', panelBody);
  const applyBtn = button('Apply transform (bake into mesh)', () => {
    if (transformTool.apply()) {
      toast('Transform baked into geometry.', 'ok');
      buildPanel(); // re-bind the fields to the reset pending object
      refreshAll();
    } else toast('No pending transform.');
  }, 'btn primary');
  applyBtn.style.width = '100%';
  ga.body.appendChild(applyBtn);
  const resetBtn = button('Reset pending', () => { transformTool.resetPending(); buildPanel(); refreshAll(); });
  resetBtn.style.width = '100%';
  ga.body.appendChild(resetBtn);
  ga.body.appendChild(hint('Rotation/scale pivot = mesh bounding-box center. Translation is in world axes.'));
}

/**
 * Transform sub-panel for tool objects (floor plane, ref image) — the same
 * group layout as the model's Transform panel: Gizmo / Rotation / Translation
 * / Scale / Apply. Values live-read the object's pending transform.
 */
function buildNodeTransformPanel(
  label: string,
  getMode: () => 'translate' | 'rotate' | 'scale',
  setMode: (m: 'translate' | 'rotate' | 'scale') => void,
  hasPending: () => boolean,
  applyFn: () => boolean,
  resetFn: () => void,
): void {
  const nt = currentTool === 'floor' ? floorTool.nodeTransform : refTool.nodeTransform;
  const t = nt.pending;

  const gm = group('Gizmo', panelBody);
  gm.body.appendChild(gizmoModeButtons(setMode, getMode()));
  gm.body.appendChild(hint('Drag the gizmo to preview. Nothing is baked until you press Apply.'));

  const gr = group('Rotation (degrees)', panelBody);
  for (const ax of ['x', 'y', 'z'] as const) {
    const k = `rot${ax.toUpperCase()}` as 'rotX' | 'rotY' | 'rotZ';
    gr.body.appendChild(numField(ax.toUpperCase(), t[k], (v) => { t[k] = v; nt.preview(); refreshAll(); }, { step: 1, axis: ax }));
  }

  const gt = group('Translation', panelBody);
  for (const ax of ['x', 'y', 'z'] as const) {
    const f = unitField(ax.toUpperCase(), t[`t${ax}`], () => units, (v) => { t[`t${ax}`] = v; nt.preview(); refreshAll(); }, { axis: ax });
    unitRefreshers.push(f.refresh);
    gt.body.appendChild(f.root);
  }

  const gs = group('Scale', panelBody);
  for (const ax of ['x', 'y', 'z'] as const) {
    const k = `s${ax}` as 'sx' | 'sy' | 'sz';
    gs.body.appendChild(numField(ax.toUpperCase(), t[k], (v) => { t[k] = nonZeroScale(v); nt.preview(); refreshAll(); }, { step: 0.05, axis: ax }));
  }

  const ga = group('Apply', panelBody);
  const applyBtn = button(`Apply transform (bake into ${label.toLowerCase()})`, () => {
    if (applyFn()) {
      toast(`${label} transform baked.`, 'ok');
      buildPanel();
      refreshAll();
    } else toast('No pending transform.');
  }, 'btn primary');
  applyBtn.style.width = '100%';
  const resetBtn = button('Reset pending', () => { resetFn(); buildPanel(); });
  resetBtn.style.width = '100%';
  ga.body.append(applyBtn, resetBtn);
  ga.body.appendChild(hint(hasPending()
    ? '⚠ Pending transform (previewed, not baked). Apply or Reset.'
    : 'Rotation/scale pivot = the object origin. Translation is in world axes.'));
}

function gizmoModeButtons(setMode: (m: 'translate' | 'rotate' | 'scale') => void, active: string): HTMLDivElement {
  const row = el('div', 'row');
  for (const m of ['translate', 'rotate', 'scale'] as const) {
    const b = button(m[0].toUpperCase() + m.slice(1, 3), () => setMode(m), `btn small${m === active ? ' primary' : ''}`);
    b.dataset.mode = m;
    b.addEventListener('click', () => {
      for (const c of row.querySelectorAll('button')) c.classList.remove('primary');
      b.classList.add('primary');
    });
    row.appendChild(b);
  }
  return row;
}

function buildFFDPanel(): void {
  panelTitle.textContent = 'Free-Form Deformation (FFD)';
  if (!meshes.length) {
    panelBody.appendChild(hint('Import a model first.'));
    return;
  }
  const s = ffdTool.settings;

  const gl = group('Lattice', panelBody);
  const rowDim = el('div', 'row');
  rowDim.appendChild(numField('X', s.nx, (v) => { s.nx = THREE.MathUtils.clamp(Math.round(v), 2, 20); if (ffdTool.lattice) rebuildFFD(); }, { integer: true, min: 2, max: 20, axis: 'x' }));
  rowDim.appendChild(numField('Y', s.ny, (v) => { s.ny = THREE.MathUtils.clamp(Math.round(v), 2, 20); if (ffdTool.lattice) rebuildFFD(); }, { integer: true, min: 2, max: 20, axis: 'y' }));
  rowDim.appendChild(numField('Z', s.nz, (v) => { s.nz = THREE.MathUtils.clamp(Math.round(v), 2, 20); if (ffdTool.lattice) rebuildFFD(); }, { integer: true, min: 2, max: 20, axis: 'z' }));
  gl.body.appendChild(rowDim);
  gl.body.appendChild(slider('Cage margin', s.margin, 0, 0.3, 0.01, (v) => { s.margin = v; if (ffdTool.lattice) rebuildFFD(); }));
  const rowL = el('div', 'row');
  const latticeBtn = button(ffdTool.lattice ? 'Rebuild lattice' : 'Create lattice', () => rebuildFFD(), 'btn primary');
  latticeBtn.id = 'ffd-lattice-btn';
  rowL.appendChild(latticeBtn);
  rowL.appendChild(button('Reset', () => { ffdTool.reset(); toast('Lattice reset to the rest cage.', 'ok'); }));
  rowL.appendChild(button('Collapse', () => {
    if (!ffdTool.lattice) {
      toast('No lattice to collapse.', 'info');
      return;
    }
    ffdTool.collapse();
    refreshFFDLatticeButton();
    toast('Lattice removed — shape stays as deformed.', 'ok');
  }));
  gl.body.appendChild(rowL);
  gl.body.appendChild(hint('The lattice wraps the whole model. Click control points to select (Shift = add), drag on empty space for a rect, then drag the gizmo: the surface deforms smoothly.'));

  const gs = group('Selection', panelBody);
  const info = el('div', 'hint', '');
  info.id = 'ffd-info';
  gs.body.appendChild(info);
  const rowBtns = el('div', 'row');
  rowBtns.appendChild(button('All', () => { ffdTool.selectAll(); }));
  rowBtns.appendChild(button('None', () => { ffdTool.clearSelection(); }));
  rowBtns.appendChild(button('Corners', () => selectFFDCorners()));
  gs.body.appendChild(rowBtns);
  gs.body.appendChild(gizmoModeButtons((m) => ffdTool.setGizmoMode(m), ffdTool.gizmoMode));

  refreshFFDInfo();
}

function selectFFDCorners(): void {
  const lat = ffdTool.lattice;
  if (!lat) return;
  const ids: number[] = [];
  for (const i of [0, lat.nx - 1]) {
    for (const j of [0, lat.ny - 1]) {
      for (const k of [0, lat.nz - 1]) ids.push(lat.index(i, j, k));
    }
  }
  ffdTool.select(ids, false);
}

function rebuildFFD(): void {
  if (ffdTool.build()) {
    toast(`FFD lattice ${ffdTool.settings.nx}×${ffdTool.settings.ny}×${ffdTool.settings.nz} created.`, 'ok');
  }
  refreshFFDLatticeButton();
  refreshFFDInfo();
}

/** Keep the primary lattice button label in sync with the tool state. */
function refreshFFDLatticeButton(): void {
  const b = document.getElementById('ffd-lattice-btn') as HTMLButtonElement | null;
  if (b) b.textContent = ffdTool.lattice ? 'Rebuild lattice' : 'Create lattice';
}

function refreshFFDInfo(): void {
  const info = document.getElementById('ffd-info');
  if (!info) return;
  const lat = ffdTool.lattice;
  if (!lat) {
    info.textContent = 'No lattice yet.';
  } else {
    info.textContent = `${lat.nx}×${lat.ny}×${lat.nz} = ${lat.count} control points · ${ffdTool.selected.size} selected.`;
  }
}

function buildFloorPanel(): void {
  panelTitle.textContent = 'Floor';
  if (!meshes.length) {
    panelBody.appendChild(hint('Import a model first.'));
    return;
  }
  const s = floorTool.settings;

  // NOTE: transform gizmo/apply/reset lives in the Transform SUB-TAB
  // (buildNodeTransformPanel) — same layout as the model's Transform panel.
  if (floorTool.hasPendingTransform()) {
    panelBody.appendChild(hint('⚠ Pending floor transform (previewed). Use the Transform sub-tab to Apply or Reset.'));
  }
  const gp = group('Floor plane', panelBody);

  // All fields go through the SAME pending transform as the Transform
  // sub-panel: they read the PREVIEWED state and write via setWorld* —
  // preview on type, Apply bakes, Reset discards. One implementation for
  // model / floor / ref image.
  const nt = floorTool.nodeTransform;
  const previewed = () => nt.previewedTRS();
  const fx = unitField('Width X', s.sizeX, () => units, (v) => { s.sizeX = Math.max(0.05, v); nt.setWorldScale({ x: s.sizeX }); floorTool.syncFromGizmo(); }, { axis: 'x' });
  const fz = unitField('Depth Z', s.sizeZ, () => units, (v) => { s.sizeZ = Math.max(0.05, v); nt.setWorldScale({ z: s.sizeZ }); floorTool.syncFromGizmo(); }, { axis: 'z' });
  const fy = unitField('Height Y', s.y, () => units, (v) => { s.y = v; nt.setWorldPosition({ y: s.y }); }, { axis: 'y' });
  const fcx = unitField('Center X', s.cx, () => units, (v) => { s.cx = v; nt.setWorldPosition({ x: s.cx }); }, { axis: 'x' });
  const fcz = unitField('Center Z', s.cz, () => units, (v) => { s.cz = v; nt.setWorldPosition({ z: s.cz }); }, { axis: 'z' });
  const rot = numField('Spin / tilt (deg)', floorTool.rotationDeg.y, (v) => nt.setWorldRotationDeg({ y: v }), { step: 1 });
  const sync = () => {
    const trs = previewed();
    fx.set(trs.scale.x); fz.set(trs.scale.z); fy.set(trs.pos.y); fcx.set(trs.pos.x); fcz.set(trs.pos.z);
    const rotInput = rot.querySelector('input');
    if (rotInput) rotInput.value = String(Math.round(THREE.MathUtils.radToDeg(trs.rotDeg.y)));
  };
  floorTransformSyncers.length = 0;
  floorTransformSyncers.push(sync);
  sync(); // show the PREVIEWED values, not a stale settings mirror
  unitRefreshers.push(fx.refresh, fz.refresh, fy.refresh, fcx.refresh, fcz.refresh);
  gp.body.append(fx.root, fz.root, fy.root, fcx.root, fcz.root, rot);

  const rowFit = el('div', 'row');
  const fitBtn = button('Fit to model', () => { floorTool.fitToModel(true); buildPanel(); });
  const bottomBtn = button('Floor @ bottom', () => {
    const m = meshes[activeMeshIndex];
    m.geometry.computeBoundingBox();
    s.y = m.geometry.boundingBox!.min.y;
    floorTool.updatePlane(true);
    buildPanel();
  });
  rowFit.append(fitBtn, bottomBtn);
  gp.body.appendChild(rowFit);


  const gscan = group('Intersections', panelBody);
  const scanBtn = button('Scan intersections', () => {
    const n = floorTool.scan();
    toast(n ? `${n} intersecting area(s) found — click one to select.` : 'No intersections. Move the plane into the model.', n ? 'ok' : 'info');
    refreshFloorAreas();
  }, 'btn primary');
  scanBtn.style.width = '100%';
  gscan.body.appendChild(scanBtn);
  const list = el('div');
  list.id = 'floor-areas';
  gscan.body.appendChild(list);
  refreshFloorAreas();

  const gl = group('Level selection', panelBody);
  const rowL = el('div', 'row');
  const dropBtn = button('Drop', () => levelAndReport('drop'), 'btn primary');
  const flatBtn = button('Flatten', () => levelAndReport('flatten'));
  rowL.append(dropBtn, flatBtn);
  gl.body.appendChild(rowL);
  gl.body.appendChild(hint(
    'Drop = rigid translate of the whole selection until its lowest point touches the plane. ' +
    'Flatten = vertices below the plane are pulled onto it. Both blend smoothly at the region border.',
  ));
}

let floorFieldAppliers: (() => void)[] = [];

/** Re-read pending→settings into the floor panel fields (after gizmo drag). */
function refreshFloorTransformFields(): void {
  for (const fn of floorFieldAppliers) fn();
}

function refreshFloorAreas(): void {
  const list = document.getElementById('floor-areas');
  if (!list) return;
  list.innerHTML = '';
  const areas = floorTool.areaSummaries();
  if (!areas.length) {
    list.appendChild(hint('No areas yet — press Scan.'));
    return;
  }
  const wrap = el('div', 'row');
  for (const a of areas.slice(0, 24)) {
    const sel = floorTool.selectedAreas.has(a.id);
    const b = el('span', `badge${sel ? ' on' : ''}`, `#${a.id} · ${a.count}f`);
    b.classList.add('segment-badge');
    b.title = `y ${fmtLen(a.minY, units)} … ${fmtLen(a.maxY, units)}`;
    b.addEventListener('click', () => {
      floorTool.toggleArea(a.id, false);
      refreshFloorAreas();
    });
    wrap.appendChild(b);
  }
  list.appendChild(wrap);
}

function levelAndReport(mode: 'drop' | 'flatten'): void {
  const ok = floorTool.level(mode);
  if (ok) {
    toast(mode === 'drop' ? 'Dropped selection onto the floor plane.' : 'Flattened selection to the floor plane.', 'ok');
    refreshFloorAreas();
    refreshAll();
  } else {
    toast('Select an area first (Scan, then click a highlighted region).');
  }
}

function buildRefPanel(): void {
  panelTitle.textContent = 'Reference image';
  const gi = group('Image', panelBody);
  if (!refTool.hasImage) {
    const btn = button('Load image…', () => imageInput.click(), 'btn primary');
    btn.style.width = '100%';
    gi.body.appendChild(btn);
    gi.body.appendChild(hint('The image becomes a guide plane you can move/rotate/scale — like tracing paper over the model.'));
  } else {
    gi.body.appendChild(hint(`Loaded: ${refTool.name}`));
    const btn = button('Replace image…', () => imageInput.click());
    const clr = button('Remove', () => { refTool.clearImage(); buildPanel(); }, 'btn danger');
    const row = el('div', 'row');
    row.append(btn, clr);
    gi.body.appendChild(row);
  }

  if (refTool.hasImage) {
    // NOTE: transform gizmo/apply/reset lives in the Transform SUB-TAB.
    if (refTool.hasPendingTransform()) {
      panelBody.appendChild(hint('⚠ Pending image transform (previewed). Use the Transform sub-tab to Apply or Reset.'));
    }
    const go = group('Placement', panelBody);
    const ori = selectField('Orientation', [
      { value: 'horizontal', label: 'Horizontal (floor)' },
      { value: 'vertical', label: 'Vertical (wall)' },
    ], refTool.getOrientation(), (v) => { refTool.setOrientation(v as any); buildPanel(); });
    go.body.appendChild(ori.root);
    const st = refTool.state;
    const fy = unitField('Height Y', st.y, () => units, (v) => refTool.setY(v));
    const fw = unitField('Width', st.w, () => units, (v) => refTool.setWidth(v));
    const fh = unitField('Height', st.h, () => units, (v) => refTool.setHeight(v));
    const fa = numField('Spin (deg)', st.angleDeg, (v) => refTool.setAngleDeg(v), { step: 1 });
    unitRefreshers.push(fy.refresh, fw.refresh, fh.refresh);
    go.body.append(fy.root, fw.root, fh.root, fa);
    const gop = group('Opacity', panelBody);
    gop.body.appendChild(slider('Opacity', refTool.opacity, 0.05, 1, 0.05, (v) => refTool.setOpacity(v)));
  }
}
// ---------- status / refresh ----------

function setStatus(text: string): void {
  const s = document.getElementById('status');
  if (s) s.textContent = text;
}

function refreshAll(): void {
  syncTopbarChecks();
  (document.getElementById('btn-undo') as HTMLButtonElement).disabled = !history.canUndo;
  (document.getElementById('btn-redo') as HTMLButtonElement).disabled = !history.canRedo;
  const parts: string[] = [];
  if (importedFileName) {
    parts.push(importedFileName);
    parts.push(`${fmtNumber(totalTriangles(meshes))} tris · ${formatBox(sceneBox(meshes), units)}`);
  }
  if (transformTool.hasPending) parts.push('⚠ pending transform (not applied)');
  if (ffdTool.lattice) parts.push(`FFD: ${ffdTool.selected.size}/${ffdTool.lattice.count} points selected`);
  if (floorTool.areas.length) parts.push(`floor areas: ${floorTool.areas.length} (${floorTool.selectedAreas.size} selected)`);
  if (parts.length) setStatus(parts.join('  ·  '));
  const ffdInfo = document.getElementById('ffd-info');
  if (ffdInfo) {
    const lat = ffdTool.lattice;
    ffdInfo.textContent = lat ? `${lat.nx}×${lat.ny}×${lat.nz} = ${lat.count} control points · ${ffdTool.selected.size} selected.` : 'No lattice yet.';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// ---------- boot ----------

refreshAll();
setTool('select');
setStatus('Import a model to begin (glb / fbx / obj).');

// Debug/testing hooks (also used by the smoke test).
import * as THREE_NS from 'three';
(window as any).__FL__ = {
  meshes: () => meshes,
  history,
  editor,
  transformTool,
  ffdTool,
  floorTool,
  refTool,
  setTool,
  THREE: THREE_NS,
};
// Property-style accessors for the test harness.
Object.defineProperty((window as any).__FL__, 'meshes', {
  get: () => meshes,
  set: (v: MeshData[]) => { meshes = v; },
});
