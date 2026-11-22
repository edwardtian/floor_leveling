# Floor Leveling Editor

A browser-based 3D editor (three.js + Vite + TypeScript) for **leveling scanned /
AI-generated models onto a floor plane** — built around the `lishan.glb` example.

![import](.smoke/01-imported.png)

## Run

```bash
pnpm install
pnpm dev            # http://localhost:5173
```

Other scripts:

```bash
pnpm build          # typecheck + production build (dist/)
node scripts/smoke.mjs   # headless end-to-end test (142 checks, system Chrome)
```

## Workflow

The toolbar on the left walks through the requirements:

| Tool | What it does |
|------|--------------|
| **Info** | Orbit (LMB), pan (RMB), zoom (wheel). Model info, mesh picker, **unit switch (m / cm)** — the grid ruler labels follow. |
| **Transform** | Rotate/translate/scale the whole object with the gizmo or numeric fields. Nothing touches the mesh until **Apply transform** bakes it into the vertex data (like Blender's *Apply Transform*). Planar scale handles (XY/YZ/XZ) use one shared ratio for both axes. |
| **FFD** | A 3D lattice wraps the model. Click control points (Shift = add, drag = rect-select) and move/rotate/scale them with the gizmo to deform the surface smoothly. **Collapse** bakes the current cage into the mesh, so the next lattice wraps the collapsed shape. |
| **Floor** | Create a floor plane you can **move / rotate / scale directly in the viewport** (Translate/Rotate/Scale gizmo, T/R/S buttons in the panel) or via numeric fields (width/depth/height/center, spin/tilt, "Fit to model", "Floor @ bottom"). The plane may be tilted — leveling works along the plane's own normal. The **intersection highlight is automatic and live**: moving the plane, painting and undo/redo refresh it, and returning to Floor after model edits rescans immediately. Bright orange = triangles accurately crossing the plane, yellow line = exact cut contour, green = flat on the plane, dim = buried below. The **Brush** sub-panel snaps only the nearest vertices onto the plane (push down above it, pull up below it) with adjustable radius, falloff radius and curve. The Floor sub-panel also lists connected areas (numbered, click / Shift-click / rect-select) for **Drop** (rigid translate until the lowest point touches the plane) or **Flatten** (pull vertices below onto it), both blended with a smooth falloff. Repeat as often as you like — every operation, including a whole brush stroke, is undoable (Ctrl+Z / Ctrl+Shift+Z). |
| **Ref Image** | Load an image as a **camera-facing billboard** guide. In Ref Image mode you can translate, scale (local X/Y) and rotate it in **2D** (screen-plane spin); in other modes the transform is locked and the topbar Ref toggle only shows/hides it. Purely a visual guide, never exported. |

## Topbar toggles

**Floor / Ref / Wire / Grid / Label** switch scene helpers:

- **Floor** — show/hide the floor plane and its outline in any tool mode
  (Model, Floor or Ref). The plane is fitted to the imported model even while
  you stay in Model mode, so it works as a ground reference; the `floor` tag
  follows while the Floor tool is active.
- **Ref** — show/hide the reference image in any tool mode; editing is available only in Ref Image mode.
- **Wire** — wireframe view of the model.
- **Grid** — major/minor grid lines, the axes and the ruler labels.
- **Label** — all 3D text labels: the grid distance numbers, the `X (m)` /
  `Z (m)` (or `cm`) unit captions, and the `floor` tag. Grid lines and axes
  stay visible, so you can keep the ruler but remove the text.

**Label** is independent of **Grid**: with Grid off the whole ruler disappears;
with Grid on, **Label** alone controls the text.

## Languages

The top-right **EN | 中文** switch translates the whole app: topbar, toolbar,
panel titles/groups/fields/hints, buttons, toasts, status bar, navigation-gizmo
captions, the `floor` / `地面` tag, and the grid axis captions
(`X (m)` / `X（米）`). On first visit it follows the browser language
(`zh*` → 中文), then remembers your choice in `localStorage`, so it survives a
reload.

![Chinese UI](.smoke/21-chinese-ui.png)

## Reference image

The reference image is a **camera-facing billboard**, not a world-axis-aligned
plane: it always faces the viewport camera, so it stays readable while you
orbit. It is drawn as an overlay (like tracing paper) and is never exported.

- **Ref Image mode** is the only place it can be transformed:
  - translate (world XYZ, gizmo or Transform fields),
  - scale (local X/Y = width/height; the Z handle is hidden),
  - rotate in **2D only** — the rotate gizmo exposes just the local Z ring and
    the panel has a single **Spin (2D)** field.
- In **Model / Floor** mode the transform is locked (gizmo detached); the
  topbar **Ref** toggle only shows/hides it. The billboard still turns to face
  the camera.
- The Ref panel shows width/height/height-Y/spin/opacity; the Transform
  sub-tab has the gizmo, translation, scale and Apply/Reset for the pending
  translation/scale.

![Reference image billboard](.smoke/08-reference.png)

![2D rotate gizmo](.smoke/20-ref-rotate2d.png)

## Floor brush

The **Floor ▸ Brush** sub-panel is a local snap brush for fixing the last few
centimetres of a scan by hand:

- **Brush radius** — the outer radius of the spherical brush. Only vertices
  inside this sphere move ("only the nearest vertices"); distant geometry is
  untouched.
- **Falloff radius** — the full-strength core. Between it and the brush radius
  the weight eases to zero.
- **Falloff curve** — *Smooth Step* or *Gaussian*, with a **curve hardness**
  slider (soft shoulder ⇄ hard edge) and a live plot of the exact weight curve.
- **Strength** — fraction of the snap distance applied per dab (1 = exactly
  onto the plane).
- **Push / pull** is decided per vertex: vertices above the plane are pushed
  down, vertices below are pulled up. A whole left-drag is one undo step.
- The cursor shows the outer ring, the falloff ring and a coloured preview of
  the affected vertices (blue = weak, yellow = full strength).

The brush is centred where the cursor ray meets the (possibly tilted) floor
plane; the snap direction is the plane normal. Right-drag pans, and dragging
the nav gizmo orbits — left-drag is reserved for painting.

![brush panel](.smoke/17-floor-brush-panel.png)

![brush highlight](.smoke/18-brush-highlight.png)

## Live intersection highlight

The intersection highlight is automatic (the Floor panel keeps a **Rescan now**
button for convenience): a cheap signature (mesh position-buffer version +
plane world matrix) is checked once per frame, and the scan re-runs only when
something actually changed. The overlay now distinguishes what the old scan
lumped together:

| Colour | Meaning |
| --- | --- |
| bright orange | triangles that **accurately straddle** the plane (one vertex above, one below) |
| yellow line | the **exact triangle/plane cut contour** |
| green | triangles lying flat **on** the plane (a brushed/leveled patch) |
| dim brown | triangles buried fully below the plane (still selectable for Drop/Flatten) |
| red | the currently selected area |

This makes brush feedback immediate: snapping a patch turns it green, shrinks
the orange crossing band and redraws the yellow contour while you paint.

## Navigation gizmo

A Blender-style view gizmo lives in the **top-right corner, in its own overlay space** — a dedicated canvas with its own WebGL context, layered above the viewport. It shares nothing with the model's canvas: it is always drawn on top (never occluded by the model, gizmos, or overlays), always interactable regardless of camera state, and clicks on it never leak into the 3D view (no accidental orbit/rect-select/tool hits).

- **Six axis balls** (solid = positive axis, hollow ring = negative; X red, Y green, Z blue). Click one to smoothly snap to that view — Right / Left / Top / Bottom / Front / Back. Horizontal snaps roll with world-up; pole snaps (Top/Bottom) keep a map-like roll, exactly like Blender.
- **Same-ball flip**: clicking the ball of the view you're already in flips to the opposite side (Front ⇄ Back, Right ⇄ Left, Top ⇄ Bottom) — also via the ring band of the aligned far ball.
- **Auto-orthographic**: landing on an exact axis view switches the viewport to orthographic; rotating away from it (gizmo drag or mouse-orbit) restores the projection you had before. Toggling projection *manually* (button / Numpad 5) is an override — rotating away keeps your explicit choice. Snapping to an axis from isometric leaves isometric mode and enters the axis view.
- **Drag the gizmo** anywhere to orbit the view (trackball-style), like dragging the sphere in Blender.
- **Zoom ±** buttons and a **projection toggle** below the ball (Blender's vertical stack). It cycles **Perspective → Orthographic → Isometric**: perspective ↔ orthographic keeps the current orientation and framing, while isometric switches to an orthographic camera at the standard isometric angle (45° azimuth, ~35.26° elevation). The button icon and tooltip show the current mode.
- **Keyboard** follows Blender's numpad: `1` Front, `3` Right, `7` Top (+`Ctrl` for the opposite view), `5` cycles perspective/orthographic/isometric, `+` / `−` zoom (top-row `=`/`-` work too).
- The caption under the gizmo shows the current state ("Front Orthographic", "User Perspective", "Isometric", ...).
- In orthographic/isometric mode, zooming adjusts the frustum scale instead of dollying, and the TransformControls gizmo adapts automatically.

![Isometric projection](.smoke/16-nav-iso.png)

## Keyboard shortcuts

3ds Max-style manipulator keys — they act on the **currently active object** (model via Transform/FFD, floor plane, or reference image), not a fixed tool:

| Key | Action |
| --- | --- |
| `Q` | Info / Select tool (leaves any manipulator) |
| `W` | **Move** (translate) the active object |
| `E` | **Rotate** the active object |
| `R` | **Scale** the active object |
| `Tab` | Cycle the active object's Move → Rotate → Scale |

"Active object" = whichever tool is current: the model (Transform or FFD lattice), the floor plane, or the reference image. From the Info (Select) tool, `W`/`E`/`R`/`Tab` activate the model manipulator. If the active object has nothing to manipulate yet (no reference image loaded, FFD lattice collapsed), the keypress reports that instead of switching tools. In **Floor ▸ Brush**, left-drag paints, so `W`/`E`/`R`/`Tab` first leave Brush and open the floor plane's Transform panel with its gizmo. Numpad `1`/`3`/`7` (+`Ctrl`) snap views, `5` cycles perspective/orthographic/isometric, `+`/`−` zoom. Shortcuts are ignored while typing in a field and when a modal dialog is open. Every edit is undoable with `Ctrl+Z` / `Ctrl+Shift+Z`.

## Export

**Export GLB / Export OBJ** from the top bar:

1. If a transform is still pending (previewed but not applied) you're asked to apply or discard it.
2. You're offered **normalization** (uniform scale to 1 m max dimension, centered, feet at y=0) — with a preview of the exact numbers — or export as-is (original units preserved).
3. The floor plane, reference image, and helpers are **never** exported.

## Technical notes

- **Position-welded topology**: scan/AI meshes often duplicate vertices per face
  (the example glb has 23.1k triangles but 24.1k vertices). Adjacency, falloff
  weights, and connected-area detection all operate on welded (quantized 1e-5 m)
  vertices, so edits never crack duplicated-vertex meshes.
- **Falloff**: BFS hop distance from the selection border over triangle
  adjacency, smoothstepped over a band proportional to the region size. The
  brush uses its own distance falloff (spherical, in metres) with Smooth Step or
  normalized Gaussian shapes; a brushed patch is welded back together because
  all coincident vertices inside the sphere receive the same weight.
- **Live scan**: `intersectFloorPlane` returns the buried/crossing triangle set,
  the exact straddling subset, coplanar triangles and the triangle/plane cut
  segments. The tool checks a signature of the position-buffer version and the
  plane's world matrix once per frame and rescans only on change — so brush
  dabs, plane drags, FFD/transform edits and undo/redo all update the overlay
  without a manual Scan click.
- **Brush stroke undo**: one `Float32Array` snapshot at pointer-down and one at
  pointer-up, pushed as a single history command (same snapshot strategy as
  Drop/Flatten).
- **Undo/redo**: full vertex-buffer snapshots per command (fast for these mesh sizes).
- **Scene space** is meters; the unit selector is display-only (R7/Q6).

## Layout

```
src/
  main.ts          UI wiring, pointer/rect selection, tool panels
  editor.ts        renderer, cameras (persp/ortho), grid ruler, gizmo, picking, HUD, per-frame hooks
  navGizmo.ts      Blender-style nav gizmo in its own overlay canvas (view balls, orbit drag, zoom, proj toggle)
  importer.ts      glb/gltf/fbx/obj → flat group, import transform baked
  exporter.ts      glb/obj export + optional normalization
  transformTool.ts whole-object pending transform + apply (R2)
  ffdTool.ts       lattice lifecycle, control-point selection, gizmo deform
  ffd.ts           Bernstein–Bézier lattice math
  floorTool.ts     floor plane, live intersection scan, brush mode, drop/flatten (R5–R7)
  brush.ts         brush falloff curves, dab application, affected-vertex collection
  refTool.ts       reference image plane (R3)
  falloff.ts       welded adjacency, selection falloff, vertex weights
  leveling.ts      plane intersection (crossing/on-plane/cut segments), drop/flatten math
  history.ts       undo/redo stack
  ui.ts            DOM helpers, toasts, modals
scripts/smoke.mjs  headless end-to-end test (142 checks)
```
