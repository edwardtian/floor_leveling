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
await page.click('#tool-transform');
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

// ---- 3. segmentation
await page.click('#tool-segment');
await page.waitForTimeout(300);
await page.evaluate(() => { window.__FL__.segmentTool.settings.countA = 3; window.__FL__.segmentTool.settings.countB = 3; });
await page.evaluate(() => window.__FL__.segmentTool.rebuild());
await page.waitForTimeout(600);
const segInfo = await page.evaluate(() => ({
  cells: window.__FL__.segmentTool.segCount,
  selected: window.__FL__.segmentTool.segmentation.selected.size,
  falloff: window.__FL__.segmentTool.segmentation.falloffHops,
}));
ok('segmentation built', segInfo.cells === 9, JSON.stringify(segInfo));
await page.screenshot({ path: `${ROOT}/.smoke/03-segments.png` });

// select a few segments and apply a numeric move
await page.evaluate(() => {
  window.__FL__.segmentTool.select([0, 1, 3], false);
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${ROOT}/.smoke/04-segments-selected.png` });
// measure the centroid of vertices actually belonging to the selected segments
const measureSel = () => page.evaluate(() => {
  const seg = window.__FL__.segmentTool;
  const m = window.__FL__.meshes[0];
  const p = m.geometry.getAttribute('position');
  const vs = new Set();
  for (const s of seg.segmentation.segments) {
    if (seg.segmentation.selected.has(s.id)) for (const v of s.vertexSet) vs.add(v);
  }
  let x = 0, y = 0, z = 0;
  for (const v of vs) { x += p.array[v * 3]; y += p.array[v * 3 + 1]; z += p.array[v * 3 + 2]; }
  return { n: vs.size, cx: x / vs.size, cy: y / vs.size, cz: z / vs.size };
});
const segBefore = await measureSel();
const applied = await page.evaluate(() => {
  const seg = window.__FL__.segmentTool;
  return seg.applyNumeric({ rotX: 0, rotY: 0, rotZ: 0, tx: 0.12, ty: -0.05, tz: 0, sx: 1, sy: 1, sz: 1 }, seg.selectionPivot());
});
await page.waitForTimeout(300);
const segAfter = await measureSel();
const moved = Math.hypot(segAfter.cx - segBefore.cx, segAfter.cy - segBefore.cy, segAfter.cz - segBefore.cz);
ok('segment move affects verts', applied && moved > 0.05, `applied=${applied} centroid moved ${moved.toFixed(3)} over ${segBefore.n} verts`);
ok('falloff softens motion', segAfter.cy - segBefore.cy > -0.05 && segAfter.cy - segBefore.cy < -0.01,
  `centroid dy ${(segAfter.cy - segBefore.cy).toFixed(3)} (full delta would be -0.05)`);

// gizmo drag flow (same code path as pointer drags on the TransformControls)
const gizmoMove = await page.evaluate(() => {
  const seg = window.__FL__.segmentTool;
  const ed = window.__FL__.editor;
  seg.select([4], false);
  seg.attachSelectionGizmo();
  ed.gizmo.dragging = true;
  seg.beginGizmoDrag();
  const p0 = seg.gizmoProxy.position.clone();
  seg.gizmoProxy.position.set(p0.x + 0.2, p0.y, p0.z - 0.1);
  seg.updateGizmoDrag();
  const changed = seg.endGizmoDrag();
  ed.gizmo.dragging = false;
  return changed;
});
ok('segment gizmo drag commits', gizmoMove === true);

// ---- 4. floor tool: plane, scan, level
await page.click('#tool-floor');
await page.waitForTimeout(500);
const floorFit = await page.evaluate(() => window.__FL__.floorTool.settings);
ok('floor fit to model', floorFit.sizeX > 0 && floorFit.sizeZ > 0, `x=${floorFit.sizeX.toFixed(2)} z=${floorFit.sizeZ.toFixed(2)}`);

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
  return [...biggest.triangles]; // snapshot: after leveling the intersection disappears (by design)
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

await page.screenshot({ path: `${ROOT}/.smoke/09-final.png` });

writeFileSync(`${ROOT}/.smoke/results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
server.kill();
process.exit(failed.length ? 1 : 0);
