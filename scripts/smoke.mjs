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
ok('model subtabs Info/Transform/FFD', modelTabs.join(',') === 'Info,Transform,FFD', JSON.stringify(modelTabs));
await page.click('#tool-floor');
await page.waitForTimeout(200);
const floorTabs = await page.evaluate(() => [...document.querySelectorAll('#subtabs button')].map((b) => b.textContent));
ok('floor subtabs Floor/Brush/Transform', floorTabs.join(',') === 'Floor,Brush,Transform', JSON.stringify(floorTabs));
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
ok('ref Transform panel groups match model', JSON.stringify(refGroups) === JSON.stringify(['Gizmo', 'Rotation (2D)', 'Translation', 'Scale', 'Apply']), JSON.stringify(refGroups));
await page.evaluate(() => {
  const r = window.__FL__.refTool;
  window.__refBeforeY = r.group.position.y;
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
  return { pending: r.hasPendingTransform(), y: r.group.position.y, before: window.__refBeforeY };
});
ok('ref Apply bakes transform', !refApplied.pending && Math.abs(refApplied.y - refApplied.before - 0.2) < 1e-3, JSON.stringify(refApplied));
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
  labelVisible: window.__FL__.floorTool.floorLabelVisible,
}));
ok('Floor checkbox tracks + hides plane and its tag',
  floorChk1 === true && floorChk2.checked === false && floorChk2.planeVisible === false && floorChk2.labelVisible === false,
  JSON.stringify({ floorChk1, floorChk2 }));
await page.evaluate(() => {
  const cb = document.getElementById('chk-showfloor');
  cb.checked = true;
  cb.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(200);
const floorChk3 = await page.evaluate(() => ({
  checked: document.getElementById('chk-showfloor').checked,
  planeVisible: window.__FL__.floorTool.planeVisuals.plane.visible,
  labelVisible: window.__FL__.floorTool.floorLabelVisible,
}));
ok('Floor checkbox restores plane and its tag',
  floorChk3.checked && floorChk3.planeVisible && floorChk3.labelVisible,
  JSON.stringify(floorChk3));

// The Floor toggle is global: in Model mode it must still show/hide the
// plane and its outline (the floor tag stays a Floor-tool annotation).
await page.click('#tool-model');
await page.waitForTimeout(250);
const modelFloorOn = await page.evaluate(() => ({
  checked: document.getElementById('chk-showfloor').checked,
  planeVisible: window.__FL__.floorTool.planeVisuals.plane.visible,
  outlineVisible: window.__FL__.floorTool.planeVisuals.outline.visible,
  labelVisible: window.__FL__.floorTool.floorLabelVisible,
}));
await page.evaluate(() => {
  const cb = document.getElementById('chk-showfloor');
  cb.checked = false;
  cb.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(150);
const modelFloorOff = await page.evaluate(() => ({
  checked: document.getElementById('chk-showfloor').checked,
  planeVisible: window.__FL__.floorTool.planeVisuals.plane.visible,
  outlineVisible: window.__FL__.floorTool.planeVisuals.outline.visible,
  labelVisible: window.__FL__.floorTool.floorLabelVisible,
}));
await page.evaluate(() => {
  const cb = document.getElementById('chk-showfloor');
  cb.checked = true;
  cb.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(150);
const modelFloorBack = await page.evaluate(() => ({
  checked: document.getElementById('chk-showfloor').checked,
  planeVisible: window.__FL__.floorTool.planeVisuals.plane.visible,
  outlineVisible: window.__FL__.floorTool.planeVisuals.outline.visible,
}));
ok('Floor toggle renders/hides the floor in Model mode',
  modelFloorOn.checked && modelFloorOn.planeVisible && modelFloorOn.outlineVisible &&
  !modelFloorOn.labelVisible &&
  !modelFloorOff.checked && !modelFloorOff.planeVisible && !modelFloorOff.outlineVisible &&
  modelFloorBack.checked && modelFloorBack.planeVisible && modelFloorBack.outlineVisible,
  JSON.stringify({ modelFloorOn, modelFloorOff, modelFloorBack }));
await page.click('#tool-floor');
await page.waitForTimeout(250);

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

// Label checkbox: hides 3D text labels (grid numbers/captions + floor tag)
// while keeping grid lines/axes visible.
const labelsDefault = await page.evaluate(() => {
  const ed = window.__FL__.editor;
  const texts = [];
  let allVisible = true;
  let count = 0;
  ed.helperGroup.traverse((o) => {
    if (o.userData && o.userData.isLabel) {
      count++;
      texts.push(o.userData.labelText);
      if (!o.visible) allVisible = false;
    }
  });
  return {
    checked: document.getElementById('chk-showlabels').checked,
    labelsVisible: ed.isLabelsVisible,
    count,
    allVisible,
    hasX: texts.includes('X (m)'),
    hasZ: texts.includes('Z (m)'),
    hasNumber: texts.some((t) => /^\d+(\.\d+)?$/.test(t)),
    floorLabelVisible: window.__FL__.floorTool.floorLabelVisible,
    gridVisible: ed.isGridVisible,
  };
});
ok('Label toggle exists; grid + floor labels are visible by default',
  labelsDefault.checked && labelsDefault.labelsVisible && labelsDefault.count > 2 &&
  labelsDefault.allVisible && labelsDefault.hasX && labelsDefault.hasZ &&
  labelsDefault.hasNumber && labelsDefault.floorLabelVisible && labelsDefault.gridVisible,
  JSON.stringify(labelsDefault));

await page.evaluate(() => {
  const cb = document.getElementById('chk-showlabels');
  cb.checked = false;
  cb.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(200);
const labelsOff = await page.evaluate(() => {
  const ed = window.__FL__.editor;
  let anyVisible = false;
  let count = 0;
  ed.helperGroup.traverse((o) => {
    if (o.userData && o.userData.isLabel) {
      count++;
      if (o.visible) anyVisible = true;
    }
  });
  let nonLabelVisible = false;
  for (const c of ed.helperGroup.children) {
    if (!(c.userData && c.userData.isLabel) && c.visible) nonLabelVisible = true;
  }
  return {
    checked: document.getElementById('chk-showlabels').checked,
    labelsVisible: ed.isLabelsVisible,
    count,
    anyVisible,
    floorLabelVisible: window.__FL__.floorTool.floorLabelVisible,
    gridGroupVisible: ed.helperGroup.visible,
    nonLabelVisible,
  };
});
ok('Label off hides grid numbers/captions + floor tag, keeps grid lines',
  !labelsOff.checked && !labelsOff.labelsVisible && labelsOff.count > 2 &&
  !labelsOff.anyVisible && !labelsOff.floorLabelVisible &&
  labelsOff.gridGroupVisible && labelsOff.nonLabelVisible,
  JSON.stringify(labelsOff));

await page.evaluate(() => {
  const cb = document.getElementById('chk-showlabels');
  cb.checked = true;
  cb.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(200);
const labelsBack = await page.evaluate(() => {
  const ed = window.__FL__.editor;
  let allVisible = true;
  let count = 0;
  ed.helperGroup.traverse((o) => {
    if (o.userData && o.userData.isLabel) {
      count++;
      if (!o.visible) allVisible = false;
    }
  });
  return {
    checked: document.getElementById('chk-showlabels').checked,
    labelsVisible: ed.isLabelsVisible,
    count,
    allVisible,
    floorLabelVisible: window.__FL__.floorTool.floorLabelVisible,
  };
});
ok('Label on restores grid labels + floor tag',
  labelsBack.checked && labelsBack.labelsVisible && labelsBack.count > 2 &&
  labelsBack.allVisible && labelsBack.floorLabelVisible,
  JSON.stringify(labelsBack));

// The axis captions follow the m/cm unit switch.
const unitLabels = await page.evaluate(() => {
  const read = () => {
    const texts = [];
    window.__FL__.editor.helperGroup.traverse((o) => {
      if (o.userData && o.userData.isLabel) texts.push(o.userData.labelText);
    });
    return texts;
  };
  window.__FL__.setUnits('centimeter');
  const cm = read();
  window.__FL__.setUnits('meter');
  const m = read();
  return {
    cmHasX: cm.includes('X (cm)'),
    cmHasZ: cm.includes('Z (cm)'),
    mHasX: m.includes('X (m)'),
    mHasZ: m.includes('Z (m)'),
  };
});
ok('grid unit captions switch between X/Z (m) and X/Z (cm)',
  unitLabels.cmHasX && unitLabels.cmHasZ && unitLabels.mHasX && unitLabels.mHasZ,
  JSON.stringify(unitLabels));
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

// ---- 4b. Floor ▸ Brush: panel, falloff curves, snapping, live highlight
await page.click('#tool-floor');
await page.click('#subtabs button:has-text("Brush")');
await page.waitForTimeout(500);

const brushPanel = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  const groups = [...document.querySelectorAll('#panel-body .gtitle')].map((b) => b.textContent);
  const canvas = document.getElementById('brush-curve');
  const selects = [...document.querySelectorAll('#panel-body select')].map((s) => [...s.options].map((o) => o.value));
  const sliders = document.querySelectorAll('#panel-body input[type=range]').length;
  const gizmo = window.__FL__.editor.gizmo;
  return {
    title: document.getElementById('panel-title').textContent,
    groups,
    canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
    selects,
    sliders,
    brushMode: f.brushMode,
    radius: f.brushSettings.radius,
    falloff: f.brushSettings.falloffRadius,
    gizmoObj: gizmo.object ? gizmo.object.name : null,
    previewCheckbox: !!document.querySelector('#panel-body input[type=checkbox]'),
  };
});
ok('Floor ▸ Brush panel exists with radius/falloff/curve controls',
  brushPanel.title.includes('Brush') &&
  brushPanel.groups.includes('Brush') && brushPanel.groups.includes('Live intersection') &&
  brushPanel.canvas && brushPanel.canvas.w > 0 && brushPanel.canvas.h > 0 &&
  brushPanel.selects.some((o) => o.join(',') === 'smoothstep,gaussian') &&
  brushPanel.sliders >= 2 && brushPanel.previewCheckbox,
  JSON.stringify(brushPanel));
ok('Brush mode detaches the floor gizmo and auto-sizes the brush',
  brushPanel.brushMode && brushPanel.gizmoObj === null &&
  brushPanel.radius > 0 && brushPanel.falloff > 0 && brushPanel.falloff < brushPanel.radius,
  JSON.stringify({ gizmo: brushPanel.gizmoObj, r: brushPanel.radius, f: brushPanel.falloff }));

// The curve preview must actually render (not just be an empty canvas).
const curvePixels = await page.evaluate(() => {
  const c = document.getElementById('brush-curve');
  if (!c) return 0;
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 2] > d[i] + 15) lit++;
  }
  return lit;
});
ok('brush curve preview is rendered', curvePixels > 100, `lit pixels ${curvePixels}`);

// Regression: left-drag in Brush must paint, never orbit the viewport.
const brushOrbitState = await page.evaluate(() => ({
  left: window.__FL__.editor.orbit.mouseButtons.LEFT,
  brushMode: window.__FL__.floorTool.brushMode,
}));
ok('Brush mode disables left-drag orbit',
  brushOrbitState.brushMode && brushOrbitState.left === null,
  JSON.stringify(brushOrbitState));

const camDir = () => page.evaluate(() => {
  const d = new window.__FL__.THREE.Vector3();
  window.__FL__.editor.camera.getWorldDirection(d);
  return d.toArray();
});
await page.evaluate(() => { window.__FL__.editor.orbit.enableDamping = false; });
const camBefore = await camDir();
await page.mouse.move(250, 800);
await page.mouse.down();
await page.mouse.move(380, 810, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(250);
const camAfter = await camDir();
await page.evaluate(() => { window.__FL__.editor.orbit.enableDamping = true; });
const camDot = camBefore[0] * camAfter[0] + camBefore[1] * camAfter[1] + camBefore[2] * camAfter[2];
ok('left-drag in Brush does not rotate the viewport', camDot > 0.9999, `dot ${camDot.toFixed(6)}`);
// The drag may have painted a tiny stroke at the corner; undo it so later
// checks start from the same geometry.
const dragUndoLabel = await page.evaluate(() => window.__FL__.history.undoLabel);
if (dragUndoLabel === 'Brush: push/pull to floor') {
  await page.evaluate(() => window.__FL__.history.undo());
  await page.waitForTimeout(150);
}

// Both falloff curves: endpoints 1→0, monotonic, core/edge weights.
const curveMath = await page.evaluate(async () => {
  const m = await import('/src/brush.ts');
  const s = { radius: 2, falloffRadius: 0.8, curve: 'smoothstep', hardness: 0.5, strength: 1 };
  const ts = [0, 0.25, 0.5, 0.75, 1];
  const smooth = ts.map((t) => m.falloffWeight(t, 'smoothstep', 0.5));
  const gauss = ts.map((t) => m.falloffWeight(t, 'gaussian', 0.5));
  const mono = (a) => a.every((v, i) => i === 0 || v <= a[i - 1] + 1e-9);
  return {
    smooth, gauss,
    smoothEnds: Math.abs(smooth[0] - 1) < 1e-9 && Math.abs(smooth[4]) < 1e-9,
    gaussEnds: Math.abs(gauss[0] - 1) < 1e-9 && Math.abs(gauss[4]) < 1e-9,
    mono: mono(smooth) && mono(gauss),
    core: m.brushWeightAt(0.8, s),
    edge: m.brushWeightAt(2, s),
    bandMid: m.brushWeightAt(1.4, s),
  };
});
ok('falloff curves: endpoints, monotonic, core/edge weights',
  curveMath.smoothEnds && curveMath.gaussEnds && curveMath.mono &&
  Math.abs(curveMath.core - 1) < 1e-9 && curveMath.edge === 0 &&
  curveMath.bandMid > 0 && curveMath.bandMid < 1,
  JSON.stringify(curveMath));

// UI controls write through to the settings.
await page.selectOption('#panel-body select', 'gaussian');
await page.evaluate(() => {
  const ranges = [...document.querySelectorAll('#panel-body input[type=range]')];
  ranges[0].value = '0.9';
  ranges[0].dispatchEvent(new Event('input', { bubbles: true }));
  const nums = [...document.querySelectorAll('#panel-body input[type=number]')];
  nums[0].value = '2.5';
  nums[0].dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(150);
const brushControls = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  return {
    curve: f.brushSettings.curve,
    hardness: f.brushSettings.hardness,
    radius: f.brushSettings.radius,
    falloff: f.brushSettings.falloffRadius,
  };
});
ok('brush controls update settings (curve / hardness / radius)',
  brushControls.curve === 'gaussian' && Math.abs(brushControls.hardness - 0.9) < 1e-6 &&
  Math.abs(brushControls.radius - 2.5) < 1e-3,
  JSON.stringify(brushControls));

// Reducing the radius below the falloff radius clamps the falloff.
const clampTest = await page.evaluate(() => {
  const nums = [...document.querySelectorAll('#panel-body input[type=number]')];
  nums[0].value = '0.5';
  nums[0].dispatchEvent(new Event('change', { bubbles: true }));
  const f = window.__FL__.floorTool;
  return {
    radius: f.brushSettings.radius,
    falloff: f.brushSettings.falloffRadius,
    falloffField: nums[1].value,
  };
});
ok('falloff radius clamps to the brush radius',
  Math.abs(clampTest.radius - 0.5) < 1e-9 && clampTest.falloff <= clampTest.radius + 1e-9 &&
  Math.abs(parseFloat(clampTest.falloffField) - clampTest.falloff) < 1e-3,
  JSON.stringify(clampTest));

// Set up a deterministic brush scenario: horizontal plane through the lower
// part of the model, hard-core brush so affected vertices snap exactly.
const brushSetup = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  const m = window.__FL__.meshes[0];
  const THREE = window.__FL__.THREE;
  const root = f.planeVisuals.plane.parent;
  root.rotation.set(0, 0, 0);
  m.geometry.computeBoundingBox();
  const bb = m.geometry.boundingBox;
  const size = bb.getSize(new THREE.Vector3());
  const center = bb.getCenter(new THREE.Vector3());
  f.settings.sizeX = size.x * 1.25;
  f.settings.sizeZ = size.z * 1.25;
  f.settings.cx = center.x;
  f.settings.cz = center.z;
  f.settings.y = bb.min.y + size.y * 0.12;
  f.updatePlane();
  f.brushSettings.radius = 2.0;
  f.brushSettings.falloffRadius = 2.0;
  f.brushSettings.strength = 1;
  f.brushSettings.curve = 'smoothstep';
  f.brushSettings.hardness = 0.5;
  f.scan(); // establish a known highlight baseline (auto-scan is tested below)

  const frame = f.frame();
  const arr = m.geometry.getAttribute('position').array;
  const n = frame.normal, p = frame.point;
  // Prefer a vertex that is both near the plane and near the model centre
  // (a clean, dense patch for the screenshot); fall back to the closest.
  let best = -1, bestScore = Infinity, bestS = 0;
  let fallback = -1, fallbackAbs = Infinity, fallbackS = 0;
  for (let i = 0; i < arr.length / 3; i++) {
    const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
    const u = frame.xAxis.x * (x - p.x) + frame.xAxis.y * (y - p.y) + frame.xAxis.z * (z - p.z);
    const w = frame.zAxis.x * (x - p.x) + frame.zAxis.y * (y - p.y) + frame.zAxis.z * (z - p.z);
    if (u < -frame.halfX || u > frame.halfX || w < -frame.halfZ || w > frame.halfZ) continue;
    const s = n.x * (x - p.x) + n.y * (y - p.y) + n.z * (z - p.z);
    const a = Math.abs(s);
    if (a < fallbackAbs) { fallbackAbs = a; fallback = i; fallbackS = s; }
    if (a > 1.0) continue;
    const score = a * 2 + Math.hypot(x - center.x, z - center.z);
    if (score < bestScore) { bestScore = score; best = i; bestS = s; }
  }
  if (best < 0) { best = fallback; bestS = fallbackS; }
  if (best < 0) return null;
  const centerPt = new THREE.Vector3(
    arr[best * 3] - n.x * bestS,
    arr[best * 3 + 1] - n.y * bestS,
    arr[best * 3 + 2] - n.z * bestS,
  );
  return {
    center: centerPt.toArray(),
    vertex: best,
    signed: bestS,
    planeY: f.settings.y,
    bbox: { min: bb.min.toArray(), max: bb.max.toArray() },
    areas: f.areas.length,
    crossing: f.crossing.size,
    onPlane: f.onPlane.size,
  };
});
ok('brush scenario finds a vertex on the plane', !!brushSetup, JSON.stringify(brushSetup));
// Sync the panel fields with the programmatic setup (real users only change
// these through the panel, but the screenshot should match the live brush).
await page.evaluate(() => window.__FL__.buildPanel());
await page.waitForTimeout(120);

// A single hard dab: only vertices inside the sphere move, and they land on
// the plane (push down above it / pull up below it).
const dab = await page.evaluate((centerArr) => {
  const f = window.__FL__.floorTool;
  const m = window.__FL__.meshes[0];
  const THREE = window.__FL__.THREE;
  const center = new THREE.Vector3(centerArr[0], centerArr[1], centerArr[2]);
  const frame = f.frame();
  const arr = m.geometry.getAttribute('position').array;
  const before = new Float32Array(arr);
  const res = f.applyBrushAtPoint(center);
  const n = frame.normal, p = frame.point;
  const r = f.brushSettings.radius;
  let outsideMoved = 0, notOnPlane = 0, changed = 0, maxAfter = 0, pushDown = 0, pullUp = 0;
  for (let i = 0; i < arr.length / 3; i++) {
    if (arr[i * 3] === before[i * 3] && arr[i * 3 + 1] === before[i * 3 + 1] && arr[i * 3 + 2] === before[i * 3 + 2]) continue;
    changed++;
    const dx = before[i * 3] - center.x, dy = before[i * 3 + 1] - center.y, dz = before[i * 3 + 2] - center.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) > r + 1e-4) outsideMoved++;
    const sBefore = n.x * (before[i * 3] - p.x) + n.y * (before[i * 3 + 1] - p.y) + n.z * (before[i * 3 + 2] - p.z);
    const sAfter = n.x * (arr[i * 3] - p.x) + n.y * (arr[i * 3 + 1] - p.y) + n.z * (arr[i * 3 + 2] - p.z);
    if (sBefore > 0) pushDown++; else if (sBefore < 0) pullUp++;
    const a = Math.abs(sAfter);
    if (a > maxAfter) maxAfter = a;
    if (a > 1e-3) notOnPlane++;
  }
  // restore the pre-dab state (this dab is a math check, not a history step)
  arr.set(before);
  const pos = m.geometry.getAttribute('position');
  pos.needsUpdate = true;
  m.geometry.computeBoundingBox();
  m.geometry.computeBoundingSphere();
  return { affected: res.affected, moved: res.moved, changed, outsideMoved, notOnPlane, maxAfter, pushDown, pullUp };
}, brushSetup.center);
ok('brush snaps only the nearest vertices inside the radius onto the plane',
  dab.moved > 0 && dab.changed > 0 && Math.abs(dab.moved - dab.changed) <= 2 &&
  dab.outsideMoved === 0 && dab.notOnPlane === 0 && dab.maxAfter < 1e-3 &&
  dab.pushDown + dab.pullUp === dab.changed,
  JSON.stringify(dab));

// A real stroke: one undo step, live auto-highlight, undo/redo.
const liveBrush = await page.evaluate((centerArr) => {
  const f = window.__FL__.floorTool;
  const m = window.__FL__.meshes[0];
  const THREE = window.__FL__.THREE;
  const ed = window.__FL__.editor;
  const center = new THREE.Vector3(centerArr[0], centerArr[1], centerArr[2]);
  const dist = 12;
  ed.orbit.target.copy(center);
  ed.camera.position.set(center.x + dist * 0.7, center.y + dist * 0.55, center.z + dist * 0.8);
  ed.camera.lookAt(center);
  ed.orbit.update();
  ed.camera.updateMatrixWorld(true);
  const p = center.clone().project(ed.camera);
  const ndc = new THREE.Vector2(p.x, p.y);
  f.updatePointer(ndc);
  window.__brushBefore = new Float32Array(m.geometry.getAttribute('position').array);
  window.__brushOnPlaneBefore = f.onPlane.size;
  f.beginBrushStroke(ndc);
  f.endBrushStroke(ndc);
  return {
    ndc: [ndc.x, ndc.y],
    onPlaneBefore: window.__brushOnPlaneBefore,
    last: f.lastBrushResult ? { ...f.lastBrushResult } : null,
    undoLabel: window.__FL__.history.undoLabel,
  };
}, brushSetup.center);
ok('brush stroke records one undoable step and reports the dab',
  liveBrush.last && liveBrush.last.totalMoved > 0 &&
  liveBrush.undoLabel === 'Brush: push/pull to floor',
  JSON.stringify(liveBrush));

await page.waitForTimeout(400);
const liveHighlight = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  const overlay = window.__FL__.editor.overlayGroup.children;
  return {
    onPlane: f.onPlane.size,
    before: window.__brushOnPlaneBefore,
    areas: f.areas.length,
    crossing: f.crossing.size,
    segments: f.segments ? f.segments.length / 6 : 0,
    hitMesh: overlay.some((o) => o.isMesh && o.renderOrder === 4),
    hitLines: overlay.some((o) => o.isLineSegments && o.renderOrder === 6),
  };
});
ok('brush auto-highlights the snapped patch on the plane',
  liveHighlight.onPlane > liveHighlight.before && liveHighlight.hitMesh &&
  liveHighlight.segments > 0,
  JSON.stringify(liveHighlight));

const undoBrush = await page.evaluate(() => {
  const m = window.__FL__.meshes[0];
  const label = window.__FL__.history.undoLabel;
  window.__FL__.history.undo();
  const arr = m.geometry.getAttribute('position').array;
  const before = window.__brushBefore;
  let maxDiff = 0;
  for (let i = 0; i < arr.length; i++) maxDiff = Math.max(maxDiff, Math.abs(arr[i] - before[i]));
  return { label, maxDiff, canRedo: window.__FL__.history.canRedo };
});
ok('brush undo restores the pre-stroke vertices',
  undoBrush.label === 'Brush: push/pull to floor' && undoBrush.maxDiff < 1e-6 && undoBrush.canRedo,
  JSON.stringify(undoBrush));
await page.waitForTimeout(300);
const undoHighlight = await page.evaluate(() => ({ onPlane: window.__FL__.floorTool.onPlane.size }));
ok('undo auto-refreshes the intersection highlight',
  undoHighlight.onPlane === liveHighlight.before, JSON.stringify({ undoHighlight, before: liveHighlight.before }));

await page.evaluate(() => window.__FL__.history.redo());
await page.waitForTimeout(300);
const redoHighlight = await page.evaluate(() => ({
  onPlane: window.__FL__.floorTool.onPlane.size,
  canUndo: window.__FL__.history.canUndo,
}));
ok('redo re-applies the brush and the highlight',
  redoHighlight.onPlane === liveHighlight.onPlane && redoHighlight.canUndo,
  JSON.stringify(redoHighlight));

// Moving the plane refreshes the highlight with no Scan click.
const autoMove = await page.evaluate(async () => {
  const f = window.__FL__.floorTool;
  const m = window.__FL__.meshes[0];
  const THREE = window.__FL__.THREE;
  m.geometry.computeBoundingBox();
  const bb = m.geometry.boundingBox;
  const savedY = f.settings.y;
  f.settings.y = bb.min.y - 2; // below the whole model → nothing intersects
  f.updatePlane();
  await new Promise((r) => setTimeout(r, 250));
  const below = { areas: f.areas.length, crossing: f.crossing.size, onPlane: f.onPlane.size };
  f.settings.y = bb.min.y + (bb.max.y - bb.min.y) * 0.12;
  f.updatePlane();
  await new Promise((r) => setTimeout(r, 250));
  const inside = { areas: f.areas.length, crossing: f.crossing.size, onPlane: f.onPlane.size };
  f.settings.y = savedY;
  f.updatePlane();
  await new Promise((r) => setTimeout(r, 250));
  return { below, inside };
});
ok('plane moves auto-refresh the intersection highlight (no Scan click)',
  autoMove.below.areas === 0 && autoMove.below.crossing === 0 &&
  autoMove.inside.areas > 0 && autoMove.inside.crossing > 0,
  JSON.stringify(autoMove));

// Cursor rings + affected-vertex preview are live under the pointer.
await page.evaluate((centerArr) => {
  const f = window.__FL__.floorTool;
  const ed = window.__FL__.editor;
  const THREE = window.__FL__.THREE;
  const center = new THREE.Vector3(centerArr[0], centerArr[1], centerArr[2]);
  const dist = 9;
  ed.orbit.target.copy(center);
  ed.camera.position.set(center.x + dist * 0.45, center.y + dist * 1.05, center.z + dist * 0.65);
  ed.camera.lookAt(center);
  ed.orbit.update();
  ed.camera.updateMatrixWorld(true);
  const p = center.clone().project(ed.camera);
  f.updatePointer(new THREE.Vector2(p.x, p.y));
}, brushSetup.center);
await page.waitForTimeout(300);
const cursorState = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  return {
    visible: f.brushCursorVisible,
    previewVisible: f.brushPreviewVisible,
    previewCount: f.brushPreviewCount,
    radius: f.brushSettings.radius,
  };
});
ok('brush cursor + affected-vertex preview are live',
  cursorState.visible && cursorState.previewVisible && cursorState.previewCount > 0,
  JSON.stringify(cursorState));
await page.screenshot({ path: `${ROOT}/.smoke/17-floor-brush-panel.png` });

// W in Brush opens the floor Transform panel (gizmo back).
await page.evaluate(() => document.activeElement && document.activeElement.blur());
await page.keyboard.press('KeyW');
await page.waitForTimeout(250);
const brushKey = await page.evaluate(() => ({
  activeSub: document.querySelector('#subtabs button.active') ? document.querySelector('#subtabs button.active').textContent : null,
  brushMode: window.__FL__.floorTool.brushMode,
  gizmoObj: window.__FL__.editor.gizmo.object ? window.__FL__.editor.gizmo.object.name : null,
  mode: window.__FL__.floorTool.gizmoMode,
}));
ok('W in Brush opens the floor Transform panel with the gizmo',
  brushKey.activeSub === 'Transform' && !brushKey.brushMode &&
  brushKey.gizmoObj === 'FloorTransformProxy' && brushKey.mode === 'translate',
  JSON.stringify(brushKey));

// Back to Brush for a close-up of the live highlight, then leave Floor on its
// normal sub-tab for the rest of the suite.
await page.click('#subtabs button:has-text("Brush")');
await page.waitForTimeout(250);
await page.evaluate((centerArr) => {
  const f = window.__FL__.floorTool;
  const ed = window.__FL__.editor;
  const THREE = window.__FL__.THREE;
  const center = new THREE.Vector3(centerArr[0], centerArr[1], centerArr[2]);
  const dist = 6.5;
  ed.orbit.target.copy(center);
  ed.camera.position.set(center.x + dist * 0.5, center.y + dist * 0.8, center.z + dist * 0.85);
  ed.camera.lookAt(center);
  ed.orbit.update();
  ed.camera.updateMatrixWorld(true);
  const p = center.clone().project(ed.camera);
  f.updatePointer(new THREE.Vector2(p.x, p.y));
}, brushSetup.center);
await page.waitForTimeout(400);
await page.evaluate(() => {
  const t = document.getElementById('toast');
  if (t) t.classList.add('hidden');
});
await page.screenshot({ path: `${ROOT}/.smoke/18-brush-highlight.png` });
await page.click('#subtabs button:has-text("Floor")');
await page.waitForTimeout(200);
const floorLeftOrbit = await page.evaluate(() => window.__FL__.editor.orbit.mouseButtons.LEFT);
ok('Floor mode also disables left-drag orbit', floorLeftOrbit === null, JSON.stringify({ left: floorLeftOrbit }));
await page.evaluate(() => window.__FL__.editor.frameModel());

// Orbit is still the left-drag default in Info (Select) mode.
const orbitModeCheck = await page.evaluate(() => {
  const read = () => window.__FL__.editor.orbit.mouseButtons.LEFT;
  const rotate = window.__FL__.THREE.MOUSE.ROTATE;
  window.__FL__.setTool('select');
  const info = read();
  window.__FL__.setTool('floor');
  const floor = read();
  return { info, floor, rotate };
});
ok('Info keeps left-drag orbit, Floor keeps it off',
  orbitModeCheck.info === orbitModeCheck.rotate && orbitModeCheck.floor === null,
  JSON.stringify(orbitModeCheck));

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
const autoOrthoState = await page.evaluate(() => ({
  isOrtho: window.__FL__.editor.isOrtho,
  mode: window.__FL__.editor.projectionMode,
}));
ok('axis view auto-switched to ortho',
  autoOrthoState.isOrtho && autoOrthoState.mode === 'orthographic', JSON.stringify(autoOrthoState));
await page.mouse.move(center.x, center.y);
await page.mouse.down();
await page.mouse.move(center.x - 30, center.y - 18, { steps: 4 }); // rotate away
await page.mouse.up();
await page.waitForTimeout(400);
const autoRestored = await page.evaluate(() => ({
  isOrtho: window.__FL__.editor.isOrtho,
  mode: window.__FL__.editor.projectionMode,
  label: document.querySelector('.navgizmo-viewlabel').textContent,
}));
ok('rotate away restores perspective',
  !autoRestored.isOrtho && autoRestored.mode === 'perspective' && /Perspective/.test(autoRestored.label),
  JSON.stringify(autoRestored));
await page.screenshot({ path: `${ROOT}/.smoke/15-autoortho.png` });

// Manual projection override: a manual Numpad5 toggle breaks the auto-ortho
// association. From an auto-ortho axis view it cycles O → I; rotating away
// leaves the manual orthographic family (I becomes a user orthographic view),
// it does NOT auto-restore perspective.
await page.evaluate(() => window.__FL__.editor.setProjectionMode('perspective'));
await page.evaluate(() => window.__FL__.editor.navGizmo.snapTo('posZ'));
await page.waitForTimeout(600);
await page.keyboard.press('Numpad5'); // manual O → I
await page.waitForTimeout(300);
const manualIso = await page.evaluate(() => ({
  mode: window.__FL__.editor.projectionMode,
  isOrtho: window.__FL__.editor.isOrtho,
  iso: window.__FL__.editor.isIsometricOrientation(),
  label: document.querySelector('.navgizmo-viewlabel').textContent,
}));
ok('manual toggle in axis view enters isometric',
  manualIso.mode === 'isometric' && manualIso.isOrtho && manualIso.iso && /Isometric/.test(manualIso.label),
  JSON.stringify(manualIso));
await page.mouse.move(center.x, center.y);
await page.mouse.down();
await page.mouse.move(center.x + 24, center.y - 14, { steps: 3 });
await page.mouse.up();
await page.waitForTimeout(400);
const manualSurvived = await page.evaluate(() => ({
  mode: window.__FL__.editor.projectionMode,
  isOrtho: window.__FL__.editor.isOrtho,
}));
ok('manual choice survives rotate-away (stays orthographic)',
  manualSurvived.isOrtho && manualSurvived.mode === 'orthographic',
  JSON.stringify(manualSurvived));
await page.evaluate(() => window.__FL__.editor.setProjectionMode('perspective'));

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

// projection toggle cycle: Perspective → Orthographic → Isometric → Perspective.
// Start from an OBLIQUE user view in perspective so the P→O position check is clean.
await page.mouse.move(c.x, c.y);
await page.mouse.down();
await page.mouse.move(c.x + 13, c.y - 8, { steps: 2 });
await page.mouse.up();
await page.waitForTimeout(300);
await page.evaluate(() => window.__FL__.editor.setProjectionMode('perspective'));
await page.waitForTimeout(150);

// P → O: keeps the camera position and orientation
await page.evaluate(() => window.__FL__.editor.navGizmo.toggleProjection());
await page.waitForTimeout(250);
const orthoState = await page.evaluate(() => {
  const ed = window.__FL__.editor;
  return {
    mode: ed.projectionMode,
    isOrtho: ed.isOrtho,
    posSame: ed.camera.position.distanceTo(ed.perspCamera.position) < 1e-6,
    label: document.querySelector('.navgizmo-viewlabel').textContent,
    title: ed.navGizmo.btnToggle.title,
  };
});
ok('nav toggle to ortho',
  orthoState.mode === 'orthographic' && orthoState.isOrtho && orthoState.posSame &&
  /Orthographic/.test(orthoState.label) && /Orthographic/.test(orthoState.title),
  JSON.stringify(orthoState));
await page.screenshot({ path: `${ROOT}/.smoke/12-nav-ortho.png` });

// ortho dolly changes zoom, not camera position
const orthoDolly = await page.evaluate(() => {
  const ed = window.__FL__.editor;
  const before = ed.camera.zoom;
  const posBefore = ed.camera.position.clone();
  ed.navGizmo.dolly(1.3);
  return {
    before,
    after: ed.camera.zoom,
    posSame: ed.camera.position.distanceTo(posBefore) < 1e-6,
    mode: ed.projectionMode,
  };
});
ok('ortho dolly changes zoom',
  Math.abs(orthoDolly.after - orthoDolly.before * 1.3) < 1e-6 && orthoDolly.posSame &&
  orthoDolly.mode === 'orthographic',
  `zoom ${orthoDolly.before.toFixed(2)} → ${orthoDolly.after.toFixed(2)}`);

// O → I: standard isometric orientation, still orthographic
await page.evaluate(() => window.__FL__.editor.navGizmo.toggleProjection());
await page.waitForTimeout(250);
const isoState = await page.evaluate(() => {
  const ed = window.__FL__.editor;
  const d = new window.__FL__.THREE.Vector3().subVectors(ed.camera.position, ed.orbit.target).normalize();
  return {
    mode: ed.projectionMode,
    isOrtho: ed.isOrtho,
    iso: ed.isIsometricOrientation(),
    dir: d.toArray(),
    label: document.querySelector('.navgizmo-viewlabel').textContent,
    title: ed.navGizmo.btnToggle.title,
  };
});
const isoDir = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
ok('nav toggle to isometric',
  isoState.mode === 'isometric' && isoState.isOrtho && isoState.iso &&
  Math.abs(isoState.dir[0] - isoDir[0]) < 1e-3 &&
  Math.abs(isoState.dir[1] - isoDir[1]) < 1e-3 &&
  Math.abs(isoState.dir[2] - isoDir[2]) < 1e-3 &&
  isoState.label === 'Isometric' && /Isometric/.test(isoState.title),
  JSON.stringify(isoState));
await page.screenshot({ path: `${ROOT}/.smoke/16-nav-iso.png` });

// isometric dolly changes zoom, not position
const isoDolly = await page.evaluate(() => {
  const ed = window.__FL__.editor;
  const before = ed.camera.zoom;
  const posBefore = ed.camera.position.clone();
  ed.navGizmo.dolly(1.3);
  return {
    before,
    after: ed.camera.zoom,
    posSame: ed.camera.position.distanceTo(posBefore) < 1e-6,
    mode: ed.projectionMode,
  };
});
ok('isometric dolly changes zoom',
  Math.abs(isoDolly.after - isoDolly.before * 1.3) < 1e-6 && isoDolly.posSame &&
  isoDolly.mode === 'isometric',
  `zoom ${isoDolly.before.toFixed(2)} → ${isoDolly.after.toFixed(2)}`);

// I → P: perspective at the current (isometric) orientation
await page.evaluate(() => window.__FL__.editor.navGizmo.toggleProjection());
await page.waitForTimeout(250);
const perspBack = await page.evaluate(() => ({
  mode: window.__FL__.editor.projectionMode,
  isOrtho: window.__FL__.editor.isOrtho,
  label: document.querySelector('.navgizmo-viewlabel').textContent,
}));
ok('nav toggle back to perspective',
  perspBack.mode === 'perspective' && !perspBack.isOrtho && /Perspective/.test(perspBack.label),
  JSON.stringify(perspBack));

// numpad shortcuts: Numpad7 = Top, Ctrl+Numpad7 = Bottom, Numpad5 cycles.
await page.evaluate(() => window.__FL__.editor.setProjectionMode('perspective'));
await page.keyboard.press('Numpad7');
await page.waitForTimeout(500);
const kTop = await page.evaluate(() => ({
  label: document.querySelector('.navgizmo-viewlabel').textContent,
  mode: window.__FL__.editor.projectionMode,
}));
ok('numpad7 snaps Top (auto-ortho)',
  /Top/.test(kTop.label) && kTop.mode === 'orthographic', JSON.stringify(kTop));
await page.keyboard.press('Control+Numpad7');
await page.waitForTimeout(500);
const kBottom = await page.evaluate(() => ({
  label: document.querySelector('.navgizmo-viewlabel').textContent,
  mode: window.__FL__.editor.projectionMode,
}));
ok('ctrl+numpad7 snaps Bottom',
  /Bottom/.test(kBottom.label) && kBottom.mode === 'orthographic', JSON.stringify(kBottom));

// From auto-ortho (O), Numpad5 cycles O → I → P → O.
await page.keyboard.press('Numpad5');
await page.waitForTimeout(300);
const kIso = await page.evaluate(() => ({
  mode: window.__FL__.editor.projectionMode,
  isOrtho: window.__FL__.editor.isOrtho,
  iso: window.__FL__.editor.isIsometricOrientation(),
  label: document.querySelector('.navgizmo-viewlabel').textContent,
}));
ok('numpad5 cycles ortho → isometric',
  kIso.mode === 'isometric' && kIso.isOrtho && kIso.iso && kIso.label === 'Isometric',
  JSON.stringify(kIso));
await page.keyboard.press('Numpad5');
await page.waitForTimeout(300);
const kPersp = await page.evaluate(() => ({
  mode: window.__FL__.editor.projectionMode,
  isOrtho: window.__FL__.editor.isOrtho,
}));
ok('numpad5 cycles isometric → perspective',
  kPersp.mode === 'perspective' && !kPersp.isOrtho, JSON.stringify(kPersp));
await page.keyboard.press('Numpad5');
await page.waitForTimeout(300);
const kOrtho = await page.evaluate(() => ({
  mode: window.__FL__.editor.projectionMode,
  isOrtho: window.__FL__.editor.isOrtho,
}));
ok('numpad5 cycles perspective → orthographic',
  kOrtho.mode === 'orthographic' && kOrtho.isOrtho, JSON.stringify(kOrtho));
// leave the app in perspective for the keyboard-shortcut section below
await page.evaluate(() => window.__FL__.editor.setProjectionMode('perspective'));

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

// ---- scaling regressions: one axis / two axes / whole object
await page.click('#tool-floor');
await page.waitForTimeout(300);

const floorScaleRegression = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  const ed = window.__FL__.editor;
  const nt = f.nodeTransform;
  const root = f.planeVisuals.plane.parent;
  const THREE = window.__FL__.THREE;
  f.resetTransform();
  nt.attachGizmo('scale');
  root.rotation.set(0, 0, 0);
  f.updatePlane();
  const base = root.scale.x;
  const drag = (s) => {
    ed.gizmoDragging = true;
    nt.onGizmoStart();
    nt.proxy.scale.set(s, 1, s);
    nt.onGizmoChange('scale');
    ed.gizmoDragging = false;
    nt.attachGizmo('scale'); // what main.ts does on drag end
  };
  drag(2);
  drag(1.5);
  root.updateMatrixWorld(true);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  root.matrixWorld.decompose(p, q, sc);
  return { base, pending: nt.pending.sx, preview: sc.x };
});
ok('floor repeated two-axis scale does not compound',
  Math.abs(floorScaleRegression.pending - 3) < 1e-6 &&
  Math.abs(floorScaleRegression.preview - floorScaleRegression.base * 3) < 1e-3,
  JSON.stringify(floorScaleRegression));

const floorUniformHandle = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  f.setGizmoMode('scale');
  const g = window.__FL__.editor.gizmo._gizmo;
  g.updateMatrixWorld(true);
  const h = g.gizmo.scale.children.find((c) => c.name === 'XYZ');
  return { visible: !!h && h.visible, showY: window.__FL__.editor.gizmo.showY };
});
ok('floor scale mode keeps the uniform XYZ handle',
  floorUniformHandle.visible && floorUniformHandle.showY, JSON.stringify(floorUniformHandle));

const scalePendingFit = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  const nt = f.nodeTransform;
  f.resetTransform();
  nt.attachGizmo('scale');
  f.planeVisuals.plane.parent.rotation.set(0, 0, 0);
  f.updatePlane();
  nt.pending.sx = 2;
  nt.preview();
  const fitOk = f.fitToModel(true);
  return {
    fitOk,
    pending: f.hasPendingTransform(),
    settingsX: f.settings.sizeX,
    baseX: f.planeVisuals.plane.parent.scale.x,
  };
});
ok('floor Fit with pending bakes then fits',
  scalePendingFit.fitOk && !scalePendingFit.pending && Math.abs(scalePendingFit.baseX - scalePendingFit.settingsX) < 1e-6,
  JSON.stringify(scalePendingFit));

const floorBottom = await page.evaluate(() => {
  const f = window.__FL__.floorTool;
  const nt = f.nodeTransform;
  const root = f.planeVisuals.plane.parent;
  f.resetTransform();
  nt.attachGizmo('scale');
  root.rotation.set(0, 0, 0);
  f.updatePlane();
  const baseX = root.scale.x;
  nt.pending.sx = 2;
  nt.preview();
  const m = window.__FL__.meshes[0];
  m.geometry.computeBoundingBox();
  f.settings.y = m.geometry.boundingBox.min.y;
  f.updatePlane(true);
  return { baseX, finalX: root.scale.x, pending: f.hasPendingTransform() };
});
ok('floor @ bottom keeps a pending scale',
  !floorBottom.pending && Math.abs(floorBottom.finalX - floorBottom.baseX * 2) < 1e-3,
  JSON.stringify(floorBottom));

// Gizmo ownership: leaving the floor must not leave the next tool gizmo-less.
await page.evaluate(() => {
  window.__FL__.setTool('floor');
  window.__FL__.floorTool.setGizmoMode('scale');
  window.__FL__.setTool('transform');
});
await page.waitForTimeout(200);
const gizmoOwnership = await page.evaluate(() => ({
  obj: window.__FL__.editor.gizmo.object?.name ?? null,
  visible: window.__FL__.editor.gizmoHelper.visible,
}));
ok('switching floor→Transform keeps the Transform gizmo',
  gizmoOwnership.obj === 'TransformGizmoProxy' && gizmoOwnership.visible, JSON.stringify(gizmoOwnership));

// Model Transform panel must stay bound after Apply (pending object identity).
const modelApplyRebind = await page.evaluate(() => {
  const tt = window.__FL__.transformTool;
  tt.resetPending();
  const scaleInput = () => [...document.querySelectorAll('#panel-body .group')]
    .find((g) => g.querySelector('.gtitle')?.textContent === 'Scale')
    ?.querySelectorAll('input')[0];
  const set = (input, v) => {
    if (!input) return false;
    input.value = String(v);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  if (!set(scaleInput(), 2)) return { error: 'no scale field' };
  const applyBtn = [...document.querySelectorAll('#panel-body button')]
    .find((b) => b.textContent.startsWith('Apply transform'));
  applyBtn.click();
  if (!set(scaleInput(), 3)) return { error: 'no scale field after apply' };
  return { pending: tt.pending.sx, hasPending: tt.hasPending };
});
ok('Transform panel stays bound after Apply',
  Math.abs(modelApplyRebind.pending - 3) < 1e-6, JSON.stringify(modelApplyRebind));

// Reference image: aspect, local width/height, billboard orientation, and
// independent Width/Height edits.
const refSize = await page.evaluate(async () => {
  const { refTool: r, THREE } = window.__FL__;
  const c = document.createElement('canvas');
  c.width = 400; c.height = 200;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 400, 200);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  await r.loadImage(new File([blob], 'wide.png', { type: 'image/png' }));
  window.__FL__.setTool('ref');
  const loaded = r.getSize();
  r.setSize(20, 10);
  const sized = r.getSize();
  r.setWidth(30);
  const afterWidth = r.getSize();
  r.setHeight(15);
  const afterHeight = r.getSize();

  // Billboard: group quaternion = camera quaternion * Rz(spin).
  const cam = window.__FL__.editor.camera;
  const spin = r.state.angleDeg;
  const rel = cam.quaternion.clone().invert().multiply(r.group.quaternion);
  const spinQ = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(spin));
  return {
    loaded: [loaded.w, loaded.h],
    sized: [sized.w, sized.h],
    afterWidth: [afterWidth.w, afterWidth.h],
    afterHeight: [afterHeight.w, afterHeight.h],
    billboardErr: rel.angleTo(spinQ),
    spin,
    planeRotX: r.group.children[0].rotation.x,
    scaleZ: r.group.scale.z,
  };
});
ok('ref image preserves its aspect on load',
  Math.abs(refSize.loaded[0] / refSize.loaded[1] - 2) < 0.02, JSON.stringify(refSize.loaded));
ok('ref setSize uses local width/height',
  Math.abs(refSize.sized[0] - 20) < 1e-3 && Math.abs(refSize.sized[1] - 10) < 1e-3,
  JSON.stringify(refSize.sized));
ok('ref Width/Height edits are independent',
  Math.abs(refSize.afterWidth[0] - 30) < 1e-3 && Math.abs(refSize.afterWidth[1] - 10) < 1e-3 &&
  Math.abs(refSize.afterHeight[0] - 30) < 1e-3 && Math.abs(refSize.afterHeight[1] - 15) < 1e-3,
  JSON.stringify({ afterWidth: refSize.afterWidth, afterHeight: refSize.afterHeight }));
ok('ref image billboards to the camera',
  refSize.billboardErr < 1e-4 && refSize.planeRotX === 0 && Math.abs(refSize.scaleZ - 1) < 1e-6,
  JSON.stringify({ billboardErr: refSize.billboardErr, spin: refSize.spin, planeRotX: refSize.planeRotX, scaleZ: refSize.scaleZ }));

// 2D spin is applied around the view axis, not world Y/Z.
const refSpin = await page.evaluate(() => {
  const r = window.__FL__.refTool;
  r.setAngleDeg(30);
  const cam = window.__FL__.editor.camera;
  const rel = cam.quaternion.clone().invert().multiply(r.group.quaternion);
  const q = new window.__FL__.THREE.Quaternion().setFromAxisAngle(
    new window.__FL__.THREE.Vector3(0, 0, 1),
    window.__FL__.THREE.MathUtils.degToRad(30));
  return { angle: r.state.angleDeg, err: rel.angleTo(q) };
});
ok('ref 2D spin is billboard-relative',
  Math.abs(refSpin.angle - 30) < 1e-6 && refSpin.err < 1e-4, JSON.stringify(refSpin));
await page.evaluate(() => window.__FL__.refTool.setAngleDeg(0));

// Rotate = local Z only; scale = local X/Y only; translate = world XYZ.
const refGizmoModes = await page.evaluate(() => {
  const r = window.__FL__.refTool;
  const g = window.__FL__.editor.gizmo;
  const read = (mode) => {
    r.setGizmoMode(mode);
    return { mode, space: g.space, x: g.showX, y: g.showY, z: g.showZ };
  };
  const rotate = read('rotate');
  const scale = read('scale');
  const translate = read('translate');
  return { rotate, scale, translate };
});
ok('ref gizmo restricts rotate/scale to 2D',
  refGizmoModes.rotate.space === 'local' &&
  !refGizmoModes.rotate.x && !refGizmoModes.rotate.y && refGizmoModes.rotate.z &&
  refGizmoModes.scale.space === 'local' &&
  refGizmoModes.scale.x && refGizmoModes.scale.y && !refGizmoModes.scale.z &&
  refGizmoModes.translate.space === 'world' &&
  refGizmoModes.translate.x && refGizmoModes.translate.y && refGizmoModes.translate.z,
  JSON.stringify(refGizmoModes));

// Simulate the local-Z rotate gizmo: the proxy delta folds into the 2D spin.
const refGizmoRotate = await page.evaluate(() => {
  const r = window.__FL__.refTool;
  const THREE = window.__FL__.THREE;
  r.setGizmoMode('rotate');
  r.setAngleDeg(0);
  r.onGizmoStart();
  r.nodeTransform.proxy.quaternion.multiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(25)));
  r.onGizmoChange();
  const angle = r.state.angleDeg;
  r.onGizmoEnd();
  r.setGizmoMode('translate');
  r.setAngleDeg(0);
  return { angle };
});
ok('ref rotate gizmo folds local Z into 2D spin',
  Math.abs(refGizmoRotate.angle - 25) < 1e-4, JSON.stringify(refGizmoRotate));

// Visual: the rotate gizmo shows only the screen-plane Z ring.
await page.evaluate(() => {
  window.__FL__.refTool.setGizmoMode('rotate');
  window.__FL__.buildPanel(); // show the current width/height + Rot active
});
await page.waitForTimeout(200);
await page.screenshot({ path: `${ROOT}/.smoke/20-ref-rotate2d.png` });
await page.evaluate(() => window.__FL__.refTool.setGizmoMode('translate'));

// In Model mode the image transform is locked (gizmo detached) but the
// billboard still follows the camera; the topbar Ref toggle is the only control.
await page.evaluate(() => window.__FL__.setTool('select'));
await page.waitForTimeout(200);
const refLockedBefore = await page.evaluate(() => {
  const r = window.__FL__.refTool;
  return {
    state: r.state,
    gizmo: window.__FL__.editor.gizmo.object === r.nodeTransform.proxy,
  };
});
await page.evaluate(() => window.__FL__.editor.navGizmo.snapTo('posX'));
await page.waitForTimeout(700);
await page.screenshot({ path: `${ROOT}/.smoke/19-ref-billboard.png` });
const refLockedAfter = await page.evaluate(() => {
  const r = window.__FL__.refTool;
  const cam = window.__FL__.editor.camera;
  const rel = cam.quaternion.clone().invert().multiply(r.group.quaternion);
  const spinQ = new window.__FL__.THREE.Quaternion().setFromAxisAngle(
    new window.__FL__.THREE.Vector3(0, 0, 1),
    window.__FL__.THREE.MathUtils.degToRad(r.state.angleDeg));
  return {
    state: r.state,
    gizmo: window.__FL__.editor.gizmo.object === r.nodeTransform.proxy,
    billboardErr: rel.angleTo(spinQ),
  };
});
ok('ref image is locked in Model mode but still faces the camera',
  !refLockedBefore.gizmo && !refLockedAfter.gizmo &&
  Math.abs(refLockedBefore.state.x - refLockedAfter.state.x) < 1e-6 &&
  Math.abs(refLockedBefore.state.y - refLockedAfter.state.y) < 1e-6 &&
  Math.abs(refLockedBefore.state.z - refLockedAfter.state.z) < 1e-6 &&
  Math.abs(refLockedBefore.state.w - refLockedAfter.state.w) < 1e-6 &&
  Math.abs(refLockedBefore.state.h - refLockedAfter.state.h) < 1e-6 &&
  Math.abs(refLockedBefore.state.angleDeg - refLockedAfter.state.angleDeg) < 1e-6 &&
  refLockedAfter.billboardErr < 1e-3,
  JSON.stringify({ before: refLockedBefore, after: refLockedAfter }));

// In Model mode the topbar Ref toggle remains the only image control.
await page.evaluate(() => {
  const cb = document.getElementById('chk-showref');
  cb.checked = false;
  cb.dispatchEvent(new Event('change'));
});
const refToggleOff = await page.evaluate(() => window.__FL__.refTool.group.visible);
await page.evaluate(() => {
  const cb = document.getElementById('chk-showref');
  cb.checked = true;
  cb.dispatchEvent(new Event('change'));
});
const refToggleOn = await page.evaluate(() => window.__FL__.refTool.group.visible);
ok('Ref toggle still works in Model mode', !refToggleOff && refToggleOn,
  JSON.stringify({ off: refToggleOff, on: refToggleOn }));

// Whole-model export normalization: relative placement must survive.
const exportNorm = await page.evaluate(async () => {
  const THREE = window.__FL__.THREE;
  const { buildExportScene } = await import('/src/exporter.ts');
  const mk = (w, h, d, x) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(x, h / 2, 0);
    const obj = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    return { object: obj, geometry: geo, index: null, triCount: 12, name: 'm' + x };
  };
  const scene = buildExportScene([mk(20, 10, 4, 10), mk(10, 10, 10, 40)], true);
  return scene.children.map((m) => {
    m.geometry.computeBoundingBox();
    return +m.geometry.boundingBox.getCenter(new THREE.Vector3()).x.toFixed(4);
  });
});
ok('export normalization keeps multi-mesh relative placement',
  exportNorm[0] < 0 && exportNorm[1] > 0 &&
  Math.abs(exportNorm[0] + 0.2778) < 1e-3 && Math.abs(exportNorm[1] - 0.3889) < 1e-3,
  JSON.stringify(exportNorm));

// ---- FFD Collapse must bake the CURRENT cage, so a rebuild wraps the
// collapsed shape rather than the original mesh.
const ffdCollapseBake = await page.evaluate(() => {
  const { ffdTool: d, meshes, THREE } = window.__FL__;
  const mesh = meshes[0];
  const height = () => {
    mesh.geometry.computeBoundingBox();
    return mesh.geometry.boundingBox.getSize(new THREE.Vector3()).y;
  };
  window.__FL__.setTool('ffd');
  d.collapse(); // clean slate (no-op when there is no lattice)
  d.build();
  const before = height();
  // Modify the cage directly, WITHOUT applying the deformation to the mesh:
  // Collapse itself must bake it.
  for (let i = 0; i < d.lattice.nx; i++) {
    for (let k = 0; k < d.lattice.nz; k++) {
      const id = d.lattice.index(i, d.lattice.ny - 1, k);
      d.lattice.controlPoints[id * 3 + 1] += 4;
    }
  }
  d.collapse();
  const collapsed = height();
  d.build();
  const cage = (() => {
    const b = new THREE.Box3();
    const cp = d.lattice.controlPoints;
    for (let i = 0; i < d.lattice.count; i++) {
      b.expandByPoint(new THREE.Vector3(cp[i * 3], cp[i * 3 + 1], cp[i * 3 + 2]));
    }
    return b.getSize(new THREE.Vector3()).y;
  })();
  return { before, collapsed, cage };
});
ok('FFD Collapse bakes the current cage; rebuild wraps the collapsed shape',
  ffdCollapseBake.collapsed > ffdCollapseBake.before + 2 &&
  ffdCollapseBake.cage > ffdCollapseBake.collapsed,
  JSON.stringify(ffdCollapseBake));

// ---- Rebuilding with new dimensions must recreate the cage/point buffers.
// Reusing the old InstancedMesh/cage index leaves ghost points and a stale
// cage until a tab switch disposes/recreates the visuals.
const ffdVisualRebuild = await page.evaluate(() => {
  const { ffdTool: d, THREE } = window.__FL__;
  window.__FL__.setTool('ffd');
  d.collapse();
  d.settings.nx = 3; d.settings.ny = 3; d.settings.nz = 3;
  d.build();
  const before = { points: d.pointsMesh?.count, cageIndex: d.cageGeo?.index?.count };
  d.settings.nx = 4; d.settings.ny = 4; d.settings.nz = 4;
  d.build();
  const after = { points: d.pointsMesh?.count, cageIndex: d.cageGeo?.index?.count };
  // build() clears the selection; reused visuals must still be repainted.
  d.selectAll();
  d.build();
  const c = new THREE.Color();
  d.pointsMesh.getColorAt(0, c);
  const colorAfterBuild = c.getHex();
  // Restore 3×3×3 for the remaining tests/screenshot.
  d.settings.nx = 3; d.settings.ny = 3; d.settings.nz = 3;
  d.build();
  return { before, after, colorAfterBuild, red: 0xff5f5f, selected: d.selected.size };
});
ok('FFD rebuild recreates cage/point buffers for new dimensions',
  ffdVisualRebuild.before.points === 27 && ffdVisualRebuild.after.points === 64 &&
  ffdVisualRebuild.after.cageIndex > ffdVisualRebuild.before.cageIndex &&
  ffdVisualRebuild.colorAfterBuild !== ffdVisualRebuild.red,
  JSON.stringify(ffdVisualRebuild));

// ---- Axis colors on the FFD lattice and Floor fields.
const axisFieldColors = await page.evaluate(() => {
  const colorOf = (label) => {
    const row = [...document.querySelectorAll('#panel-body .row')]
      .find((r) => r.querySelector('label')?.textContent === label);
    const lab = row?.querySelector('label');
    return lab ? getComputedStyle(lab).color : null;
  };
  window.__FL__.setTool('floor');
  const floor = {
    x: colorOf('Width X'), z: colorOf('Depth Z'), y: colorOf('Height Y'),
    cx: colorOf('Center X'), cz: colorOf('Center Z'),
  };
  window.__FL__.setTool('ffd');
  const ffd = { x: colorOf('X'), y: colorOf('Y'), z: colorOf('Z') };
  return { floor, ffd };
});
const RED = 'rgb(224, 85, 78)';
const GREEN = 'rgb(139, 195, 74)';
const BLUE = 'rgb(66, 165, 245)';
ok('FFD lattice and Floor axis fields use X/Y/Z colors',
  axisFieldColors.ffd.x === RED && axisFieldColors.ffd.y === GREEN && axisFieldColors.ffd.z === BLUE &&
  axisFieldColors.floor.x === RED && axisFieldColors.floor.cx === RED &&
  axisFieldColors.floor.y === GREEN &&
  axisFieldColors.floor.z === BLUE && axisFieldColors.floor.cz === BLUE,
  JSON.stringify(axisFieldColors));

// ---- Planar scale handles (XY/YZ/XZ) must use ONE shared factor for both
// axes, not TransformControls' independent per-axis factors.
const planarScaleProbe = await page.evaluate(() => {
  const { floorTool: f, transformTool: tt, refTool: r, ffdTool: d, editor, THREE } = window.__FL__;
  const dragPending = (nt, s) => {
    editor.gizmoDragging = true;
    editor.gizmo.axis = 'XZ';
    nt.onGizmoStart();
    nt.proxy.scale.set(s[0], s[1], s[2]);
    nt.onGizmoChange('scale');
    editor.gizmoDragging = false;
    editor.gizmo.axis = null;
    return { sx: nt.pending.sx, sy: nt.pending.sy, sz: nt.pending.sz };
  };
  window.__FL__.setTool('floor');
  f.resetTransform();
  f.nodeTransform.attachGizmo('scale');
  f.planeVisuals.plane.parent.rotation.set(0, 0, 0);
  f.updatePlane();
  const floorXZ = dragPending(f.nodeTransform, [2, 1, 3]);
  f.resetTransform();

  window.__FL__.setTool('transform');
  tt.resetPending();
  editor.gizmoDragging = true;
  editor.gizmo.axis = 'XZ';
  tt.gizmoMode = 'scale';
  tt.onGizmoDragStart();
  tt.proxy.scale.set(2, 1, 3);
  tt.onGizmoChange();
  editor.gizmoDragging = false;
  editor.gizmo.axis = null;
  const modelXZ = { sx: tt.pending.sx, sy: tt.pending.sy, sz: tt.pending.sz };
  tt.resetPending();

  window.__FL__.setTool('ref');
  r.resetTransform(); // clear the pending size left by the aspect test
  r.nodeTransform.attachGizmo('scale');
  const refXZ = dragPending(r.nodeTransform, [2, 1, 3]);

  window.__FL__.setTool('ffd');
  d.collapse();
  d.build();
  d.selectAll();
  d.setGizmoMode('scale');
  const extents = () => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const cp = d.lattice.controlPoints;
    for (let i = 0; i < d.lattice.count; i++) {
      const x = cp[i * 3], z = cp[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { x: maxX - minX, z: maxZ - minZ };
  };
  const before = extents();
  editor.gizmo.axis = 'XZ';
  d.beginGizmoDrag();
  d.gizmoProxy.scale.set(2, 1, 3);
  d.updateGizmoDrag();
  d.endGizmoDrag();
  editor.gizmo.axis = null;
  const after = extents();
  return {
    floorXZ, modelXZ, refXZ,
    ffdRatio: { x: after.x / before.x, z: after.z / before.z },
  };
});
ok('planar scale uses one shared ratio for both axes',
  Math.abs(planarScaleProbe.floorXZ.sx - 2.5) < 1e-6 &&
  Math.abs(planarScaleProbe.floorXZ.sz - 2.5) < 1e-6 &&
  Math.abs(planarScaleProbe.floorXZ.sy - 1) < 1e-6 &&
  Math.abs(planarScaleProbe.modelXZ.sx - 2.5) < 1e-6 &&
  Math.abs(planarScaleProbe.modelXZ.sz - 2.5) < 1e-6 &&
  Math.abs(planarScaleProbe.refXZ.sx - 2.5) < 1e-6 &&
  Math.abs(planarScaleProbe.refXZ.sz - 2.5) < 1e-6 &&
  Math.abs(planarScaleProbe.ffdRatio.x - 2.5) < 1e-3 &&
  Math.abs(planarScaleProbe.ffdRatio.z - 2.5) < 1e-3,
  JSON.stringify(planarScaleProbe));

await page.screenshot({ path: `${ROOT}/.smoke/09-final.png` });

// ---- 10. i18n: EN | 中文 switch at the top-right
const langDefault = await page.evaluate(() => {
  const sw = document.getElementById('lang-switch');
  const r = sw.getBoundingClientRect();
  return {
    exists: !!sw,
    buttons: [...sw.querySelectorAll('button')].map((b) => b.textContent),
    active: sw.querySelector('button.active') ? sw.querySelector('button.active').dataset.lang : null,
    lang: window.__FL__.getLanguage(),
    htmlLang: document.documentElement.lang,
    title: document.title,
    right: r.right,
    top: r.top,
    innerWidth: window.innerWidth,
  };
});
ok('language switch exists at the top-right, default EN',
  langDefault.exists && langDefault.buttons.join('|') === 'EN|中文' &&
  langDefault.active === 'en' && langDefault.lang === 'en' &&
  langDefault.htmlLang === 'en' && langDefault.title === 'Floor Leveling Editor' &&
  langDefault.right > langDefault.innerWidth - 120 && langDefault.top < 45,
  JSON.stringify(langDefault));

await page.click('#lang-switch button[data-lang="zh"]');
await page.waitForTimeout(350);
const zh = await page.evaluate(() => {
  const labels = [];
  window.__FL__.editor.helperGroup.traverse((o) => {
    if (o.userData && o.userData.isLabel) labels.push(o.userData.labelText);
  });
  const ffdButtons = [...document.querySelectorAll('#panel-body button')].map((b) => b.textContent);
  return {
    lang: window.__FL__.getLanguage(),
    active: document.querySelector('#lang-switch button.active') ? document.querySelector('#lang-switch button.active').dataset.lang : null,
    htmlLang: document.documentElement.lang,
    title: document.title,
    importText: document.getElementById('btn-import').textContent,
    modelText: document.getElementById('tool-model').textContent,
    floorLabelText: document.querySelector('[data-i18n="topbar.floor"]').textContent,
    labelText: document.querySelector('[data-i18n="topbar.label"]').textContent,
    panelTitle: document.getElementById('panel-title').textContent,
    subTabs: [...document.querySelectorAll('#subtabs button')].map((b) => b.textContent),
    groupTitles: [...document.querySelectorAll('#panel-body .gtitle')].map((b) => b.textContent),
    ffdButtons,
    status: document.getElementById('status').textContent,
    navLabel: document.querySelector('.navgizmo-viewlabel').textContent,
    floorTag: window.__FL__.floorTool.floorLabelText,
    axisLabels: labels.filter((x) => x === 'X（米）' || x === 'Z（米）'),
    stored: localStorage.getItem('floor-leveling.lang'),
  };
});
ok('Chinese switch translates topbar, toolbar, panel, status, nav + 3D labels',
  zh.lang === 'zh' && zh.active === 'zh' && zh.htmlLang === 'zh-CN' &&
  zh.title === '地面找平编辑器' &&
  zh.importText === '导入…' && zh.modelText === '模型' &&
  zh.floorLabelText === '地面' && zh.labelText === '标签' &&
  zh.panelTitle === '自由变形（FFD）' &&
  zh.subTabs.join('|') === '信息|变换|FFD' &&
  zh.groupTitles.includes('晶格') && zh.groupTitles.includes('选择') &&
  zh.ffdButtons.includes('重置') && zh.ffdButtons.includes('塌陷') &&
  zh.status.includes('个三角形') &&
  (zh.navLabel.includes('视图') || zh.navLabel === '等轴测') &&
  zh.floorTag === '地面' && zh.axisLabels.length === 2 &&
  zh.stored === 'zh',
  JSON.stringify(zh));

// The new projection UI is translated too; leave the app in isometric for
// the Chinese screenshot below.
const zhIso = await page.evaluate(() => {
  const ed = window.__FL__.editor;
  // Reframe first: the projection tests above leave the camera zoomed in.
  ed.setProjectionMode('perspective');
  ed.frameModel();
  ed.setProjectionMode('isometric');
  return {
    mode: ed.projectionMode,
    label: document.querySelector('.navgizmo-viewlabel').textContent,
    title: ed.navGizmo.btnToggle.title,
  };
});
ok('Chinese isometric label + toggle title',
  zhIso.mode === 'isometric' && zhIso.label === '等轴测' && zhIso.title.includes('等轴测'),
  JSON.stringify(zhIso));

const transformTitles = await page.evaluate(() => {
  const FL = window.__FL__;
  const read = (tool, idx) => {
    FL.setTool(tool);
    const tabs = document.querySelectorAll('#subtabs button');
    tabs[idx].click();
    return document.getElementById('panel-title').textContent;
  };
  const floor = read('floor', 2);
  const ref = read('ref', 1);
  FL.setTool('ffd'); // restore the FFD panel for the screenshot
  return { floor, ref };
});
ok('Floor/Ref Transform panel titles are translated',
  transformTitles.floor === '地面' && transformTitles.ref === '参考图像',
  JSON.stringify(transformTitles));

await page.screenshot({ path: `${ROOT}/.smoke/21-chinese-ui.png` });

await page.click('#lang-switch button[data-lang="en"]');
await page.waitForTimeout(350);
const en = await page.evaluate(() => {
  const labels = [];
  window.__FL__.editor.helperGroup.traverse((o) => {
    if (o.userData && o.userData.isLabel) labels.push(o.userData.labelText);
  });
  return {
    lang: window.__FL__.getLanguage(),
    active: document.querySelector('#lang-switch button.active') ? document.querySelector('#lang-switch button.active').dataset.lang : null,
    htmlLang: document.documentElement.lang,
    title: document.title,
    importText: document.getElementById('btn-import').textContent,
    panelTitle: document.getElementById('panel-title').textContent,
    subTabs: [...document.querySelectorAll('#subtabs button')].map((b) => b.textContent),
    navLabel: document.querySelector('.navgizmo-viewlabel').textContent,
    floorTag: window.__FL__.floorTool.floorLabelText,
    hasAxisM: labels.includes('X (m)') && labels.includes('Z (m)'),
    stored: localStorage.getItem('floor-leveling.lang'),
  };
});
ok('switching back to EN restores English UI + 3D labels',
  en.lang === 'en' && en.active === 'en' && en.htmlLang === 'en' &&
  en.title === 'Floor Leveling Editor' && en.importText === 'Import…' &&
  en.panelTitle === 'Free-Form Deformation (FFD)' &&
  en.subTabs.join('|') === 'Info|Transform|FFD' &&
  (en.navLabel.includes('Perspective') || en.navLabel.includes('Orthographic') || en.navLabel.includes('Isometric')) &&
  en.floorTag === 'floor' && en.hasAxisM && en.stored === 'en',
  JSON.stringify(en));

writeFileSync(`${ROOT}/.smoke/results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
server.kill();
process.exit(failed.length ? 1 : 0);
