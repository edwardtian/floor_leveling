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
import { normalizationSummary } from './transform';

// ---------- core state ----------

const history = new History();
const viewport = document.getElementById('viewport')!;
const editor = new Editor(viewport);

let meshes: MeshData[] = [];
let activeMeshIndex = 0;
let currentTool: ToolId = 'select';
let units: MeasurementUnits = 'meter';
let importedFileName = '';
let unitRefreshers: (() => void)[] = [];
/** Syncs numeric floor fields from the tool state (called on gizmo drags). */
let floorTransformSyncers: (() => void)[] = [];

const transformTool = new TransformTool(editor, history, () => meshes[activeMeshIndex] ?? null, refreshAll);
const ffdTool = new FFDTool(editor, history, () => meshes[activeMeshIndex] ?? null, refreshAll);
const floorTool = new FloorTool(editor, history, () => meshes[activeMeshIndex] ?? null, refreshAll);
const refTool = new RefTool(editor, refreshAll);

editor.addGizmoDragStartListener(() => {
  if (currentTool === 'ffd') ffdTool.beginGizmoDrag();
});
editor.addGizmoDragEndListener(() => {
  if (currentTool === 'ffd') ffdTool.endGizmoDrag();
  if (currentTool === 'floor') floorTool.syncFromGizmo(); // clamp scale, mirror settings
  if (currentTool === 'transform') return; // TransformTool has its own listener
});
editor.gizmo.addEventListener('objectChange', () => {
  if (currentTool === 'ffd' && ffdTool.handlesGizmo(editor.gizmo.object as THREE.Object3D)) {
    ffdTool.updateGizmoDrag();
  }
  if (currentTool === 'floor' && editor.gizmo.object === floorTool.planeVisuals.plane.parent) {
    floorTool.syncFromGizmo(); // live-update numeric fields during the drag
    for (const fn of floorTransformSyncers) fn();
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
    floorTool.clearHitOverlay();
    floorTool.areas = [];
    floorTool.selectedIds.clear();
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
  const active = meshes[activeMeshIndex];
  const box = sceneBox(meshes);
  const size = box.getSize(new THREE.Vector3());
  const choice = await modal(
    'Export options',
    `<div class="kv"><span>Model size</span><b>${formatBox(box, units)}</b></div>
     <div class="kv"><span>Triangles</span><b>${fmtNumber(totalTriangles(meshes))}</b></div>
     <div style="margin:8px 0 4px;">Before export you may <b>normalize</b> the model
     (uniform scale to 1 m max dimension, centered in XZ, feet at y&nbsp;=&nbsp;0):</div>
     <div class="hint">${normalizationSummary(active, units)} → height ${fmtLen(size.y, units)} → normalized.</div>
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

function setTool(id: ToolId): void {
  currentTool = id;

  transformTool.setActive(id === 'transform');
  ffdTool.setActive(id === 'ffd');
  floorTool.setActive(id === 'floor');
  refTool.setActive(id === 'ref');

  // Left-drag meaning per tool.
  editor.setLeftButtonOrbit(id === 'select' || id === 'transform' || id === 'ref');
  if (id !== 'transform' && id !== 'ref' && id !== 'floor' && id !== 'ffd') editor.detachGizmo();

  for (const [toolId, btnId] of [
    ['select', 'tool-select'],
    ['transform', 'tool-transform'],
    ['ffd', 'tool-ffd'],
    ['floor', 'tool-floor'],
    ['ref', 'tool-ref'],
  ] as const) {
    document.getElementById(btnId)!.classList.toggle('active', toolId === id);
  }
  buildPanel();
}

// ---------- UI: topbar / toolbar ----------

(document.getElementById('btn-import') as HTMLButtonElement).addEventListener('click', () => modelInput.click());
(document.getElementById('btn-export-glb') as HTMLButtonElement).addEventListener('click', () => exportFlow('glb'));
(document.getElementById('btn-export-obj') as HTMLButtonElement).addEventListener('click', () => exportFlow('obj'));
(document.getElementById('btn-undo') as HTMLButtonElement).addEventListener('click', () => doUndo());
(document.getElementById('btn-redo') as HTMLButtonElement).addEventListener('click', () => doRedo());

for (const [toolId, btnId] of [
  ['select', 'tool-select'],
  ['transform', 'tool-transform'],
  ['ffd', 'tool-ffd'],
  ['floor', 'tool-floor'],
  ['ref', 'tool-ref'],
] as const) {
  document.getElementById(btnId)!.addEventListener('click', () => setTool(toolId));
}

(document.getElementById('chk-showfloor') as HTMLInputElement).addEventListener('change', (e) => {
  const v = (e.target as HTMLInputElement).checked;
  floorTool.uiVisible = v;
  floorTool.planeVisuals.plane.visible = v && floorTool.active;
  floorTool.planeVisuals.outline.visible = v && floorTool.active;
});
(document.getElementById('chk-showref') as HTMLInputElement).addEventListener('change', (e) => {
  refTool.setVisible((e.target as HTMLInputElement).checked);
});
(document.getElementById('chk-showwires') as HTMLInputElement).addEventListener('change', (e) => {
  editor.setWireframe((e.target as HTMLInputElement).checked);
});
(document.getElementById('chk-showgrid') as HTMLInputElement).addEventListener('change', (e) => {
  editor.setGridVisible((e.target as HTMLInputElement).checked);
});

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
  ffdTool.repaint();
  if (floorTool.active && floorTool.areas.length) floorTool.scan();
  transformTool.preview();
  refreshAll();
  toast(label);
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) doRedo();
    else doUndo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    doRedo();
  }
});

// ---------- pointer interactions (segment / floor selection) ----------

let pointerTracking = false;
let pointerDownNdc = new THREE.Vector2();
let additiveDown = false;

editor.renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if ((editor.gizmo as any).axis) return; // gizmo handles it
  if (currentTool !== 'ffd' && currentTool !== 'floor') return;
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
  if (currentTool === 'ffd') handleFFDPointerUp(rect, e);
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
  switch (currentTool) {
    case 'select': buildSelectPanel(); break;
    case 'transform': buildTransformPanel(); break;
    case 'ffd': buildFFDPanel(); break;
    case 'floor': buildFloorPanel(); break;
    case 'ref': buildRefPanel(); break;
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
  gr.body.appendChild(numField('X', t.rotX, (v) => { t.rotX = v; transformTool.preview(); refreshAll(); }, { step: 1 }));
  gr.body.appendChild(numField('Y', t.rotY, (v) => { t.rotY = v; transformTool.preview(); refreshAll(); }, { step: 1 }));
  gr.body.appendChild(numField('Z', t.rotZ, (v) => { t.rotZ = v; transformTool.preview(); refreshAll(); }, { step: 1 }));

  const gt = group('Translation', panelBody);
  for (const ax of ['x', 'y', 'z'] as const) {
    const f = unitField(ax.toUpperCase(), t[`t${ax}`], () => units, (v) => { t[`t${ax}`] = v; transformTool.preview(); refreshAll(); });
    unitRefreshers.push(f.refresh);
    gt.body.appendChild(f.root);
  }

  const gs = group('Scale', panelBody);
  gs.body.appendChild(numField('X', t.sx, (v) => { t.sx = v; transformTool.preview(); refreshAll(); }, { step: 0.05 }));
  gs.body.appendChild(numField('Y', t.sy, (v) => { t.sy = v; transformTool.preview(); refreshAll(); }, { step: 0.05 }));
  gs.body.appendChild(numField('Z', t.sz, (v) => { t.sz = v; transformTool.preview(); refreshAll(); }, { step: 0.05 }));

  const ga = group('Apply', panelBody);
  const applyBtn = button('Apply transform (bake into mesh)', () => {
    if (transformTool.apply()) {
      toast('Transform baked into geometry.', 'ok');
      refreshAll();
    } else toast('No pending transform.');
  }, 'btn primary');
  applyBtn.style.width = '100%';
  ga.body.appendChild(applyBtn);
  const resetBtn = button('Reset pending', () => { transformTool.resetPending(); refreshAll(); });
  resetBtn.style.width = '100%';
  ga.body.appendChild(resetBtn);
  ga.body.appendChild(hint('Rotation/scale pivot = mesh bounding-box center. Translation is in world axes.'));
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
  rowDim.appendChild(numField('X', s.nx, (v) => { s.nx = THREE.MathUtils.clamp(Math.round(v), 2, 20); if (ffdTool.lattice) rebuildFFD(); }, { integer: true, min: 2, max: 20 }));
  rowDim.appendChild(numField('Y', s.ny, (v) => { s.ny = THREE.MathUtils.clamp(Math.round(v), 2, 20); if (ffdTool.lattice) rebuildFFD(); }, { integer: true, min: 2, max: 20 }));
  rowDim.appendChild(numField('Z', s.nz, (v) => { s.nz = THREE.MathUtils.clamp(Math.round(v), 2, 20); if (ffdTool.lattice) rebuildFFD(); }, { integer: true, min: 2, max: 20 }));
  gl.body.appendChild(rowDim);
  gl.body.appendChild(slider('Cage margin', s.margin, 0, 0.3, 0.01, (v) => { s.margin = v; if (ffdTool.lattice) rebuildFFD(); }));
  const rowL = el('div', 'row');
  rowL.appendChild(button(ffdTool.lattice ? 'Rebuild lattice' : 'Create lattice', () => rebuildFFD(), 'btn primary'));
  rowL.appendChild(button('Reset', () => { ffdTool.reset(); toast('Lattice reset to the rest cage.', 'ok'); }));
  rowL.appendChild(button('Collapse', () => { ffdTool.collapse(); toast('Lattice removed — shape stays as deformed.', 'ok'); }));
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
  refreshFFDInfo();
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
  panelTitle.textContent = 'Floor leveling';
  if (!meshes.length) {
    panelBody.appendChild(hint('Import a model first.'));
    return;
  }
  const s = floorTool.settings;

  const gp = group('Floor plane', panelBody);
  gp.body.appendChild(gizmoModeButtons((m) => floorTool.setGizmoMode(m), floorTool.gizmoMode));

  // Fields re-read floorTool.settings on refresh so gizmo drags live-update them.
  const fx = unitField('Width X', s.sizeX, () => units, (v) => { s.sizeX = Math.max(0.05, v); floorTool.updatePlane(); });
  const fz = unitField('Depth Z', s.sizeZ, () => units, (v) => { s.sizeZ = Math.max(0.05, v); floorTool.updatePlane(); });
  const fy = unitField('Height Y', s.y, () => units, (v) => { s.y = v; floorTool.updatePlane(); });
  const fcx = unitField('Center X', s.cx, () => units, (v) => { s.cx = v; floorTool.updatePlane(); });
  const fcz = unitField('Center Z', s.cz, () => units, (v) => { s.cz = v; floorTool.updatePlane(); });
  const rot = numField('Spin / tilt (deg)', floorTool.rotationDeg.y, (v) => floorTool.setRotationDeg(undefined, v, undefined), { step: 1 });
  const sync = () => {
    fx.set(s.sizeX); fz.set(s.sizeZ); fy.set(s.y); fcx.set(s.cx); fcz.set(s.cz);
    (rot.querySelector('input') as HTMLInputElement).value = String(Math.round(floorTool.rotationDeg.y));
  };
  floorTransformSyncers.push(sync);
  unitRefreshers.push(fx.refresh, fz.refresh, fy.refresh, fcx.refresh, fcz.refresh);
  gp.body.append(fx.root, fz.root, fy.root, fcx.root, fcz.root, rot);

  const rowFit = el('div', 'row');
  const fitBtn = button('Fit to model', () => { floorTool.fitToModel(); buildPanel(); });
  const bottomBtn = button('Floor @ bottom', () => {
    const m = meshes[activeMeshIndex];
    m.geometry.computeBoundingBox();
    s.y = m.geometry.boundingBox!.min.y;
    floorTool.updatePlane();
    buildPanel();
  });
  rowFit.append(fitBtn, bottomBtn);
  gp.body.appendChild(rowFit);
  gp.body.appendChild(hint('Drag the gizmo in the viewport to move / rotate / scale the plane (T/R/S above switch the mode).'));

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
    const go = group('Placement', panelBody);
    go.body.appendChild(gizmoModeButtons((m) => refTool.setGizmoMode(m), refTool.gizmoMode));
    const ori = selectField('Orientation', [
      { value: 'horizontal', label: 'Horizontal (floor)' },
      { value: 'vertical', label: 'Vertical (wall)' },
    ], refTool.getOrientation(), (v) => { refTool.setOrientation(v as any); buildPanel(); });
    go.body.appendChild(ori.root);
    const st = refTool.state;
    const fy = unitField('Height Y', st.y, () => units, (v) => refTool.setY(v));
    const fw = unitField('Width', st.w, () => units, (v) => refTool.setSize(v, st.h));
    const fh = unitField('Height', st.h, () => units, (v) => refTool.setSize(st.w, v));
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
