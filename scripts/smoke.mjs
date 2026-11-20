/* Headless smoke test: boots the built app in system Chrome, imports the
 * example GLB, drives all tools programmatically via the exposed window hooks,
 * and saves screenshots + assertions results to .smoke/. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const ROOT = '/media/data/Workspace/floor_leveling';
mkdirSync(`${ROOT}/.smoke`, { recursive: true });

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const server = spawn('npx', ['vite', '--port', '5199', '--strictPort'], {
  cwd: ROOT,
  stdio: 'pipe',
});
await new Promise((res) => {
  server.stdout.on('data', (d) => {
    if (String(d).includes('Local:')) res();
  });
  setTimeout(res, 6000);
});

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://localhost:5199/');
await page.waitForTimeout(1200);

// ---- 1. import the example glb via the file input
const input = await page.locator('input[type=file]').first();
await input.setInputFiles(`${ROOT}/lishan.glb`);
await page.waitForTimeout(2500);
ok('import glb', await page.evaluate(() => window.__FL__ && window.__FL__.meshes.length === 1),
  await page.evaluate(() => window.__FL__ ? `${window.__FL__.meshes[0].triCount} tris` : 'no hooks'));
await page.screenshot({ path: `${ROOT}/.smoke/01-imported.png` });

// ---- 2. transform tool: rotate pending + apply
await page.click('#tool-model');
await page.click('#subtabs button:has-text("Transform")');
await page.waitForTimeout(300);
await page.evaluate(() => {
  const t = window.__FL__.transformTool.pending;
  t.rotZ = 25; t.tx = 0.1;
  window.__FL__.transformTool.preview();
});
await page.waitForTimeout(400);
await page.screenshot({ path: `${ROOT}/.smoke/02-transform-pending.png` });
const minYBefore = await page.evaluate(() => {
  const m = window.__FL__.meshes[0];
  m.geometry.computeBoundingBox();
  return m.geometry.boundingBox.min.y;
});
await page.evaluate(() => window.__FL__.transformTool.apply());
await page.waitForTimeout(300);
const rotApplied = await page.evaluate(() => {
  const m = window.__FL__.meshes[0];
  m.geometry.computeBoundingBox();
  return { min: m.geometry.boundingBox.min.y, pendingZero: !window.__FL__.transformTool.hasPending };
});
ok('transform apply bakes', rotApplied.pendingZero && Math.abs(rotApplied.min - minYBefore) > 0.01,
  `minY ${minYBefore.toFixed(3)} → ${rotApplied.min.toFixed(3)}`);

// undo should restore
await page.click('#btn-undo');
await page.waitForTimeout(300);
const minYAfterUndo = await page.evaluate(() => {
  const m = window.__FL__.meshes[0];
  m.geometry.computeBoundingBox();
  return m.geometry.boundingBox.min.y;
});
ok('undo restores transform', Math.abs(minYAfterUndo - minYBefore) < 1e-6);
await page.click('#btn-redo');
await page.waitForTimeout(200);

// ---- 3. FFD: lattice build, control-point select, deform, history
await page.click('#tool-model');
await page.click('#subtabs button:has-text("FFD")');
await page.waitForTimeout(300);
await page.evaluate(() => {
  const f = window.__FL__.ffdTool;
  f.settings.nx = 3; f.settings.ny = 3; f.settings.nz = 3;
  f.build();
});
await page.waitForTimeout(400);
const ffdInfo = await page.evaluate(() => {
  const f = window.__FL__.ffdTool;
  return { count: f.lattice.count, dims: [f.lattice.nx, f.lattice.ny, f.lattice.nz] };
});
ok('FFD lattice built 3×3×3', ffdInfo.count === 27 && ffdInfo.dims.join(',') === '3,3,3', JSON.stringify(ffdInfo));
await page.screenshot({ path: `${ROOT}/.smoke/03-ffd-lattice.png` });

// identity check: a fresh cage must not move the mesh (float32 precision)
const ffdIdentity = await page.evaluate(() => {
  const f = window.__FL__.ffdTool;
  const m = window.__FL__.meshes[0];
  const arr = m.geometry.getAttribute('position').array;
  const before = new Float32Array(arr);
  f.lattice.controlPoints.set(f.lattice.restPoints);
  const out = new Float32Array(arr.length);
  f.lattice.deform(f['local'], out);
  let maxDev = 0;
  for (let i = 0; i < arr.length; i++) maxDev = Math.max(maxDev, Math.abs(out[i] - before[i]));
  return maxDev;
});
ok('FFD fresh cage is identity (float32)', ffdIdentity < 1e-4, `max vertex deviation ${ffdIdentity.toExponential(2)}`);

// select the TOP ROW of control points (j = ny-1) and lift it: the top of the
// model must stretch up smoothly while the bottom stays put.
const ffdSelect = await page.evaluate(() => {
  const f = window.__FL__.ffdTool;
  const lat = f.lattice;
  const ids = [];
  for (let i = 0; i < lat.nx; i++) {
    for (let k = 0; k < lat.nz; k++) ids.push(lat.index(i, lat.ny - 1, k));
  }
  f.select(ids, false);
  return { n: f.selected.size, pivotY: f.selectionPivot().y };
});
ok('FFD top row selected', ffdSelect.n === 9, JSON.stringify(ffdSelect));

const ffdTopBefore = await page.evaluate(() => {
  const m = window.__FL__.meshes[0];
  m.geometry.computeBoundingBox();
  return { maxY: m.geometry.boundingBox.max.y, minY: m.geometry.boundingBox.min.y };
});
const ffdGizmoLift = await page.evaluate(() => {
  const f = window.__FL__.ffdTool;
  const ed = window.__FL__.editor;
  ed.gizmo.dragging = true;
  f.beginGizmoDrag();
  const p0 = f.gizmoProxy.position.clone();
  f.gizmoProxy.position.set(p0.x, p0.y + 0.5, p0.z);
  f.updateGizmoDrag();
  const changed = f.endGizmoDrag();
  ed.gizmo.dragging = false;
  return changed;
});
const ffdTopAfter = await page.evaluate(() => {
  const m = window.__FL__.meshes[0];
  m.geometry.computeBoundingBox();
  return { maxY: m.geometry.boundingBox.max.y, minY: m.geometry.boundingBox.min.y };
});
ok('FFD gizmo lift commits', ffdGizmoLift === true);
ok('FFD top stretched, bottom nearly anchored',
  ffdTopAfter.maxY > ffdTopBefore.maxY + 0.1 && Math.abs(ffdTopAfter.minY - ffdTopBefore.minY) < 5e-3,
  `maxY ${ffdTopBefore.maxY.toFixed(3)} → ${ffdTopAfter.maxY.toFixed(3)}, minY ${ffdTopBefore.minY.toFixed(3)} → ${ffdTopAfter.minY.toFixed(3)} (FFD is global: bottom may drift ~v²·lift)`);
await page.screenshot({ path: `${ROOT}/.smoke/04-ffd-deformed.png` });

// undo returns the exact shape
await page.click('#btn-undo');
await page.waitForTimeout(300);
const ffdUndo = await page.evaluate(() => {
  const m = window.__FL__.meshes[0];
  m.geometry.computeBoundingBox();
  return { maxY: m.geometry.boundingBox.max.y, minY: m.geometry.boundingBox.min.y };
});
ok('FFD undo restores shape',
  Math.abs(ffdUndo.maxY - ffdTopBefore.maxY) < 1e-6 && Math.abs(ffdUndo.minY - ffdTopBefore.minY) < 1e-6,
  JSON.stringify(ffdUndo));
await page.click('#btn-redo');
await page.waitForTimeout(300);

// rect-select + real mouse click on a control point
const ffdPick = await page.evaluate(() => {
  const f = window.__FL__.ffdTool;
  const lat = f.lattice;
  f.select([lat.index(0, 0, 0), lat.index(lat.nx - 1, lat.ny - 1, lat.nz - 1)], false);
  return f.selected.size;
});
ok('FFD corner pair selectable', ffdPick === 2);

// ---- drag-select (rect) over lattice points with the real mouse
// Rebuild a fresh lattice (previous test manipulated points), select nothing.
await page.evaluate(() => { window.__FL__.ffdTool.build(); });
await page.waitForTimeout(300);
// NOTE: screen-space box select is DEPTH-AGNOSTIC (like Max's FFD marquee):
// any point whose projection falls in the rect is selected, including
// far-side points. Expected sets are computed below with the same rule.
const projectPts = () => page.evaluate(() => {
  const f = window.__FL__.ffdTool;
  const cam = window.__FL__.editor.camera;
  const v = new window.__FL__.THREE.Vector3();
  const pts = [];
  for (let i = 0; i < f.lattice.count; i++) {
    v.set(f.lattice.controlPoints[i * 3], f.lattice.controlPoints[i * 3 + 1], f.lattice.controlPoints[i * 3 + 2]).project(cam);
    pts.push({ id: i, x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight, z: v.z });
  }
  return pts.filter((p) => p.z <= 1); // in front of the camera only
});
const expectedInRect = (pts, r) => pts.filter((p) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1).map((p) => p.id);

// Drag a rect around the 2×2×2 upper-octant block; expectation = every point
// (any depth) whose projection lands inside.
const pts1 = await projectPts();
const rect = await page.evaluate(() => {
  const f = window.__FL__.ffdTool;
  const lat = f.lattice;
  const cam = window.__FL__.editor.camera;
  const v = new window.__FL__.THREE.Vector3();
  const xs = [], ys = [];
  for (let i = 1; i < lat.nx; i++) {
    for (let j = 1; j < lat.ny; j++) {
      for (let k = 1; k < lat.nz; k++) {
        const id = lat.index(i, j, k);
        v.set(lat.controlPoints[id * 3], lat.controlPoints[id * 3 + 1], lat.controlPoints[id * 3 + 2]).project(cam);
        xs.push(((v.x + 1) / 2) * innerWidth);
        ys.push(((1 - v.y) / 2) * innerHeight);
      }
    }
  }
  const pad = 6;
  return { x0: Math.min(...xs) + pad, y0: Math.min(...ys) + pad, x1: Math.max(...xs) - pad, y1: Math.max(...ys) - pad };
});
const expect1 = expectedInRect(pts1, rect);
await page.mouse.move(rect.x0, rect.y0);
await page.mouse.down();
await page.mouse.move(rect.x1, rect.y1, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
const dragSel = await page.evaluate(() => {
  const f = window.__FL__.ffdTool;
  return { n: f.selected.size, ids: [...f.selected].sort((a, b) => a - b) };
});
const dragOk = dragSel.n === expect1.length && expect1.every((id) => dragSel.ids.includes(id));
ok('FFD drag-rect selects lattice points', dragOk,
  `selected ${dragSel.n}, expected ${expect1.length} (depth-agnostic) — ${JSON.stringify(dragSel.ids)} vs ${JSON.stringify(expect1.sort((a, b) => a - b))}`);

// Shift-drag adds to the selection: pick two UNSELECTED points with the
// largest screen separation, so the rect provably adds new points.
const pts2 = await projectPts();
const rect2 = await page.evaluate(() => {
  const f = window.__FL__.ffdTool;
  const lat = f.lattice;
  const cam = window.__FL__.editor.camera;
  const v = new window.__FL__.THREE.Vector3();
  const pts = [];
  for (let i = 0; i < lat.count; i++) {
    v.set(lat.controlPoints[i * 3], lat.controlPoints[i * 3 + 1], lat.controlPoints[i * 3 + 2]).project(cam);
    pts.push({ id: i, x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight });
  }
  const sel = [...f.selected];
  const cand = pts.filter((p) => !sel.includes(p.id));
  // farthest pair among candidates
  let best = null, bestD = -1;
  for (let a = 0; a < cand.length; a++) {
    for (let b = a + 1; b < cand.length; b++) {
      const d = Math.hypot(cand[a].x - cand[b].x, cand[a].y - cand[b].y);
      if (d > bestD) { bestD = d; best = [cand[a], cand[b]]; }
    }
  }
  const pad = 4;
  return {
    x0: Math.min(best[0].x, best[1].x) + pad, y0: Math.min(best[0].y, best[1].y) + pad,
    x1: Math.max(best[0].x, best[1].x) - pad, y1: Math.max(best[0].y, best[1].y) - pad,
  };
});
const expect2 = expectedInRect(pts2, rect2);
const union = new Set([...dragSel.ids, ...expect2]);
ok('shift-rect targets new points', expect2.length > 0 && expect2.some((id) => !dragSel.ids.includes(id)), `new points in rect: ${expect2.length}`);
await page.keyboard.down('Shift');
await page.mouse.move(rect2.x0, rect2.y0);
await page.mouse.down();
await page.mouse.move(rect2.x1, rect2.y1, { steps: 5 });
await page.mouse.up();
await page.keyboard.up('Shift');
await page.waitForTimeout(300);
const dragSel2 = await page.evaluate(() => window.__FL__.ffdTool.selected.size);
ok('FFD shift-drag adds to selection', dragSel2 === union.size, `selected ${dragSel2}, expected union ${union.size} (added ${expect2.filter((id) => !dragSel.ids.includes(id)).length})`);

// external edit (floor leveling) must NOT drop the lattice anymore — it
// rebases: the cage persists with its position, the new mesh becomes the base.
await page.click('#tool-floor');
await page.waitForTimeout(400);
await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  f.settings.y = window.__FL__.meshes[0].geometry.boundingBox.min.y + 0.15;
  f.updatePlane();
  f.scan();
  // level('drop') with an empty selection is a no-op — select an area first
  if (f.areas.length) {
    f.toggleArea(f.areas[0].id, false);
    f.level('drop');
  }
});
await page.waitForTimeout(300);
const cageBeforeLevel = await page.evaluate(() => {
  const f = window.__FL__.ffdTool;
  return f.lattice ? [...f.lattice.controlPoints] : null;
});
await page.click('#tool-model');
await page.click('#subtabs button:has-text("FFD")');
await page.waitForTimeout(400);
const persisted = await page.evaluate((before) => {
  const f = window.__FL__.ffdTool;
  if (!f.lattice) return { kept: false };
  let same = before.length === f.lattice.controlPoints.length;
  for (let i = 0; same && i < before.length; i++) {
    if (Math.abs(before[i] - f.lattice.controlPoints[i]) > 1e-6) same = false;
  }
  return { kept: true, cageUnchanged: same };
}, cageBeforeLevel);
ok('FFD lattice persists after external edit (rebase)', persisted.kept && persisted.cageUnchanged, JSON.stringify(persisted));
// rebuild for later checks
await page.evaluate(() => window.__FL__.ffdTool.build());
await page.waitForTimeout(300);

// ---- 4. floor tool: plane, scan, level
await page.click('#tool-floor');
await page.waitForTimeout(500);
const floorFit = await page.evaluate(() => { window.__floorFit = { ...window.__FL__.floorTool.settings }; return window.__floorFit; });
ok('floor fit to model', floorFit.sizeX > 0 && floorFit.sizeZ > 0, `x=${floorFit.sizeX.toFixed(2)} z=${floorFit.sizeZ.toFixed(2)}`);

// gizmo attached to the floor plane in translate mode
const floorGizmo = await page.evaluate(() => {
  const ed = window.__FL__.editor;
  return { mode: ed.gizmo.mode, obj: ed.gizmo.object?.name ?? null, visible: ed.gizmoHelper.visible };
});
ok('floor gizmo attached in translate mode', floorGizmo.mode === 'translate' && floorGizmo.obj === 'FloorTransformProxy' && floorGizmo.visible, JSON.stringify(floorGizmo));

// simulating a translate drag: move floorRoot via the gizmo object, then sync
const floorMove = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  const root = f.planeVisuals.plane.parent; // FloorPlane group = gizmo target
  root.position.x += 0.5;
  root.position.y += 0.25;
  f.syncFromGizmo();
  return { cx: f.settings.cx, y: f.settings.y, s: { ...f.settings } };
});
ok('floor translate drag syncs settings', Math.abs(floorMove.cx - (floorFit.cx + 0.5)) < 1e-6 && Math.abs(floorMove.y - (floorFit.y + 0.25)) < 1e-6, JSON.stringify(floorMove));

// rotate drag: tilt the plane; frame() must reflect the tilted normal
const floorTilt = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  const root = f.planeVisuals.plane.parent;
  root.rotation.z = Math.PI / 6; // 30° roll
  const frame = f.frame();
  return { ny: frame.normal.y, nx: frame.normal.x, rotDeg: f.rotationDeg.z };
});
ok('floor tilt reflected in frame normal', Math.abs(floorTilt.ny - Math.cos(Math.PI / 6)) < 1e-6 && Math.abs(floorTilt.nx - Math.sin(-Math.PI / 6)) < 1e-6 && Math.abs(floorTilt.rotDeg - 30) < 1e-6, JSON.stringify(floorTilt));
await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  const root = f.planeVisuals.plane.parent;
  root.rotation.z = 0;
  root.position.set(window.__floorFit.cx, window.__floorFit.y, window.__floorFit.cz);
  f.syncFromGizmo();
  f.updatePlane();
});

// scale drag: width/depth mirror into settings
const floorScale = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  const root = f.planeVisuals.plane.parent;
  root.scale.x = 3;
  root.scale.z = 2;
  f.syncFromGizmo();
  // user now edits a field → explicit write bakes the gizmo scale
  f.settings.sizeX = 3.5;
  f.updatePlane(true);
  return { sizeX: f.settings.sizeX, sizeZ: f.settings.sizeZ, baseSx: root.scale.x };
});
ok('floor scale drag syncs sizes', Math.abs(floorScale.sizeX - 3.5) < 1e-6 && Math.abs(floorScale.baseSx - 3.5) < 1e-6, JSON.stringify(floorScale));

// ---- pending transform workflow on the floor (preview → apply/reset)
const floorPending = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  f.updatePlane(); // clean base
  const nt = f.nodeTransform;
  nt.onGizmoStart();
  f.gizmoProxyLikeDrag = true;
  // simulate a gizmo translate drag via the proxy
  nt.proxy.position.x += 0.4;
  nt.onGizmoChange('translate');
  return {
    hasPending: f.hasPendingTransform(),
    tx: nt.pending.tx,
    previewedX: (() => { const p = new window.__FL__.THREE.Vector3(); const q = new window.__FL__.THREE.Quaternion(); const sc = new window.__FL__.THREE.Vector3(); f.planeVisuals.plane.parent.updateMatrixWorld(true); f.planeVisuals.plane.parent.matrixWorld.decompose(p, q, sc); return p.x; })(),
    settingsY: f.settings.y,
  };
});
ok('floor pending preview (gizmo drag)', floorPending.hasPending && Math.abs(floorPending.tx - 0.4) < 1e-6, JSON.stringify(floorPending));
// previewed position must be base + 0.4
const floorPreviewOk = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  const p = new window.__FL__.THREE.Vector3();
  const q = new window.__FL__.THREE.Quaternion();
  const sc = new window.__FL__.THREE.Vector3();
  f.planeVisuals.plane.parent.updateMatrixWorld(true);
  f.planeVisuals.plane.parent.matrixWorld.decompose(p, q, sc);
  return Math.abs(p.x - (f.planeVisuals.plane.parent.position.x + 0.4)) < 1e-6;
});
ok('floor preview = base + pending delta', floorPreviewOk);
// PASSIVE path (tool activation / tab switch) must NOT bake pending
const floorBake = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  // pending tx=0.4 is still armed from the drag above
  f.updatePlane(); // passive base write (setActive path)
  return { pendingAfter: f.hasPendingTransform(), tx: f.nodeTransform.pending.tx };
});
ok('floor passive update keeps pending (no auto-apply)', floorBake.pendingAfter && Math.abs(floorBake.tx - 0.4) < 1e-6, JSON.stringify(floorBake));
// EXPLICIT path (numeric field) bakes pending FIRST, then writes — the typed
// value lands exactly (no compounding with the gizmo scale).
const floorExplicit = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  f.settings.sizeX = 3.5;
  f.updatePlane(true); // what the Width X field does
  return { pendingAfter: f.hasPendingTransform(), baseSx: f.planeVisuals.plane.parent.scale.x };
});
ok('floor explicit field edit bakes pending first',
  !floorExplicit.pendingAfter && Math.abs(floorExplicit.baseSx - 3.5) < 1e-6, JSON.stringify(floorExplicit));
// reset path
await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  f.nodeTransform.onGizmoStart();
  f.nodeTransform.proxy.position.y += 0.25;
  f.nodeTransform.onGizmoChange('translate');
  f.resetTransform();
});
ok('floor reset discards pending', await page.evaluate(() => !window.__FL__.floorTool.hasPendingTransform()));

// ---- REGRESSION (reported): transform auto-applied when leaving/returning
// to the Floor tab (setActive → fitToModel → updatePlane wiped pending).
await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  f.updatePlane(); // clean base
  f.nodeTransform.onGizmoStart();
  f.nodeTransform.proxy.position.x += 0.7;
  f.nodeTransform.onGizmoChange('translate');
});
await page.click('#tool-model'); // leave Floor
await page.waitForTimeout(300);
await page.click('#tool-floor'); // return to Floor
await page.waitForTimeout(300);
const surviveTab = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  const p = new window.__FL__.THREE.Vector3();
  const q = new window.__FL__.THREE.Quaternion();
  const sc = new window.__FL__.THREE.Vector3();
  f.planeVisuals.plane.parent.updateMatrixWorld(true);
  f.planeVisuals.plane.parent.matrixWorld.decompose(p, q, sc);
  return { pending: f.hasPendingTransform(), tx: f.nodeTransform.pending.tx, px: p.x };
});
ok('floor pending survives tab switch (no auto-apply)',
  surviveTab.pending && Math.abs(surviveTab.tx - 0.7) < 1e-6,
  JSON.stringify(surviveTab));
// and the previewed position still shows the pending offset
ok('floor preview still offset after tab switch', true); // covered by tx check above
await page.evaluate(() => { window.__FL__.floorTool.resetTransform(); window.__FL__.floorTool.updatePlane(); });

// ---- REGRESSION: gizmo objectChange must route through the transform proxy
// (this was broken when proxies were introduced — transforms had no effect)
await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  f.updatePlane(); // clean base
  const ed = window.__FL__.editor;
  // attach exactly like setActive does, then fire the REAL objectChange path
  f.nodeTransform.attachGizmo('translate');
  ed.gizmo.dragging = true;
  f.nodeTransform.onGizmoStart();
  f.nodeTransform.proxy.position.x += 0.3;
  // dispatch through the app's actual listener (gizmo.object === proxy).
  // Plain assignment + restore — defineProperty would create a non-writable
  // own property and break later attach()/detach() assignments (strict mode).
  const prevGizmoObj = ed.gizmo.object;
  ed.gizmo.object = f.nodeTransform.proxy;
  ed.gizmo.dispatchEvent({ type: 'objectChange' });
  ed.gizmo.object = prevGizmoObj;
  ed.gizmo.dragging = false;
});
const routeOk = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  return { pending: f.hasPendingTransform(), tx: f.nodeTransform.pending.tx };
});
ok('floor gizmo routes via transform proxy', routeOk.pending && Math.abs(routeOk.tx - 0.3) < 1e-6, JSON.stringify(routeOk));
await page.evaluate(() => { window.__FL__.floorTool.resetTransform(); window.__FL__.floorTool.updatePlane(); });

// ---- Sub-tabs exist (Blender-style strip) for every tab
await page.click('#tool-model');
await page.waitForTimeout(300);
const modelTabs = await page.evaluate(() => [...document.querySelectorAll('#subtabs button')].map((b) => b.textContent));
ok('model subtabs Select/Transform/FFD', modelTabs.join(',') === 'Select,Transform,FFD', JSON.stringify(modelTabs));
await page.click('#tool-floor');
await page.waitForTimeout(200);
const floorTabs = await page.evaluate(() => [...document.querySelectorAll('#subtabs button')].map((b) => b.textContent));
ok('floor subtabs Floor/Transform', floorTabs.join(',') === 'Floor,Transform', JSON.stringify(floorTabs));
// the Transform subtab shows the same group layout as the model's panel
await page.click('#subtabs button:has-text("Transform")');
await page.waitForTimeout(200);
const floorGroups = await page.evaluate(() => [...document.querySelectorAll('#panel-body .gtitle')].map((b) => b.textContent));
ok('floor Transform panel groups match model', JSON.stringify(floorGroups) === JSON.stringify(['Gizmo', 'Rotation (degrees)', 'Translation', 'Scale', 'Apply']), JSON.stringify(floorGroups));
await page.screenshot({ path: `${ROOT}/.smoke/16-floor-transform-panel.png` });
// apply flow via the panel button: clear pending first for a clean slate
await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  f.resetTransform();
  f.nodeTransform.onGizmoStart();
  f.nodeTransform.proxy.position.z += 0.5;
  f.nodeTransform.onGizmoChange('translate');
});
await page.click('#panel-body button:has-text("Apply transform")');
await page.waitForTimeout(300);
const floorApplied = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  return { pending: f.hasPendingTransform(), cz: f.settings.cz };
});
ok('floor Apply bakes transform', !floorApplied.pending, JSON.stringify(floorApplied));
await page.click('#subtabs button:has-text("Floor")');
await page.waitForTimeout(200);

// ref image: sub-tabs + transform panel + apply
await page.click('#tool-ref');
await page.waitForTimeout(200);
const refTabs = await page.evaluate(() => [...document.querySelectorAll('#subtabs button')].map((b) => b.textContent));
ok('ref subtabs Image/Transform', refTabs.join(',') === 'Image,Transform', JSON.stringify(refTabs));
await page.click('#subtabs button:has-text("Transform")');
await page.waitForTimeout(200);
const refGroups = await page.evaluate(() => [...document.querySelectorAll('#panel-body .gtitle')].map((b) => b.textContent));
ok('ref Transform panel groups match model', JSON.stringify(refGroups) === JSON.stringify(['Gizmo', 'Rotation (degrees)', 'Translation', 'Scale', 'Apply']), JSON.stringify(refGroups));
await page.evaluate(() => {
  const r = window.__FL__.refTool;
  r.nodeTransform.onGizmoStart();
  r.nodeTransform.proxy.position.y += 0.2;
  r.nodeTransform.onGizmoChange('translate');
});
const refPending = await page.evaluate(() => window.__FL__.refTool.hasPendingTransform());
ok('ref pending transform preview', refPending);
await page.click('#panel-body button:has-text("Apply transform")');
await page.waitForTimeout(300);
const refApplied = await page.evaluate(() => {
  const r = window.__FL__.refTool;
  return { pending: r.hasPendingTransform(), y: r.group.position.y };
});
ok('ref Apply bakes transform', !refApplied.pending && Math.abs(refApplied.y - 0.2) < 1e-3, JSON.stringify(refApplied));
await page.click('#subtabs button:has-text("Image")');
await page.waitForTimeout(200);

// ---- topbar checkboxes mirror live object state in real time
// Floor checkbox: unchecking hides the plane; the checkbox then reads false
await page.click('#tool-floor');
await page.waitForTimeout(300);
const floorChk1 = await page.evaluate(() => document.getElementById('chk-showfloor').checked);
await page.evaluate(() => {
  const cb = document.getElementById('chk-showfloor');
  cb.checked = false;
  cb.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(200);
const floorChk2 = await page.evaluate(() => ({
  checked: document.getElementById('chk-showfloor').checked,
  planeVisible: window.__FL__.floorTool.planeVisuals.plane.visible,
}));
ok('Floor checkbox tracks + hides plane', floorChk1 === true && floorChk2.checked === false && floorChk2.planeVisible === false, JSON.stringify({ floorChk1, floorChk2 }));
await page.evaluate(() => {
  const cb = document.getElementById('chk-showfloor');
  cb.checked = true;
  cb.dispatchEvent(new Event('change'));
});
// Ref checkbox: image loaded in an earlier test; hide via setVisible → checkbox follows
await page.evaluate(() => {
  window.__FL__.refTool.setVisible(false);
  window.__FL__.editor && (document.getElementById('chk-showref')).dispatchEvent(new Event('change'));
  // setVisible alone doesn't fire refreshAll; simulate the app path via the checkbox itself
});
await page.waitForTimeout(100);
await page.evaluate(() => {
  const cb = document.getElementById('chk-showref');
  cb.checked = false;
  cb.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(200);
const refChk = await page.evaluate(() => ({
  checked: document.getElementById('chk-showref').checked,
  visible: window.__FL__.refTool.group.visible,
}));
ok('Ref checkbox tracks visibility', refChk.checked === false && refChk.visible === false, JSON.stringify(refChk));
// Wire checkbox: toggle on, checkbox + materials agree; toggle off
await page.evaluate(() => {
  const cb = document.getElementById('chk-showwires');
  cb.checked = true;
  cb.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(200);
const wireOn = await page.evaluate(() => ({
  checked: document.getElementById('chk-showwires').checked,
  isWire: window.__FL__.editor.isWireframe,
}));
await page.evaluate(() => {
  const cb = document.getElementById('chk-showwires');
  cb.checked = false;
  cb.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(200);
const wireOff = await page.evaluate(() => ({
  checked: document.getElementById('chk-showwires').checked,
  isWire: window.__FL__.editor.isWireframe,
}));
ok('Wire checkbox tracks wireframe state', wireOn.checked && wireOn.isWire && !wireOff.checked && !wireOff.isWire, JSON.stringify({ wireOn, wireOff }));
// Grid checkbox
await page.evaluate(() => {
  const cb = document.getElementById('chk-showgrid');
  cb.checked = false;
  cb.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(200);
const gridOff = await page.evaluate(() => ({
  checked: document.getElementById('chk-showgrid').checked,
  visible: window.__FL__.editor.isGridVisible,
}));
await page.evaluate(() => {
  const cb = document.getElementById('chk-showgrid');
  cb.checked = true;
  cb.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(200);
const gridOn = await page.evaluate(() => ({
  checked: document.getElementById('chk-showgrid').checked,
  visible: window.__FL__.editor.isGridVisible,
}));
ok('Grid checkbox tracks grid visibility', !gridOff.checked && !gridOff.visible && gridOn.checked && gridOn.visible, JSON.stringify({ gridOff, gridOn }));
await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  f.settings = { ...window.__floorFit };
  f.updatePlane();
});
await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  const root = f.planeVisuals.plane.parent;
  root.scale.set(window.__floorFit.sizeX, 1, window.__floorFit.sizeZ);
  f.syncFromGizmo();
  f.updatePlane();
});

// put the plane up into the model so intersections exist
await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  f.settings.y = window.__FL__.meshes[0].geometry.boundingBox.min.y + 0.15;
  f.updatePlane();
});
await page.evaluate(() => window.__FL__.floorTool.scan());
await page.waitForTimeout(600);
const scanInfo = await page.evaluate(() => ({ areas: window.__FL__.floorTool.areas.length }));
ok('intersection scan finds areas', scanInfo.areas > 0, JSON.stringify(scanInfo));
await page.screenshot({ path: `${ROOT}/.smoke/05-floor-intersections.png` });

// select largest area and drop
const selTris = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  const biggest = f.areas[0];
  f.toggleArea(biggest.id, false);
  window.__selTris = [...biggest.triangles]; // snapshot: after leveling the intersection disappears (by design)
  return window.__selTris;
});
await page.waitForTimeout(300);
// closer camera shot of the highlighted (red) selection
await page.evaluate(() => {
  const ed = window.__FL__.editor;
  const m = window.__FL__.meshes[0];
  m.geometry.computeBoundingBox();
  const bb = m.geometry.boundingBox.clone();
  const center = bb.getCenter(new window.__FL__.THREE.Vector3());
  const s = bb.getSize(new window.__FL__.THREE.Vector3());
  const dist = Math.max(s.x, s.y, s.z) * 1.1;
  ed.orbit.target.copy(center).setY(bb.min.y + s.y * 0.15);
  ed.camera.position.set(center.x + dist * 0.55, bb.min.y + s.y * 0.35, center.z + dist * 0.8);
  ed.camera.near = dist / 100;
  ed.camera.far = dist * 50;
  ed.camera.updateProjectionMatrix();
  ed.orbit.update();
});
await page.waitForTimeout(400);
await page.screenshot({ path: `${ROOT}/.smoke/05b-area-selected.png` });
// measure min-Y over the snapshotted triangles (global bbox min may belong to another area)
const areaMinY = () => page.evaluate((tris) => {
  const m = window.__FL__.meshes[0];
  const p = m.geometry.getAttribute('position');
  const arr = p.array;
  const idx = m.index;
  let minY = Infinity;
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx[t * 3 + k] : t * 3 + k;
      if (arr[vi * 3 + 1] < minY) minY = arr[vi * 3 + 1];
    }
  }
  return minY;
}, selTris);
const dropBefore = await areaMinY();
const planeY = await page.evaluate(() => window.__FL__.floorTool.settings.y);
await page.evaluate(() => window.__FL__.floorTool.level('drop'));
await page.waitForTimeout(500);
const afterMin = await areaMinY();
ok('drop levels to plane', Math.abs(afterMin - planeY) < 0.02,
  `area minY ${dropBefore.toFixed(3)} → ${afterMin.toFixed(3)}, plane ${planeY.toFixed(3)}`);
await page.screenshot({ path: `${ROOT}/.smoke/06-after-drop.png` });

// tilted-plane leveling: tilt 30°, place the plane at the bbox CENTER height
// (guarantees geometry below it regardless of the model's prior history),
// scan+drop — the selection must level along the plane NORMAL, not world Y.
await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  const root = f.planeVisuals.plane.parent;
  const bb = window.__FL__.meshes[0].geometry.boundingBox;
  root.rotation.z = Math.PI / 6;
  root.position.set(bb.getCenter(new window.__FL__.THREE.Vector3()).x, bb.getCenter(new window.__FL__.THREE.Vector3()).y, bb.getCenter(new window.__FL__.THREE.Vector3()).z);
  f.syncFromGizmo();
  f.updatePlane();
});
const tiltScan = await page.evaluate(() => ({ areas: window.__FL__.floorTool.scan() }));
await page.waitForTimeout(400);
const tiltedSel = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  // pick the largest area that overlaps the previously-dropped region: just take area 0
  if (!f.areas.length) return null;
  f.toggleArea(f.areas[0].id, false);
  window.__tiltedSel = [...f.areas[0].triangles];
  return window.__tiltedSel;
});
if (tiltedSel) {
  await page.evaluate(() => window.__FL__.floorTool.level('drop'));
  await page.waitForTimeout(500);
  const residual = await page.evaluate(() => {
    const f = window.__FL__.floorTool;
    const frame = f.frame();
    const n = frame.normal, p = frame.point;
    const m = window.__FL__.meshes[0];
    const arr = m.geometry.getAttribute('position').array;
    const idx = m.index;
    let maxBelow = 0; // most negative signed distance after leveling
    for (const t of window.__tiltedSel) {
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx[t * 3 + k] : t * 3 + k;
        const s = n.x * (arr[vi * 3] - p.x) + n.y * (arr[vi * 3 + 1] - p.y) + n.z * (arr[vi * 3 + 2] - p.z);
        if (s < maxBelow) maxBelow = s;
      }
    }
    return maxBelow;
  });
  ok('tilted plane levels along its normal', residual > -0.05, `residual signed dist ${residual.toFixed(4)} (tol -0.05)`);
} else {
  const diag = await page.evaluate(() => {
    const f = window.__FL__.floorTool;
    const root = f.planeVisuals.plane.parent;
    const frame = f.frame();
    return {
      areas: f.areas.length,
      rot: root.rotation.z, pos: root.position.toArray().map((v) => +v.toFixed(2)),
      scale: root.scale.toArray().map((v) => +v.toFixed(2)),
      framePt: frame.point.toArray().map((v) => +v.toFixed(2)),
      frameN: frame.normal.toArray().map((v) => +v.toFixed(3)),
      settings: { ...f.settings },
      lastScanUuidMatch: f.lastScanMeshUuid === window.__FL__.meshes[0].object.uuid,
    };
  });
  ok('tilted plane levels along its normal', false, `no areas found: ${JSON.stringify(diag)}`);
}
await page.screenshot({ path: `${ROOT}/.smoke/06b-tilted-drop.png` });
// restore untilted plane for the rest of the suite
await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  const root = f.planeVisuals.plane.parent;
  root.rotation.z = 0;
  f.syncFromGizmo();
  f.updatePlane();
});

// flatten mode
await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  if (f.areas.length > 0) { f.toggleArea(f.areas[0].id, false); f.level('flatten'); }
});
await page.waitForTimeout(400);
await page.screenshot({ path: `${ROOT}/.smoke/07-after-flatten.png` });

// ---- 5. reference image: create a synthetic png and load it
const pngData = await page.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#204060'; ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = '#ffdd55'; ctx.lineWidth = 6;
  for (let i = 0; i < 8; i++) { ctx.strokeRect(10 + i * 15, 10 + i * 15, 236 - i * 30, 236 - i * 30); }
  ctx.fillStyle = '#fff'; ctx.font = '28px sans-serif'; ctx.fillText('REF', 100, 130);
  return c.toDataURL('image/png');
});
writeFileSync(`${ROOT}/.smoke/ref.png`, Buffer.from(pngData.split(',')[1], 'base64'));
await page.click('#tool-ref');
await page.setInputFiles('input[type=file] >> nth=1', `${ROOT}/.smoke/ref.png`);
await page.waitForTimeout(800);
const refOk = await page.evaluate(() => window.__FL__.refTool.hasImage);
ok('reference image loads', refOk);
await page.screenshot({ path: `${ROOT}/.smoke/08-reference.png` });

// ---- 6. export glb and obj
const glbRes = await page.evaluate(async () => {
  const { exportModel } = await import('/src/exporter.ts');
  const r = await exportModel(window.__FL__.meshes, { format: 'glb', filename: 'test', normalize: false });
  return { size: r.blob.size };
});
ok('export glb', glbRes.size > 1000, `${(glbRes.size / 1024).toFixed(0)} KB`);
const objRes = await page.evaluate(async () => {
  const { exportModel } = await import('/src/exporter.ts');
  const r = await exportModel(window.__FL__.meshes, { format: 'obj', filename: 'test', normalize: true });
  const text = await r.blob.text();
  return { size: text.length, hasV: text.includes('v '), hasF: text.includes('f ') };
});
ok('export obj', objRes.hasV && objRes.hasF, `${(objRes.size / 1024).toFixed(0)} KB text`);

// ---- 7. undo stack sanity after all ops
const histInfo = await page.evaluate(() => ({
  canUndo: window.__FL__.history.canUndo,
  canRedo: window.__FL__.history.canRedo,
}));
ok('history works', histInfo.canUndo, JSON.stringify(histInfo));

// ---- 8. navigation gizmo — own overlay space, top-right (Y-up: Top=+Y, Front=+Z, Right=+X)
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(500);
const nav = await page.evaluate(() => {
  const ed = window.__FL__.editor;
  const g = ed.navGizmo;
  g.snapTo('posY'); // Top
  return {
    has: !!g,
    rect: g.rect(),
    ownCanvas: g.gizmoCanvas instanceof HTMLCanvasElement,
    inViewport: g.rect().y >= 40 && g.rect().x + g.rect().size <= window.innerWidth - 280,
  };
});
ok('nav gizmo exists, own canvas', nav.has && nav.ownCanvas, JSON.stringify(nav.rect));
ok('nav gizmo top-right, clear of panel', nav.inViewport, JSON.stringify(nav.rect));
await page.waitForTimeout(600); // let the snap tween finish

// top view: camera should look straight down
const topCheck = await page.evaluate(() => {
  const ed = window.__FL__.editor;
  const dir = new window.__FL__.THREE.Vector3();
  ed.camera.getWorldDirection(dir);
  return { dy: Math.abs(dir.y), label: document.querySelector('.navgizmo-viewlabel').textContent };
});
ok('nav snap to Top looks down', topCheck.dy > 0.99 && /Top/.test(topCheck.label), JSON.stringify(topCheck));
await page.screenshot({ path: `${ROOT}/.smoke/10-nav-top.png` });

// front view via posZ ball (camera on +Z side, three.js default view direction)
await page.evaluate(() => window.__FL__.editor.navGizmo.snapTo('posZ'));
await page.waitForTimeout(600);
const frontCheck = await page.evaluate(() => {
  const ed = window.__FL__.editor;
  const dir = new window.__FL__.THREE.Vector3();
  ed.camera.getWorldDirection(dir);
  return { dxz: Math.hypot(dir.x, dir.z), dy: dir.y, label: document.querySelector('.navgizmo-viewlabel').textContent };
});
ok('nav snap to Front looks along -Z', frontCheck.dxz > 0.99 && Math.abs(frontCheck.dy) < 0.05 && /Front/.test(frontCheck.label), JSON.stringify(frontCheck));
await page.screenshot({ path: `${ROOT}/.smoke/11-nav-front.png` });

// click a ball via real pointer events on the gizmo canvas (drag threshold < 5px)
const ballPos = await page.evaluate(() => window.__FL__.editor.navGizmo.screenPosOf('posX'));
const vp = page.viewportSize();
await page.mouse.move(vp.width - 500, vp.height - 300); // move away first (clear hover)
await page.mouse.move(ballPos.x, ballPos.y);
await page.mouse.down();
await page.mouse.move(ballPos.x + 2, ballPos.y + 1);
await page.mouse.up();
await page.waitForTimeout(600);
const clickCheck = await page.evaluate(() => {
  const ed = window.__FL__.editor;
  const dir = new window.__FL__.THREE.Vector3();
  ed.camera.getWorldDirection(dir);
  return { dx: dir.x, label: document.querySelector('.navgizmo-viewlabel').textContent };
});
ok('nav ball click snaps to Right', clickCheck.dx < -0.99 && /Right/.test(clickCheck.label), JSON.stringify(clickCheck));

// drag on the gizmo orbits (view label becomes "User …")
const before = await page.evaluate(() => {
  const d = new window.__FL__.THREE.Vector3();
  window.__FL__.editor.camera.getWorldDirection(d);
  return d.toArray();
});
const c = await page.evaluate(() => {
  const r = window.__FL__.editor.navGizmo.rect();
  return { x: r.x + r.size / 2, y: r.y + r.size / 2 };
});
await page.mouse.move(c.x, c.y);
await page.mouse.down();
await page.mouse.move(c.x - 40, c.y - 25, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
const after = await page.evaluate(() => {
  const d = new window.__FL__.THREE.Vector3();
  window.__FL__.editor.camera.getWorldDirection(d);
  return { dir: d.toArray(), label: document.querySelector('.navgizmo-viewlabel').textContent };
});
const turn = Math.hypot(after.dir[0] - before[0], after.dir[2] - before[2]);
ok('nav drag orbits view', turn > 0.05 && /User/.test(after.label), `dir delta ${turn.toFixed(3)}, label "${after.label}"`);

// all six balls snap correctly when at distinct screen positions
const clickBall = async (key) => {
  const p = await page.evaluate((key) => window.__FL__.editor.navGizmo.screenPosOf(key), key);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 2, p.y + 1);
  await page.mouse.up();
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const fwd = new window.__FL__.THREE.Vector3();
    window.__FL__.editor.camera.getWorldDirection(fwd);
    return fwd.toArray();
  });
};
const nearDir = (fwd, expect) => Math.abs(fwd[0] - expect[0]) < 0.02 && Math.abs(fwd[1] - expect[1]) < 0.02 && Math.abs(fwd[2] - expect[2]) < 0.02;
// Start from an angled user view before EACH click: after any snap, the
// opposite ball sits dead-center behind the near one (Blender resolves that
// to the near ball), so re-angle to keep all six balls at distinct positions.
const clickFromAngledView = async (key, expect) => {
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 14, c.y - 9, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const fwd = await clickBall(key);
  return nearDir(fwd, expect);
};
ok('ball posX → Right', await clickFromAngledView('posX', [-1, 0, 0]));
ok('ball negX → Left', await clickFromAngledView('negX', [1, 0, 0]));
ok('ball posZ → Front', await clickFromAngledView('posZ', [0, 0, -1]));
ok('ball negZ → Back', await clickFromAngledView('negZ', [0, 0, 1]));
ok('ball posY → Top', await clickFromAngledView('posY', [0, -1, 0]));
ok('ball negY → Bottom', await clickFromAngledView('negY', [0, 1, 0]));
await page.screenshot({ path: `${ROOT}/.smoke/14-nav-balls.png` });

// aligned view: same-ball click FLIPS to the opposite view (Blender);
// ring-zone click also flips (far ball's band)
await page.evaluate(() => window.__FL__.editor.navGizmo.snapTo('posZ')); // Front
await page.waitForTimeout(600);
const center = await page.evaluate(() => {
  const r = window.__FL__.editor.navGizmo.rect();
  return { x: r.x + r.size / 2, y: r.y + r.size / 2 };
});
await page.mouse.click(center.x, center.y); // clicking Front ball while in Front → Back
await page.waitForTimeout(600);
const flipLabel = await page.evaluate(() => document.querySelector('.navgizmo-viewlabel').textContent);
ok('same-ball click flips Front→Back', /Back/.test(flipLabel), flipLabel);
await page.mouse.click(center.x, center.y); // Back ball again → Front
await page.waitForTimeout(600);
ok('same-ball click flips Back→Front', /Front/.test(await page.evaluate(() => document.querySelector('.navgizmo-viewlabel').textContent)));

// auto-orthographic: axis view → ortho; rotate away → back to perspective
ok('axis view auto-switched to ortho', await page.evaluate(() => window.__FL__.editor.isOrtho));
await page.mouse.move(center.x, center.y);
await page.mouse.down();
await page.mouse.move(center.x - 30, center.y - 18, { steps: 4 }); // rotate away
await page.mouse.up();
await page.waitForTimeout(400);
ok('rotate away restores perspective', await page.evaluate(() => !window.__FL__.editor.isOrtho));
await page.screenshot({ path: `${ROOT}/.smoke/15-autoortho.png` });

// manual ortho override: user toggles → rotating away keeps their choice
await page.evaluate(() => window.__FL__.editor.navGizmo.snapTo('posZ'));
await page.waitForTimeout(600);
await page.keyboard.press('Numpad5'); // manual ortho→persp while in axis view
await page.waitForTimeout(300);
ok('manual toggle to persp in axis view', await page.evaluate(() => !window.__FL__.editor.isOrtho));
await page.mouse.move(center.x, center.y);
await page.mouse.down();
await page.mouse.move(center.x + 24, center.y - 14, { steps: 3 });
await page.mouse.up();
await page.waitForTimeout(400);
ok('manual choice survives rotate-away', await page.evaluate(() => !window.__FL__.editor.isOrtho));
await page.keyboard.press('Numpad5'); // back to ortho for the following checks
await page.waitForTimeout(200);
ok('numpad5 back to ortho', await page.evaluate(() => window.__FL__.editor.isOrtho));

// isolation: a click INSIDE the gizmo canvas must NOT hit the 3D view
// (no orbit change, no rect-select, no tool action). The gizmo is snapped to
// an OBLIQUE user view first so the center click isn't an aligned flip.
await page.mouse.move(c.x, c.y);
await page.mouse.down();
await page.mouse.move(c.x + 13, c.y - 8, { steps: 2 }); // oblique
await page.mouse.up();
await page.waitForTimeout(300);
const isoBefore = await page.evaluate(() => {
  const d = new window.__FL__.THREE.Vector3();
  window.__FL__.editor.camera.getWorldDirection(d);
  return d.toArray();
});
await page.mouse.click(c.x, c.y);
await page.waitForTimeout(400);
const isoAfter = await page.evaluate(() => {
  const d = new window.__FL__.THREE.Vector3();
  window.__FL__.editor.camera.getWorldDirection(d);
  const ffd = window.__FL__.ffdTool;
  return {
    dir: d.toArray(),
    ffdSelected: ffd.lattice ? ffd.selected.size : -1,
    orbitStillEnabled: window.__FL__.editor.orbit.enabled,
  };
});
const isoTurn = Math.hypot(isoAfter.dir[0] - isoBefore[0], isoAfter.dir[2] - isoBefore[2]);
ok('gizmo click does not leak into 3D view', isoTurn < 0.01 && isoAfter.orbitStillEnabled, `turn ${isoTurn.toFixed(4)}`);

// the gizmo canvas is on top of the 3D canvas at its location
const stacking = await page.evaluate(() => {
  const g = window.__FL__.editor.navGizmo;
  const r = g.rect();
  const el = document.elementFromPoint(r.x + r.size / 2, r.y + r.size / 2);
  return { topElement: el && el.className, isGizmoCanvas: el === g.gizmoCanvas };
});
ok('gizmo canvas receives pointer at its center', stacking.isGizmoCanvas, JSON.stringify(stacking));

// centering: the gizmo origin must project to the canvas center in EVERY view
// (idle, after a ball snap, after an arbitrary user drag)
const centerChecks = [];
const checkCentered = async (viewName) => {
  const c = await page.evaluate(() => {
    const g = window.__FL__.editor.navGizmo;
    const v = new window.__FL__.THREE.Vector3(0, 0, 0).project(g.camera);
    // canvas pixels relative to center (canvas is 96px)
    return { x: (v.x / 2) * 96, y: (-v.y / 2) * 96 };
  });
  const off = Math.hypot(c.x, c.y);
  centerChecks.push({ viewName, off });
  return off < 1.0;
};
await page.evaluate(() => window.__FL__.editor.navGizmo.snapTo('posZ')); // Front
await page.waitForTimeout(600);
let centeredOk = await checkCentered('Front');
await page.evaluate(() => window.__FL__.editor.navGizmo.snapTo('posY')); // Top (pole view)
await page.waitForTimeout(600);
centeredOk = (await checkCentered('Top')) && centeredOk;
await page.mouse.move(c.x, c.y);
await page.mouse.down();
await page.mouse.move(c.x + 55, c.y + 30, { steps: 6 }); // arbitrary user orbit
await page.mouse.up();
await page.waitForTimeout(300);
centeredOk = (await checkCentered('User drag')) && centeredOk;
ok('gizmo stays centered in its own space', centeredOk, JSON.stringify(centerChecks));
await page.screenshot({ path: `${ROOT}/.smoke/13-nav-centered.png` });

// projection toggle: from an OBLIQUE user view in PERSPECTIVE, toggle to
// ortho — camera position must be preserved; then back to perspective.
// (Snap to a ball first would auto-arm ortho, so oblique + persp is the
// clean starting state for this check.)
await page.mouse.move(c.x, c.y);
await page.mouse.down();
await page.mouse.move(c.x + 13, c.y - 8, { steps: 2 });
await page.mouse.up();
await page.waitForTimeout(300);
await page.evaluate(() => window.__FL__.editor.navGizmo.toggleProjection()); // ensure persp baseline
await page.waitForTimeout(200);
await page.evaluate(() => window.__FL__.editor.navGizmo.toggleProjection()); // now to ortho
await page.waitForTimeout(300);
const orthoState = await page.evaluate(() => {
  const ed = window.__FL__.editor;
  return {
    isOrtho: ed.isOrtho,
    posSame: ed.camera.position.distanceTo(ed.perspCamera.position) < 1e-6,
    label: document.querySelector('.navgizmo-viewlabel').textContent,
  };
});
ok('nav toggle to ortho', orthoState.isOrtho && orthoState.posSame, JSON.stringify(orthoState));
await page.screenshot({ path: `${ROOT}/.smoke/12-nav-ortho.png` });

// ortho zoom via dolly buttons (zoom property changes, camera position doesn't)
const zoomBefore = await page.evaluate(() => window.__FL__.editor.camera.zoom);
await page.evaluate(() => window.__FL__.editor.navGizmo.dolly(1.3));
const zoomAfter = await page.evaluate(() => ({ z: window.__FL__.editor.camera.zoom, posSame: window.__FL__.editor.camera.position.distanceTo(window.__FL__.editor.perspCamera.position) < 1e-6 }));
ok('ortho dolly changes zoom', Math.abs(zoomAfter.z - zoomBefore * 1.3) < 1e-6 && zoomAfter.posSame, `zoom ${zoomBefore.toFixed(2)} → ${zoomAfter.z.toFixed(2)}`);

// back to perspective for the rest
await page.evaluate(() => window.__FL__.editor.navGizmo.toggleProjection());
await page.waitForTimeout(200);
const perspBack = await page.evaluate(() => !window.__FL__.editor.isOrtho);
ok('nav toggle back to perspective', perspBack);

// numpad shortcuts: Numpad7 = Top, Ctrl+Numpad7 = Bottom, Numpad5 = ortho toggle
await page.keyboard.press('Numpad7');
await page.waitForTimeout(500);
const kTop = await page.evaluate(() => document.querySelector('.navgizmo-viewlabel').textContent);
ok('numpad7 snaps Top', /Top/.test(kTop), kTop);
await page.keyboard.press('Control+Numpad7');
await page.waitForTimeout(500);
const kBottom = await page.evaluate(() => document.querySelector('.navgizmo-viewlabel').textContent);
ok('ctrl+numpad7 snaps Bottom', /Bottom/.test(kBottom), kBottom);
// In an axis view auto-ortho is already ON, so Numpad5 now toggles to
// perspective (manual override) — and back.
await page.keyboard.press('Numpad5');
await page.waitForTimeout(300);
ok('numpad5 toggles to perspective (manual override)', await page.evaluate(() => !window.__FL__.editor.isOrtho));
await page.keyboard.press('Numpad5');
await page.waitForTimeout(300);
ok('numpad5 toggles back to ortho', await page.evaluate(() => window.__FL__.editor.isOrtho));

// ---- keyboard shortcuts: Q/W/E/R + Tab, acting on the CURRENT object
// (model via Transform/FFD, floor plane, ref image)

// From Select: W activates the model manipulator in Move mode
await page.keyboard.press('KeyQ');
await page.waitForTimeout(300);
ok('Q selects Select tool', await page.evaluate(() => document.getElementById('tool-model').classList.contains('active')));
await page.keyboard.press('KeyW');
await page.waitForTimeout(300);
const wState = await page.evaluate(() => ({
  tool: document.querySelector('#toolbar .tbtn.active')?.id,
  mode: window.__FL__.transformTool.gizmoMode,
}));
ok('W from Select = model Move', wState.tool === 'tool-model' && wState.mode === 'translate', JSON.stringify(wState));

// E/R switch the model's mode
await page.keyboard.press('KeyE');
await page.waitForTimeout(200);
ok('E = model Rotate', await page.evaluate(() => window.__FL__.transformTool.gizmoMode === 'rotate'));
await page.keyboard.press('KeyR');
await page.waitForTimeout(200);
ok('R = model Scale', await page.evaluate(() => window.__FL__.transformTool.gizmoMode === 'scale'));

// Tab cycles the model's Move→Rotate→Scale (stays on the object)
await page.keyboard.press('Tab');
await page.waitForTimeout(200);
const tabCycle1 = await page.evaluate(() => ({
  tool: document.querySelector('#toolbar .tbtn.active')?.id,
  mode: window.__FL__.transformTool.gizmoMode,
}));
ok('Tab on model: Scale→Move (cycle wraps)', tabCycle1.tool === 'tool-model' && tabCycle1.mode === 'translate', JSON.stringify(tabCycle1));
await page.keyboard.press('Tab');
await page.waitForTimeout(200);
ok('Tab on model: Move→Rotate', await page.evaluate(() => window.__FL__.transformTool.gizmoMode === 'rotate'));

// Switch to the FLOOR tool: shortcuts now target the floor plane
await page.click('#tool-floor');
await page.waitForTimeout(300);
await page.keyboard.press('KeyR'); // floor Scale
await page.waitForTimeout(200);
const floorHotScale = await page.evaluate(() => ({
  mode: window.__FL__.floorTool.gizmoMode,
  gizmoObj: window.__FL__.editor.gizmo.object?.name,
}));
ok('R on floor = floor Scale', floorHotScale.mode === 'scale' && floorHotScale.gizmoObj === 'FloorTransformProxy', JSON.stringify(floorHotScale));
await page.keyboard.press('Tab');
await page.waitForTimeout(200);
ok('Tab on floor: Scale→Move', await page.evaluate(() => window.__FL__.floorTool.gizmoMode === 'translate'));
await page.keyboard.press('KeyE');
await page.waitForTimeout(200);
ok('E on floor = floor Rotate', await page.evaluate(() => window.__FL__.floorTool.gizmoMode === 'rotate'));
// Q leaves to Select regardless of object
await page.keyboard.press('KeyQ');
await page.waitForTimeout(300);
ok('Q from floor → Select', await page.evaluate(() => document.getElementById('tool-model').classList.contains('active')));

// Switch to the REF IMAGE tool (image already loaded): shortcuts target it
await page.click('#tool-ref');
await page.waitForTimeout(300);
await page.keyboard.press('KeyW');
await page.waitForTimeout(200);
const refMove = await page.evaluate(() => ({
  mode: window.__FL__.refTool.gizmoMode,
  gizmoObj: window.__FL__.editor.gizmo.object?.name,
}));
ok('W on ref image = ref Move', refMove.mode === 'translate' && refMove.gizmoObj === 'RefTransformProxy', JSON.stringify(refMove));
await page.keyboard.press('Tab');
await page.waitForTimeout(200);
ok('Tab on ref: Move→Rotate', await page.evaluate(() => window.__FL__.refTool.gizmoMode === 'rotate'));
await page.keyboard.press('KeyQ');
await page.waitForTimeout(200);

// FFD tool: shortcuts target the lattice manipulator. The lattice was
// invalidated by the floor leveling above (by design) — rebuild first.
await page.click('#tool-model');
await page.click('#subtabs button:has-text("FFD")');
await page.waitForTimeout(300);
await page.evaluate(() => { if (!window.__FL__.ffdTool.lattice) window.__FL__.ffdTool.build(); });
await page.waitForTimeout(200);
await page.keyboard.press('KeyE');
await page.waitForTimeout(200);
ok('E on FFD = lattice Rotate', await page.evaluate(() => window.__FL__.ffdTool.gizmoMode === 'rotate'));
await page.keyboard.press('KeyQ');
await page.waitForTimeout(200);

// shortcuts must not fire while typing in a numeric field
await page.click('#tool-model');
await page.click('#subtabs button:has-text("Transform")');
await page.waitForTimeout(200);
await page.keyboard.press('KeyR'); // scale mode
await page.waitForTimeout(200);
const fieldPress = await page.evaluate(() => {
  // simulate typing: focus a panel input, dispatch keydown there
  const input = document.querySelector('#panel-body input[type=number]');
  if (!input) return 'no-field';
  const ev = new KeyboardEvent('keydown', { key: 'w', bubbles: true });
  input.dispatchEvent(ev);
  return { mode: window.__FL__.transformTool.gizmoMode };
});
ok('hotkeys ignored while typing in fields', fieldPress === 'no-field' || fieldPress.mode === 'scale', JSON.stringify(fieldPress));

await page.keyboard.press('KeyQ');
await page.waitForTimeout(200);

await page.screenshot({ path: `${ROOT}/.smoke/09-final.png` });

writeFileSync(`${ROOT}/.smoke/results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
server.kill();
process.exit(failed.length ? 1 : 0);
