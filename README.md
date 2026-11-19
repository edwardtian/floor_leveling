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
node scripts/smoke.mjs   # headless end-to-end test (14 checks, system Chrome)
```

## Workflow

The toolbar on the left walks through the requirements:

| Tool | What it does |
|------|--------------|
| **Select** | Orbit (LMB), pan (RMB), zoom (wheel). Model info, mesh picker, **unit switch (m / cm)** — the grid ruler labels follow. |
| **Transform** | Rotate/translate/scale the whole object with the gizmo or numeric fields. Nothing touches the mesh until **Apply transform** bakes it into the vertex data (like Blender's *Apply Transform*). |
| **Segment** | Slice the mesh into an **N×M grid on any two axes** (per-triangle centroid assignment — no cracks). Click a cell to select it (Shift = add, drag = rect-select), then move/rotate/scale the selection with the gizmo; the whole block moves **rigidly** and the borders **blend smoothly** (adjustable falloff). |
| **Floor** | Create a resizable/movable floor plane (width/depth/height/center, "Fit to model", "Floor @ bottom"). **Scan intersections** finds and highlights every area of the mesh crossing the plane inside its footprint (connected areas, numbered). Select one (click / Shift-click / rect) and level it: **Drop** = rigid translate until the lowest point touches the plane; **Flatten** = vertices below the plane are pulled onto it. Both blend with a smooth falloff band and clamp band vertices so nothing stays underground. Repeat steps 2–7 as often as you like — every operation is undoable (Ctrl+Z / Ctrl+Shift+Z). |
| **Ref Image** | Load an image as a guide plane (horizontal/vertical, opacity slider, translate/rotate/scale via gizmo or fields). Purely a visual guide. |

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
  editor.ts        renderer, camera, grid ruler, gizmo, picking, rect UI
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
scripts/smoke.mjs  headless end-to-end test
```
