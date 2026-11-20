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
node scripts/smoke.mjs   # headless end-to-end test (99 checks, system Chrome)
```

## Workflow

The toolbar on the left walks through the requirements:

| Tool | What it does |
|------|--------------|
| **Select** | Orbit (LMB), pan (RMB), zoom (wheel). Model info, mesh picker, **unit switch (m / cm)** — the grid ruler labels follow. |
| **Transform** | Rotate/translate/scale the whole object with the gizmo or numeric fields. Nothing touches the mesh until **Apply transform** bakes it into the vertex data (like Blender's *Apply Transform*). |
| **Segment** | Slice the mesh into an **N×M grid on any two axes** (per-triangle centroid assignment — no cracks). Click a cell to select it (Shift = add, drag = rect-select), then move/rotate/scale the selection with the gizmo; the whole block moves **rigidly** and the borders **blend smoothly** (adjustable falloff). |
| **Floor** | Create a floor plane you can **move / rotate / scale directly in the viewport** (Translate/Rotate/Scale gizmo, T/R/S buttons in the panel) or via numeric fields (width/depth/height/center, spin/tilt, "Fit to model", "Floor @ bottom"). The plane may be tilted — leveling works along the plane's own normal. **Scan intersections** finds and highlights every area of the mesh crossing/below the plane inside its footprint (connected areas, numbered). Select one (click / Shift-click / rect) and level it: **Drop** = rigid translate along the plane normal until the lowest point touches it; **Flatten** = vertices below the plane are pulled onto it. Both blend with a smooth falloff band and clamp band vertices so nothing stays underground. Repeat steps 2–7 as often as you like — every operation is undoable (Ctrl+Z / Ctrl+Shift+Z). |
| **Ref Image** | Load an image as a guide plane (horizontal/vertical, opacity slider, translate/rotate/scale via gizmo or fields). Purely a visual guide. |

## Navigation gizmo

A Blender-style view gizmo lives in the **top-right corner, in its own overlay space** — a dedicated canvas with its own WebGL context, layered above the viewport. It shares nothing with the model's canvas: it is always drawn on top (never occluded by the model, gizmos, or overlays), always interactable regardless of camera state, and clicks on it never leak into the 3D view (no accidental orbit/rect-select/tool hits).

- **Six axis balls** (solid = positive axis, hollow ring = negative; X red, Y green, Z blue). Click one to smoothly snap to that view — Right / Left / Top / Bottom / Front / Back. Horizontal snaps roll with world-up; pole snaps (Top/Bottom) keep a map-like roll, exactly like Blender.
- **Same-ball flip**: clicking the ball of the view you're already in flips to the opposite side (Front ⇄ Back, Right ⇄ Left, Top ⇄ Bottom) — also via the ring band of the aligned far ball.
- **Auto-orthographic**: landing on an exact axis view switches the viewport to orthographic; rotating away from it (gizmo drag or mouse-orbit) restores the projection you had before. Toggling projection *manually* (button / Numpad 5) is an override — rotating away keeps your explicit choice.
- **Drag the gizmo** anywhere to orbit the view (trackball-style), like dragging the sphere in Blender.
- **Zoom ±** buttons and a **perspective/orthographic toggle** below the ball (Blender's vertical stack); the toggle preserves the framing (Blender's Numpad 5).
- **Keyboard** follows Blender's numpad: `1` Front, `3` Right, `7` Top (+`Ctrl` for the opposite view), `5` ortho toggle, `+` / `−` zoom (top-row `=`/`-` work too).
- The caption under the gizmo shows the current state ("Front Orthographic", "User Perspective", ...).
- In orthographic mode, zooming adjusts the frustum scale instead of dollying, and the TransformControls gizmo adapts automatically.

## Keyboard shortcuts

3ds Max-style manipulator keys — they act on the **currently active object** (model via Transform/FFD, floor plane, or reference image), not a fixed tool:

| Key | Action |
| --- | --- |
| `Q` | Select tool (leaves any manipulator) |
| `W` | **Move** (translate) the active object |
| `E` | **Rotate** the active object |
| `R` | **Scale** the active object |
| `Tab` | Cycle the active object's Move → Rotate → Scale |

"Active object" = whichever tool is current: the model (Transform or FFD lattice), the floor plane, or the reference image. From the Select tool, `W`/`E`/`R`/`Tab` activate the model manipulator. If the active object has nothing to manipulate yet (no reference image loaded, FFD lattice collapsed), the keypress reports that instead of switching tools. Numpad `1`/`3`/`7` (+`Ctrl`) snap views, `5` toggles ortho, `+`/`−` zoom. Shortcuts are ignored while typing in a field and when a modal dialog is open. Every edit is undoable with `Ctrl+Z` / `Ctrl+Shift+Z`.

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
  adjacency, smoothstepped over a band proportional to the region size.
- **Undo/redo**: full vertex-buffer snapshots per command (fast for these mesh sizes).
- **Scene space** is meters; the unit selector is display-only (R7/Q6).

## Layout

```
src/
  main.ts          UI wiring, pointer/rect selection, tool panels
  editor.ts        renderer, cameras (persp/ortho), grid ruler, gizmo, picking, HUD
  navGizmo.ts      Blender-style nav gizmo in its own overlay canvas (view balls, orbit drag, zoom, proj toggle)
  importer.ts      glb/gltf/fbx/obj → flat group, import transform baked
  exporter.ts      glb/obj export + optional normalization
  transformTool.ts whole-object pending transform + apply (R2)
  segmentTool.ts   N×M segmentation, selection, gizmo deform (R4)
  floorTool.ts     floor plane, intersection scan, drop/flatten (R5–R7)
  refTool.ts       reference image plane (R3)
  falloff.ts       welded adjacency, selection falloff, vertex weights
  leveling.ts      plane intersection, drop/flatten math
  history.ts       undo/redo stack
  ui.ts            DOM helpers, toasts, modals
scripts/smoke.mjs  headless end-to-end test (99 checks)
```
