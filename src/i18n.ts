/**
 * Tiny i18n layer: English + Simplified Chinese.
 *
 * The app is built around a flat dictionary. `t(key, params)` interpolates
 * `{name}` placeholders. Language changes are broadcast so the panel, grid
 * captions, nav gizmo and floor tag can all re-render.
 */

export type Lang = 'en' | 'zh';

const EN = {
  'app.title': 'Floor Leveling Editor',

  // Topbar / toolbar / language switch
  'topbar.import': 'Import…',
  'topbar.exportGlb': 'Export GLB',
  'topbar.exportObj': 'Export OBJ',
  'topbar.undo': 'Undo',
  'topbar.redo': 'Redo',
  'topbar.floor': 'Floor',
  'topbar.ref': 'Ref',
  'topbar.wire': 'Wire',
  'topbar.grid': 'Grid',
  'topbar.label': 'Label',
  'toolbar.model': 'Model',
  'toolbar.floor': 'Floor',
  'toolbar.ref': 'Ref Image',
  'increments.aria': 'Transform increments',
  'increments.translate': 'Translate increment',
  'increments.rotate': 'Rotate increment',
  'increments.scale': 'Scale increment',
  'increments.translateShort': 'T',
  'increments.rotateShort': 'R',
  'increments.scaleShort': 'S',
  'toolbar.modelTitle': 'Model tools: Select, Transform, FFD',
  'toolbar.floorTitle': 'Floor plane + leveling',
  'toolbar.refTitle': 'Reference image',
  'lang.aria': 'Language',

  // Panel titles / sub-tabs
  'panel.scene': 'Scene',
  'panel.model': 'Model',
  'panel.floor': 'Floor',
  'panel.ref': 'Reference image',
  'panel.transform': 'Transform (Apply-style)',
  'panel.ffd': 'Free-Form Deformation (FFD)',
  'panel.floorBrush': 'Floor — Brush',
  'sub.info': 'Info',
  'sub.transform': 'Transform',
  'sub.ffd': 'FFD',
  'sub.floor': 'Floor',
  'sub.brush': 'Brush',
  'sub.image': 'Image',

  // Info panel
  'info.modelGroup': 'Model',
  'info.noModel': 'No model loaded. Use "Import…" (glb / fbx / obj).',
  'info.importFirst': 'Import a model first.',
  'info.mesh': 'Mesh',
  'info.name': 'Name',
  'info.triangles': 'Triangles',
  'info.vertices': 'Vertices',
  'info.size': 'Size',
  'info.height': 'Height',
  'info.unitsGroup': 'Units',
  'info.display': 'Display',
  'info.unitsHint': 'Scene space is meters. Labels on the grid ruler follow this setting.',
  'info.workflowGroup': 'Workflow',
  'info.workflowHint':
    '1 Import → 2 Transform (rotate/apply) → 3 FFD (free-form deform) → 4 Floor plane → ' +
    '5 Auto-highlighted intersections → 6 Brush / Drop / Flatten → repeat. Ctrl+Z undo.',
  'unit.meterLong': 'meters (m)',
  'unit.centimeterLong': 'centimeters (cm)',
  'unit.m': 'm',
  'unit.cm': 'cm',

  // Transform panels
  'transform.gizmo': 'Gizmo',
  'transform.gizmoHint': 'Drag the gizmo to preview. Nothing is baked until you press Apply.',
  'transform.rotation': 'Rotation (degrees)',
  'transform.rotation2d': 'Rotation (2D)',
  'transform.translation': 'Translation',
  'transform.scale': 'Scale',
  'transform.applyGroup': 'Apply',
  'transform.applyMesh': 'Apply transform (bake into mesh)',
  'transform.applyInto': 'Apply transform (bake into {target})',
  'transform.resetPending': 'Reset pending',
  'transform.bakedMesh': 'Transform baked into geometry.',
  'transform.bakedTarget': '{target} transform baked.',
  'transform.noPending': 'No pending transform.',
  'transform.pendingHint': '⚠ Pending transform (previewed, not baked). Apply or Reset.',
  'transform.pivotModel': 'Rotation/scale pivot = mesh bounding-box center. Translation is in world axes.',
  'transform.pivotObject': 'Rotation/scale pivot = the object origin. Translation is in world axes.',
  'transform.floorPendingHint': '⚠ Pending floor transform (previewed). Use the Transform sub-tab to Apply or Reset.',
  'transform.imagePendingHint': '⚠ Pending image transform (previewed). Use the Transform sub-tab to Apply or Reset.',
  'gizmo.translate': 'Move',
  'gizmo.rotate': 'Rotate',
  'gizmo.scale': 'Scale',
  'gizmo.short.translate': 'Tra',
  'gizmo.short.rotate': 'Rot',
  'gizmo.short.scale': 'Sca',

  // FFD panel
  'ffd.latticeGroup': 'Lattice',
  'ffd.cageMargin': 'Cage margin',
  'ffd.create': 'Create lattice',
  'ffd.rebuild': 'Rebuild lattice',
  'ffd.reset': 'Reset',
  'ffd.collapse': 'Collapse',
  'ffd.noLatticeToCollapse': 'No lattice to collapse.',
  'ffd.resetToast': 'Lattice reset to the rest cage.',
  'ffd.collapsedToast': 'Lattice removed — shape stays as deformed.',
  'ffd.latticeHint':
    'The lattice wraps the whole model. Click control points to select (Shift = add), drag on empty space ' +
    'for a rect, then drag the gizmo: the surface deforms smoothly.',
  'ffd.selectionGroup': 'Selection',
  'ffd.all': 'All',
  'ffd.none': 'None',
  'ffd.corners': 'Corners',
  'ffd.noLattice': 'No lattice yet.',
  'ffd.info': '{nx}×{ny}×{nz} = {count} control points · {selected} selected.',
  'ffd.created': 'FFD lattice {nx}×{ny}×{nz} created.',
  'ffd.buildFirst': 'Build the FFD lattice first (press "Create lattice").',
  'ffd.pointsSelected': '{n} control point(s) selected — drag the gizmo to deform.',

  // Floor panel
  'floor.planeGroup': 'Floor plane',
  'floor.widthX': 'Width X',
  'floor.depthZ': 'Depth Z',
  'floor.heightY': 'Height Y',
  'floor.centerX': 'Center X',
  'floor.centerZ': 'Center Z',
  'floor.spin': 'Spin / tilt (deg)',
  'floor.fit': 'Fit to model',
  'floor.bottom': 'Floor @ bottom',
  'floor.intersectionsGroup': 'Intersections',
  'floor.rescan': 'Rescan now',
  'floor.scanFound': '{n} intersecting area(s) found — click one to select.',
  'floor.scanNone': 'No intersections. Move the plane into the model.',
  'floor.highlightHint':
    'The highlight is live: it updates automatically while the plane moves or you paint in Brush. ' +
    'Bright orange = triangles accurately crossing the plane · yellow line = exact cut contour · ' +
    'green = flat on the plane · dim = buried below.',
  'floor.noAreas': 'No intersections yet — move the plane into the model; the highlight is automatic.',
  'floor.levelGroup': 'Level selection',
  'floor.drop': 'Drop',
  'floor.flatten': 'Flatten',
  'floor.levelHint':
    'Drop = rigid translate of the whole selection until its lowest point touches the plane. ' +
    'Flatten = vertices below the plane are pulled onto it. Both blend smoothly at the region border.',
  'floor.droppedToast': 'Dropped selection onto the floor plane.',
  'floor.flattenedToast': 'Flattened selection to the floor plane.',
  'floor.selectAreaFirst': 'Select an area first (click a highlighted region).',
  'floor.noAreasYetToast': 'No areas yet — move the plane into the model; the highlight is automatic.',
  'floor.areaSelected': 'Area {id} selected — now Drop or Flatten.',
  'floor.areaToggled': 'Area {id} toggled — now Drop or Flatten.',
  'floor.areasSelected': '{n} area(s) selected.',
  'floor.areaBadge': '#{id} · {count}f',
  'floor.areaBadgeTitle': 'y {min} … {max}',

  // Brush panel
  'brush.group': 'Brush',
  'brush.radius': 'Brush radius',
  'brush.falloffRadius': 'Falloff radius',
  'brush.radiusHint': 'Full strength inside Falloff radius, easing to zero at Brush radius.',
  'brush.curve': 'Falloff curve',
  'brush.smoothstep': 'Smooth Step',
  'brush.gaussian': 'Gaussian',
  'brush.hardness': 'Curve hardness',
  'brush.strength': 'Strength',
  'brush.showPreview': 'Show affected vertices',
  'brush.statsNone': 'No stroke yet — left-drag on the model to snap vertices.',
  'brush.stats':
    'Last dab: {affected} affected · {moved} snapped · max Δ {max} · stroke moves: {total}',
  'brush.paintHint':
    'Left-drag on the model to paint. The brush is a sphere centered where the cursor meets the floor ' +
    'plane: vertices above the plane are pushed down, vertices below are pulled up, and only the nearest ' +
    'vertices inside the radius move. Right-drag pans; drag the nav gizmo to orbit.',
  'brush.liveGroup': 'Live intersection',
  'brush.liveHint':
    'The intersection highlight updates automatically while you paint or move the plane: ' +
    'bright orange = crossing the plane, yellow line = exact cut contour, green = flat on the plane, ' +
    'dim = buried below. A whole left-drag is one undo step.',

  // Reference image panel
  'ref.group': 'Image',
  'ref.load': 'Load image…',
  'ref.loadHint':
    'The image is a camera-facing guide. In Ref Image mode you can translate, scale and rotate it in 2D; in other modes it is locked and can only be shown/hidden.',
  'ref.loaded': 'Loaded: {name}',
  'ref.replace': 'Replace image…',
  'ref.remove': 'Remove',
  'ref.lockedHint':
    'Always faces the camera. Transform editing is available only in Ref Image mode; other modes just show/hide it.',
  'ref.placement': 'Placement',
  'ref.heightY': 'Height Y',
  'ref.width': 'Width',
  'ref.height': 'Height',
  'ref.spin': 'Spin (2D)',
  'ref.opacity': 'Opacity',
  'ref.loadedToast': 'Reference image "{name}" loaded — drag the gizmo to place it.',

  // Status / toasts / history
  'status.importing': 'Importing {name}…',
  'status.imported': '{name} — {tris} tris · {verts} verts · {box}',
  'status.meshInfo': '{tris} tris · {box}',
  'status.importFailed': 'Import failed.',
  'status.exporting': 'Exporting…',
  'status.exported': 'Exported {name} ({size}).',
  'status.initial': 'Import a model to begin (glb / fbx / obj).',
  'toast.imported': 'Imported {name}.',
  'toast.importFailed': 'Import failed: {error}',
  'toast.exportFailed': 'Export failed: {error}',
  'toast.exported': 'Exported {name}.',
  'toast.nothingToUndo': 'Nothing to undo.',
  'toast.nothingToRedo': 'Nothing to redo.',
  'toast.undo': 'Undo: {name}',
  'toast.redo': 'Redo: {name}',
  'toast.pendingDiscarded': 'Pending transform discarded (mesh switched).',
  'status.pendingTransform': '⚠ pending transform (not applied)',
  'status.ffdSelection': 'FFD: {selected}/{total} points selected',
  'status.floorAreas': 'floor areas: {n} ({m} selected)',
  'toast.selectTool': 'Select',
  'toast.nothingToManipulate': '{target}: nothing to manipulate yet',
  'toast.mode': '{target}: {mode}',
  'history.applyTransform': 'Apply transform',
  'history.resetLattice': 'Reset lattice',
  'history.ffdDrag': 'FFD {mode}',
  'history.levelDrop': 'Level: drop to floor',
  'history.levelFlatten': 'Level: flatten to floor',
  'history.brush': 'Brush: push/pull to floor',
  'object.model': 'Model',
  'object.floor': 'Floor',
  'object.refImage': 'Ref image',
  'object.ffd': 'FFD',
  'object.image': 'Image',

  // Export dialogs
  'export.pendingTitle': 'Unapplied transform',
  'export.pendingBody':
    'There is a pending object transform that is only <b>previewed</b>, not baked into the mesh.<br>Apply it before exporting?',
  'export.applyContinue': 'Apply & continue',
  'export.discardPending': 'Discard pending',
  'export.cancel': 'Cancel',
  'export.optionsTitle': 'Export options',
  'export.modelSize': 'Model size',
  'export.triangles': 'Triangles',
  'export.normalizeIntro':
    'Before export you may <b>normalize</b> the model (uniform scale to 1 m max dimension, centered in XZ, feet at y&nbsp;=&nbsp;0):',
  'export.normalizeSummary': '{summary} → height {height} (normalized).',
  'export.neverExported': 'Floor plane, reference image and helpers are never exported.',
  'export.normalizeExport': 'Normalize & export',
  'export.exportAsIs': 'Export as-is',

  // Importer
  'import.animationIgnored': '{n} animation(s) ignored (static pose used).',
  'import.objMaterials': 'OBJ: materials/textures not loaded (geometry only).',
  'import.unsupported': 'Unsupported format ".{ext}" — use GLB, GLTF, FBX or OBJ.',
  'import.noMeshes': 'No meshes found in file.',
  'import.skinned': '"{name}" is skinned — bind pose baked as static geometry.',

  // Navigation gizmo
  'nav.right': 'Right',
  'nav.left': 'Left',
  'nav.top': 'Top',
  'nav.bottom': 'Bottom',
  'nav.front': 'Front',
  'nav.back': 'Back',
  'nav.user': 'User',
  'nav.perspective': 'Perspective',
  'nav.orthographic': 'Orthographic',
  'nav.isometric': 'Isometric',
  'nav.zoomIn': 'Zoom in',
  'nav.zoomOut': 'Zoom out',
  'nav.toggleProjection': 'Toggle projection: Perspective → Orthographic → Isometric (currently {mode})',
  'nav.view': '{view} {projection}',

  // 3D labels
  'scene.floor': 'floor',
  'scene.axisCaption': '{axis} ({unit})',
} as const;

export type TranslationKey = keyof typeof EN;
export type TranslationParams = Record<string, string | number>;

const ZH: Record<TranslationKey, string> = {
  'app.title': '地面找平编辑器',

  'topbar.import': '导入…',
  'topbar.exportGlb': '导出 GLB',
  'topbar.exportObj': '导出 OBJ',
  'topbar.undo': '撤销',
  'topbar.redo': '重做',
  'topbar.floor': '地面',
  'topbar.ref': '参考',
  'topbar.wire': '线框',
  'topbar.grid': '网格',
  'topbar.label': '标签',
  'toolbar.model': '模型',
  'toolbar.floor': '地面',
  'toolbar.ref': '参考图',
  'increments.aria': '变换增量',
  'increments.translate': '平移增量',
  'increments.rotate': '旋转增量',
  'increments.scale': '缩放增量',
  'increments.translateShort': '移',
  'increments.rotateShort': '旋',
  'increments.scaleShort': '缩',
  'toolbar.modelTitle': '模型工具：选择、变换、FFD',
  'toolbar.floorTitle': '地面平面 + 找平',
  'toolbar.refTitle': '参考图像',
  'lang.aria': '语言',

  'panel.scene': '场景',
  'panel.model': '模型',
  'panel.floor': '地面',
  'panel.ref': '参考图像',
  'panel.transform': '变换（应用式）',
  'panel.ffd': '自由变形（FFD）',
  'panel.floorBrush': '地面 — 笔刷',
  'sub.info': '信息',
  'sub.transform': '变换',
  'sub.ffd': 'FFD',
  'sub.floor': '地面',
  'sub.brush': '笔刷',
  'sub.image': '图像',

  'info.modelGroup': '模型',
  'info.noModel': '未加载模型。请使用“导入…”（glb / fbx / obj）。',
  'info.importFirst': '请先导入模型。',
  'info.mesh': '网格',
  'info.name': '名称',
  'info.triangles': '三角形',
  'info.vertices': '顶点',
  'info.size': '尺寸',
  'info.height': '高度',
  'info.unitsGroup': '单位',
  'info.display': '显示',
  'info.unitsHint': '场景空间以米为单位。网格标尺上的标签会跟随此设置。',
  'info.workflowGroup': '工作流程',
  'info.workflowHint':
    '1 导入 → 2 变换（旋转/应用）→ 3 FFD（自由变形）→ 4 地面平面 → ' +
    '5 自动高亮相交区域 → 6 笔刷 / 下放 / 压平 → 重复。Ctrl+Z 撤销。',
  'unit.meterLong': '米 (m)',
  'unit.centimeterLong': '厘米 (cm)',
  'unit.m': '米',
  'unit.cm': '厘米',

  'transform.gizmo': '操纵器',
  'transform.gizmoHint': '拖动操纵器进行预览。按下“应用”前不会烘焙到网格。',
  'transform.rotation': '旋转（度）',
  'transform.rotation2d': '旋转（2D）',
  'transform.translation': '平移',
  'transform.scale': '缩放',
  'transform.applyGroup': '应用',
  'transform.applyMesh': '应用变换（烘焙到网格）',
  'transform.applyInto': '应用变换（烘焙到{target}）',
  'transform.resetPending': '重置待定变换',
  'transform.bakedMesh': '变换已烘焙到几何体。',
  'transform.bakedTarget': '{target}变换已烘焙。',
  'transform.noPending': '没有待定变换。',
  'transform.pendingHint': '⚠ 存在待定变换（仅预览，未烘焙）。请应用或重置。',
  'transform.pivotModel': '旋转/缩放轴心 = 网格包围盒中心。平移使用世界坐标轴。',
  'transform.pivotObject': '旋转/缩放轴心 = 对象原点。平移使用世界坐标轴。',
  'transform.floorPendingHint': '⚠ 存在待定的地面变换（仅预览）。请使用“变换”子面板应用或重置。',
  'transform.imagePendingHint': '⚠ 存在待定的图像变换（仅预览）。请使用“变换”子面板应用或重置。',
  'gizmo.translate': '移动',
  'gizmo.rotate': '旋转',
  'gizmo.scale': '缩放',
  'gizmo.short.translate': '移',
  'gizmo.short.rotate': '旋',
  'gizmo.short.scale': '缩',

  'ffd.latticeGroup': '晶格',
  'ffd.cageMargin': '框架边距',
  'ffd.create': '创建晶格',
  'ffd.rebuild': '重建晶格',
  'ffd.reset': '重置',
  'ffd.collapse': '塌陷',
  'ffd.noLatticeToCollapse': '没有可塌陷的晶格。',
  'ffd.resetToast': '晶格已重置为静止框架。',
  'ffd.collapsedToast': '晶格已移除 — 形状保持变形结果。',
  'ffd.latticeHint':
    '晶格包裹整个模型。单击控制点进行选择（Shift = 添加），在空白处拖动可框选，' +
    '然后拖动操纵器：表面会平滑变形。',
  'ffd.selectionGroup': '选择',
  'ffd.all': '全部',
  'ffd.none': '无',
  'ffd.corners': '角点',
  'ffd.noLattice': '尚无晶格。',
  'ffd.info': '{nx}×{ny}×{nz} = {count} 个控制点 · 已选 {selected} 个。',
  'ffd.created': '已创建 FFD 晶格 {nx}×{ny}×{nz}。',
  'ffd.buildFirst': '请先创建 FFD 晶格（点击“创建晶格”）。',
  'ffd.pointsSelected': '已选择 {n} 个控制点 — 拖动操纵器进行变形。',

  'floor.planeGroup': '地面平面',
  'floor.widthX': '宽度 X',
  'floor.depthZ': '深度 Z',
  'floor.heightY': '高度 Y',
  'floor.centerX': '中心 X',
  'floor.centerZ': '中心 Z',
  'floor.spin': '旋转 / 倾斜（度）',
  'floor.fit': '适配模型',
  'floor.bottom': '地面置于底部',
  'floor.intersectionsGroup': '相交区域',
  'floor.rescan': '重新扫描',
  'floor.scanFound': '找到 {n} 个相交区域 — 点击选择一个。',
  'floor.scanNone': '没有相交区域。请将平面移入模型。',
  'floor.highlightHint':
    '高亮是实时的：移动平面或在笔刷中绘制时会自动更新。亮橙色 = 精确穿过平面的三角形 · ' +
    '黄线 = 精确切割轮廓 · 绿色 = 平贴平面 · 暗色 = 完全埋入平面以下。',
  'floor.noAreas': '尚无相交区域 — 将平面移入模型；高亮会自动更新。',
  'floor.levelGroup': '找平选择',
  'floor.drop': '下放',
  'floor.flatten': '压平',
  'floor.levelHint':
    '下放 = 整体刚性平移选择区域，直到最低点接触平面。压平 = 将平面以下的顶点拉到平面上。' +
    '两者都会在区域边界平滑过渡。',
  'floor.droppedToast': '已将选择区域下放到地面平面。',
  'floor.flattenedToast': '已将选择区域压平到地面平面。',
  'floor.selectAreaFirst': '请先选择一个区域（点击高亮区域）。',
  'floor.noAreasYetToast': '尚无区域 — 将平面移入模型；高亮会自动更新。',
  'floor.areaSelected': '已选择区域 {id} — 现在可以下放或压平。',
  'floor.areaToggled': '已切换区域 {id} — 现在可以下放或压平。',
  'floor.areasSelected': '已选择 {n} 个区域。',
  'floor.areaBadge': '#{id} · {count}面',
  'floor.areaBadgeTitle': 'y {min} … {max}',

  'brush.group': '笔刷',
  'brush.radius': '笔刷半径',
  'brush.falloffRadius': '衰减半径',
  'brush.radiusHint': '在衰减半径内为全强度，到笔刷半径处渐变为零。',
  'brush.curve': '衰减曲线',
  'brush.smoothstep': '平滑阶梯',
  'brush.gaussian': '高斯',
  'brush.hardness': '曲线硬度',
  'brush.strength': '强度',
  'brush.showPreview': '显示受影响顶点',
  'brush.statsNone': '尚未绘制 — 在模型上左键拖动以吸附顶点。',
  'brush.stats': '上一次点按：影响 {affected} 个 · 吸附 {moved} 个 · 最大 Δ {max} · 笔画移动：{total}',
  'brush.paintHint':
    '在模型上左键拖动进行绘制。笔刷是一个球体，球心位于光标与地面平面的交点：' +
    '平面上方的顶点被下压，平面下方的顶点被上拉，只有半径内最近的顶点会移动。' +
    '右键拖动平移；拖动导航器旋转视角。',
  'brush.liveGroup': '实时相交',
  'brush.liveHint':
    '绘制或移动平面时，相交高亮会自动更新：亮橙色 = 穿过平面，黄线 = 精确切割轮廓，' +
    '绿色 = 平贴平面，暗色 = 完全埋入。一次完整的左键拖动为一步撤销。',

  'ref.group': '图像',
  'ref.load': '加载图像…',
  'ref.loadHint': '图像始终面向相机。在参考图模式下可以平移、缩放并进行 2D 旋转；其他模式下已锁定，只能显示/隐藏。',
  'ref.loaded': '已加载：{name}',
  'ref.replace': '替换图像…',
  'ref.remove': '移除',
  'ref.lockedHint': '始终面向相机。仅在参考图模式下可以编辑变换；其他模式只能显示/隐藏。',
  'ref.placement': '放置',
  'ref.heightY': '高度 Y',
  'ref.width': '宽度',
  'ref.height': '高度',
  'ref.spin': '旋转（2D）',
  'ref.opacity': '不透明度',
  'ref.loadedToast': '参考图像“{name}”已加载 — 拖动操纵器进行放置。',

  'status.importing': '正在导入 {name}…',
  'status.imported': '{name} — {tris} 个三角形 · {verts} 个顶点 · {box}',
  'status.meshInfo': '{tris} 个三角形 · {box}',
  'status.importFailed': '导入失败。',
  'status.exporting': '正在导出…',
  'status.exported': '已导出 {name}（{size}）。',
  'status.initial': '导入模型以开始（glb / fbx / obj）。',
  'toast.imported': '已导入 {name}。',
  'toast.importFailed': '导入失败：{error}',
  'toast.exportFailed': '导出失败：{error}',
  'toast.exported': '已导出 {name}。',
  'toast.nothingToUndo': '没有可撤销的操作。',
  'toast.nothingToRedo': '没有可重做的操作。',
  'toast.undo': '撤销：{name}',
  'toast.redo': '重做：{name}',
  'toast.pendingDiscarded': '待定变换已丢弃（已切换网格）。',
  'status.pendingTransform': '⚠ 待定变换（未应用）',
  'status.ffdSelection': 'FFD：已选 {selected}/{total} 个点',
  'status.floorAreas': '地面区域：{n} 个（已选 {m} 个）',
  'toast.selectTool': '选择',
  'toast.nothingToManipulate': '{target}：暂无可操纵对象',
  'toast.mode': '{target}：{mode}',
  'history.applyTransform': '应用变换',
  'history.resetLattice': '重置晶格',
  'history.ffdDrag': 'FFD {mode}',
  'history.levelDrop': '找平：下放到地面',
  'history.levelFlatten': '找平：压平到地面',
  'history.brush': '笔刷：推/拉到地面',
  'object.model': '模型',
  'object.floor': '地面',
  'object.refImage': '参考图',
  'object.ffd': 'FFD',
  'object.image': '图像',

  'export.pendingTitle': '未应用的变换',
  'export.pendingBody':
    '存在一个仅<b>预览</b>、尚未烘焙到网格的待定对象变换。<br>导出前要应用它吗？',
  'export.applyContinue': '应用并继续',
  'export.discardPending': '丢弃待定变换',
  'export.cancel': '取消',
  'export.optionsTitle': '导出选项',
  'export.modelSize': '模型尺寸',
  'export.triangles': '三角形',
  'export.normalizeIntro':
    '导出前可以将模型<b>归一化</b>（统一缩放到最大尺寸 1 米，XZ 居中，底部位于 y&nbsp;=&nbsp;0）：',
  'export.normalizeSummary': '{summary} → 高度 {height}（归一化后）。',
  'export.neverExported': '地面平面、参考图像和辅助对象永远不会被导出。',
  'export.normalizeExport': '归一化并导出',
  'export.exportAsIs': '按原样导出',

  'import.animationIgnored': '已忽略 {n} 个动画（使用静态姿势）。',
  'import.objMaterials': 'OBJ：未加载材质/纹理（仅几何体）。',
  'import.unsupported': '不支持的格式“.{ext}” — 请使用 GLB、GLTF、FBX 或 OBJ。',
  'import.noMeshes': '文件中未找到网格。',
  'import.skinned': '“{name}”为蒙皮网格 — 绑定姿势已烘焙为静态几何体。',

  'nav.right': '右',
  'nav.left': '左',
  'nav.top': '上',
  'nav.bottom': '下',
  'nav.front': '前',
  'nav.back': '后',
  'nav.user': '用户',
  'nav.perspective': '透视',
  'nav.orthographic': '正交',
  'nav.isometric': '等轴测',
  'nav.zoomIn': '放大',
  'nav.zoomOut': '缩小',
  'nav.toggleProjection': '切换投影：透视 → 正交 → 等轴测（当前：{mode}）',
  'nav.view': '{view}视图 {projection}',

  'scene.floor': '地面',
  'scene.axisCaption': '{axis}（{unit}）',
};

let current: Lang = 'en';
const listeners: ((lang: Lang) => void)[] = [];
const STORAGE_KEY = 'floor-leveling.lang';

export function getLang(): Lang {
  return current;
}

/** Translate a key and interpolate `{name}` placeholders. */
export function t(key: TranslationKey, params?: TranslationParams): string {
  const dict: Record<TranslationKey, string> = current === 'zh' ? ZH : EN;
  let text = dict[key] ?? EN[key] ?? String(key);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.split(`{${k}}`).join(String(v));
    }
  }
  return text;
}

/** Switch language, persist it and notify listeners. */
export function setLang(lang: Lang): void {
  if (lang !== 'en' && lang !== 'zh') return;
  if (current === lang) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* storage unavailable */
  }
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  for (const fn of listeners) fn(lang);
}

/** Read the saved language (or default to the browser language). Call before building UI. */
export function initLang(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
  const browserZh = (navigator.language || '').toLowerCase().startsWith('zh');
  current = saved === 'zh' || (saved === null && browserZh) ? 'zh' : 'en';
  document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en';
}

export function onLangChange(fn: (lang: Lang) => void): void {
  listeners.push(fn);
}
