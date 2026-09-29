// Entry point. Wires model + renderer + UI panels together (M1-M6).
// See docs/requirements/01-web-layout-editor-requirements.md for scope.

import './style.css';
import { createProject } from './model/project.js';
import { loadManifest } from './model/manifest.js';
import { History } from './model/history.js';
import { ScatterPreview } from './model/scatterPreview.js';
import { CanvasRenderer } from './render/canvasRenderer.js';
import { PalettePanel } from './ui/palettePanel.js';
import { InspectorPanel } from './ui/inspectorPanel.js';
import { LayersPanel } from './ui/layersPanel.js';
import { PlaceTool } from './tools/placeTool.js';
import { RoadTool } from './tools/roadTool.js';
import { isClosedRoad } from './model/entities/road.js';
import { SelectTool } from './tools/selectTool.js';
import { ScatterTool } from './tools/scatterTool.js';
import { ExportDialog } from './ui/exportDialog.js';
import { ShortcutsDialog } from './ui/shortcutsDialog.js';
import { CanvasSizeDialog } from './ui/canvasSizeDialog.js';
import { downloadProjectFile, loadProjectFileInto, ProjectFileError } from './io/projectFile.js';

const GRID_SIZES = [1, 2, 5, 10];
const HIT_RADIUS_PX = 8; // screen-pixel radius for point/segment/entity hit testing

// Tool-switch shortcuts (FR-32). Digits rather than initials: every sensible
// initial (c/v/d/f/m) is already taken by an edit or view action.
const TOOL_KEYS = {
  1: 'place', 2: 'road', 3: 'select', 4: 'scatter',
};

async function main() {
  const app = document.querySelector('#app');
  app.innerHTML = `
    <div class="toolbar" id="toolbar">
      <h1>City Layout Editor</h1>
      <div class="tool-switch" role="group" aria-label="Tool">
        <button id="tool-place" class="tool-btn" type="button" aria-pressed="true">Place</button>
        <button id="tool-road" class="tool-btn" type="button" aria-pressed="false">Road</button>
        <button id="tool-select" class="tool-btn" type="button" aria-pressed="false">Select</button>
        <button id="tool-scatter" class="tool-btn" type="button" aria-pressed="false">Scatter</button>
      </div>
      <div class="select-controls" id="select-controls" hidden>
        <button id="select-copy" type="button" title="Copy (Ctrl+C)">Copy</button>
        <button id="select-paste" type="button" disabled title="Paste (Ctrl+V)">Paste</button>
        <button id="select-duplicate" type="button" disabled title="Duplicate (Ctrl+D)">Duplicate</button>
        <button id="select-delete" type="button" disabled title="Delete (Del)">Delete</button>
      </div>
      <div class="scatter-controls" id="scatter-controls" hidden>
        <label>Count
          <input type="number" id="scatter-count" min="0" step="1" value="10">
        </label>
      </div>
      <div class="history-controls">
        <button id="undo-btn" type="button" title="Undo (Ctrl+Z)">Undo</button>
        <button id="redo-btn" type="button" title="Redo (Ctrl+Shift+Z)">Redo</button>
      </div>
      <label>Grid
        <select id="grid-size"></select>
      </label>
      <label><input type="checkbox" id="grid-visible" checked> Show grid</label>
      <label><input type="checkbox" id="grid-snap"> Snap</label>
      <button id="canvas-size-btn" type="button" title="Set canvas / site size (FR-2)">Canvas…</button>
      <button id="fit-view" title="Fit to view (F)">Fit</button>
      <span class="spacer"></span>
      <span class="readout" id="tool-status"></span>
      <span class="readout" id="readout">—</span>
      <button id="save-project-btn" type="button" title="Save project (FR-23)">Save</button>
      <button id="load-project-btn" type="button" title="Load project (FR-23)">Load</button>
      <input type="file" id="load-project-input" accept="application/json,.json" hidden>
      <button id="export-open-btn" type="button" title="Export layout">Export</button>
      <button id="shortcuts-btn" type="button" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">?</button>
    </div>
    <aside class="panel panel-left">
      <div id="palette"></div>
      <div class="road-panel" id="road-controls" hidden>
        <h2 class="panel-title">Road Options</h2>
        <div class="tool-switch" role="group" aria-label="Road mode">
          <button id="road-mode-draw" class="tool-btn" type="button" aria-pressed="true">Draw</button>
          <button id="road-mode-edit" class="tool-btn" type="button" aria-pressed="false">Edit</button>
        </div>
        <div class="road-panel-group" id="road-draw-group">
          <label class="road-panel-field">Width (m)
            <input type="number" id="road-width" min="0.5" step="0.5" value="6">
          </label>
          <h3 class="panel-group-title">Path</h3>
          <button id="road-finish" type="button" disabled title="Finish path (double-click or Enter)">Finish</button>
          <button id="road-cancel" type="button" disabled title="Cancel path (Esc)">Cancel</button>
        </div>
        <h3 class="panel-group-title">Edit</h3>
        <button id="road-split" type="button" disabled title="Split road at selected point">Split at point</button>
        <button id="road-delete-segment" type="button" disabled title="Delete selected segment">Delete segment</button>
        <button id="road-delete-road" type="button" disabled title="Delete whole selected road">Delete road</button>
        <button id="road-merge" type="button" disabled title="Merge two shift-clicked roads">Merge roads</button>
        <button id="road-close" type="button" disabled title="Join the selected road's last point back to its first">Close loop</button>
      </div>
      <div class="layers-panel" id="layers"></div>
    </aside>
    <div class="canvas-wrap">
      <canvas id="canvas"></canvas>
    </div>
    <aside class="panel panel-right" id="inspector"></aside>
    <div class="modal-overlay" id="canvas-size-overlay" hidden>
      <div class="modal-box" role="dialog" aria-label="Canvas size">
        <h2 class="panel-title">Canvas Size</h2>
        <label class="modal-field">Width (m)
          <input type="number" id="canvas-width" min="1" step="1">
        </label>
        <label class="modal-field">Depth (m)
          <input type="number" id="canvas-height" min="1" step="1">
        </label>
        <div id="canvas-size-warning" class="canvas-warning" hidden></div>
        <div class="modal-actions">
          <button id="canvas-size-cancel" type="button">Cancel</button>
          <button id="canvas-size-confirm" type="button">Apply</button>
        </div>
      </div>
    </div>
    <div class="modal-overlay" id="shortcuts-overlay" hidden>
      <div class="modal-box" role="dialog" aria-label="Keyboard shortcuts">
        <h2 class="panel-title">Keyboard Shortcuts</h2>
        <div id="shortcuts-list"></div>
        <div class="modal-actions">
          <button id="shortcuts-close-btn" type="button">Close</button>
        </div>
      </div>
    </div>
    <div class="modal-overlay" id="export-overlay" hidden>
      <div class="modal-box" role="dialog" aria-label="Export layout">
        <h2 class="panel-title">Export Layout</h2>
        <div id="export-validation" class="validation-panel" hidden></div>
        <label class="modal-field">Filename
          <input type="text" id="export-filename" value="layout-export.json">
        </label>
        <label class="modal-field modal-field-inline">
          <input type="checkbox" id="export-preview"> Include preview image (current view)
        </label>
        <p id="export-summary" class="export-summary" hidden></p>
        <div class="modal-actions">
          <button id="export-cancel-btn" type="button">Cancel</button>
          <button id="export-confirm-btn" type="button">Export</button>
        </div>
      </div>
    </div>
  `;

  const project = createProject({ width: 120, height: 80 });
  // Undo/Redo buttons follow the stacks on their own - see History's onChange.
  const history = new History(project, { onChange: () => updateHistoryUI() });

  // The manifest loads once, before anything that reads it is built
  // (CLAUDE.md: no live reload) - so it is a constructor argument everywhere.
  const paletteEl = app.querySelector('#palette');
  let manifest = null;
  let manifestError = null;
  try {
    manifest = await loadManifest();
  } catch (err) {
    manifestError = err;
  }

  const canvasEl = app.querySelector('#canvas');
  // Scatter preview points (model-side, not saved or undone): the renderer
  // draws them and the inspector's Flatten places exactly them.
  const scatterPreview = new ScatterPreview();
  const renderer = new CanvasRenderer(canvasEl, project, manifest, { scatterPreview });

  const draw = () => renderer.render();
  const resizeAndDraw = () => {
    renderer.resize();
    renderer.render();
  };

  let activeTool = 'place';
  let palette = null;

  // Every tool records its own undo steps (FR-16) into the shared history.
  // Changes made while a canvas pointermove is being handled (drags, the
  // road draft's rubber band, marquee) are coalesced into at most one
  // refresh per animation frame - several pointermoves can arrive in one
  // frame, and each full refresh redraws everything. Every other change
  // (clicks, keys, buttons, inspector edits) refreshes synchronously, so
  // nothing can act on stale selections or a stale inspector in between.
  let pointerMoveDepth = 0;
  const onChange = () => (pointerMoveDepth > 0 ? scheduleRefresh() : refreshAll());
  const coalesceRefresh = (fn) => {
    pointerMoveDepth += 1;
    try { fn(); } finally { pointerMoveDepth -= 1; }
  };
  const placeTool = new PlaceTool(project, { onChange, history });
  const roadTool = new RoadTool(project, { onChange, history });
  const selectTool = new SelectTool(project, history, { onChange, manifest });
  const scatterTool = new ScatterTool(project, { onChange, history });
  // Canvas input goes to the active tool through the shared interface in
  // tools/tool.js - see wireCanvas and the keydown handler below.
  const tools = {
    place: placeTool, road: roadTool, select: selectTool, scatter: scatterTool,
  };

  // --- Manifest -> palette (FR-11, FR-29) ---
  if (manifest) {
    palette = new PalettePanel(paletteEl, manifest, {
      // One palette selection drives both: what Place puts down, and what
      // Scatter scatters (its category + variant, FR-17).
      onSelect: (asset) => {
        placeTool.setAsset(asset);
        scatterTool.setAsset(asset);
        refreshAll();
      },
    });
    palette.render();
  } else {
    paletteEl.innerHTML = `<h2 class="panel-title">Palette</h2>
      <p class="palette-empty">Could not load asset manifest:<br>${escapeHtml(String(manifestError.message || manifestError))}</p>`;
  }

  // --- Layers (FR-19) ---
  const layersPanel = new LayersPanel(app.querySelector('#layers'), { project }, {
    onChange: () => {
      // Hiding or locking a layer must also drop anything selected on it -
      // otherwise the inspector keeps offering to edit a locked entity.
      selectTool.pruneToSelectable();
      refreshAll();
    },
  });
  layersPanel.render();

  const inspectorPanel = new InspectorPanel(app.querySelector('#inspector'), {
    project, history, manifest, scatterPreview,
  }, {
    onChange,
    // Flatten selects the instances it created (only reachable from the
    // select tool, the one tool whose inspector shows a scatter region).
    onSelect: (ids) => selectTool.selectMany(ids),
  });

  // --- Canvas / site size (FR-2) ---
  const canvasSizeDialog = new CanvasSizeDialog({
    overlayEl: app.querySelector('#canvas-size-overlay'),
    widthInput: app.querySelector('#canvas-width'),
    heightInput: app.querySelector('#canvas-height'),
    warningEl: app.querySelector('#canvas-size-warning'),
    cancelBtn: app.querySelector('#canvas-size-cancel'),
    confirmBtn: app.querySelector('#canvas-size-confirm'),
  }, { project }, {
    // Resize + the drops it causes are one undo step - a mis-shrink is
    // recoverable with a single Ctrl+Z rather than per dropped entity.
    onApply: (width, height) => {
      history.record(() => project.resizeCanvas(width, height));
      renderer.fitToView();
      refreshAll();
    },
  });
  app.querySelector('#canvas-size-btn').addEventListener('click', () => canvasSizeDialog.open());

  // --- Keyboard shortcut reference (FR-32) ---
  const shortcutsDialog = new ShortcutsDialog({
    overlayEl: app.querySelector('#shortcuts-overlay'),
    closeBtn: app.querySelector('#shortcuts-close-btn'),
    listEl: app.querySelector('#shortcuts-list'),
  });
  app.querySelector('#shortcuts-btn').addEventListener('click', () => shortcutsDialog.toggle());

  // --- Export dialog (FR-25, FR-26, FR-27) ---
  const exportDialog = new ExportDialog({
    overlayEl: app.querySelector('#export-overlay'),
    filenameInput: app.querySelector('#export-filename'),
    previewCheckbox: app.querySelector('#export-preview'),
    cancelBtn: app.querySelector('#export-cancel-btn'),
    confirmBtn: app.querySelector('#export-confirm-btn'),
    summaryEl: app.querySelector('#export-summary'),
    validationEl: app.querySelector('#export-validation'),
  }, { project, manifest, canvasEl });
  app.querySelector('#export-open-btn').addEventListener('click', () => exportDialog.open());

  // --- Save/load project (FR-23) - explicit file only, no autosave/crash
  // recovery (locked-in decision, CLAUDE.md). Different format from the
  // export above - see src/io/projectFile.js. ---
  const saveBtn = app.querySelector('#save-project-btn');
  saveBtn.addEventListener('click', () => {
    try {
      downloadProjectFile(project, undefined, { manifest });
    } catch (err) {
      window.alert(`Could not save the project: ${err.message || err}`);
    }
  });
  const loadInput = app.querySelector('#load-project-input');
  app.querySelector('#load-project-btn').addEventListener('click', () => loadInput.click());
  loadInput.addEventListener('change', async () => {
    const [file] = loadInput.files;
    loadInput.value = ''; // allow re-selecting the same file next time
    if (!file) return;
    try {
      await loadProjectFileInto(project, file);
    } catch (err) {
      if (err instanceof ProjectFileError) {
        window.alert(`Could not load project file:\n\n${err.message}`);
        return;
      }
      throw err;
    }
    history.clear(); // the loaded state has no meaningful undo history of its own
    scatterPreview.clear(); // loaded regions get their own fresh preview patterns
    exportDialog.close();
    renderer.fitToView();
    refreshAll();
  });
  const dialogs = [exportDialog, shortcutsDialog, canvasSizeDialog];
  const dialogOpen = () => dialogs.some((d) => d.isOpen);

  // --- Toolbar: grid controls (FR-3) + fit to view (FR-4) ---
  const gridSizeSel = app.querySelector('#grid-size');
  gridSizeSel.innerHTML = GRID_SIZES.map(
    (m) => `<option value="${m}"${m === project.grid.size ? ' selected' : ''}>${m} m</option>`,
  ).join('');
  gridSizeSel.addEventListener('change', () => {
    project.setGridSize(Number(gridSizeSel.value));
    draw();
  });
  app.querySelector('#grid-visible').addEventListener('change', (e) => {
    project.setGridVisible(e.target.checked);
    draw();
  });
  app.querySelector('#grid-snap').addEventListener('change', (e) => {
    project.setGridSnap(e.target.checked);
  });
  app.querySelector('#fit-view').addEventListener('click', () => {
    renderer.fitToView();
    draw();
  });

  // --- Toolbar: tool switch (Place / Road / Select / Scatter) ---
  const toolPlaceBtn = app.querySelector('#tool-place');
  const toolRoadBtn = app.querySelector('#tool-road');
  const toolSelectBtn = app.querySelector('#tool-select');
  const toolScatterBtn = app.querySelector('#tool-scatter');
  const roadControls = app.querySelector('#road-controls');
  const selectControls = app.querySelector('#select-controls');
  const scatterControls = app.querySelector('#scatter-controls');

  function setActiveTool(tool) {
    // Scatter needs a people/vehicles asset from the palette - the button is
    // greyed out without one, and the hotkey must not get around that.
    if (tool === 'scatter' && !scatterTool.armed) return;
    activeTool = tool;
    toolPlaceBtn.setAttribute('aria-pressed', String(tool === 'place'));
    toolRoadBtn.setAttribute('aria-pressed', String(tool === 'road'));
    toolSelectBtn.setAttribute('aria-pressed', String(tool === 'select'));
    toolScatterBtn.setAttribute('aria-pressed', String(tool === 'scatter'));
    // Road mode takes over the left panel: the asset palette has nothing to
    // offer while drawing/editing a path (roads aren't placed from it), so
    // the road options stand in its place rather than crowding the toolbar.
    roadControls.hidden = tool !== 'road';
    paletteEl.hidden = tool === 'road';
    selectControls.hidden = tool !== 'select';
    scatterControls.hidden = tool !== 'scatter';

    // Place and Scatter share the palette selection; the other tools have no
    // use for it.
    if (tool === 'road' || tool === 'select') { placeTool.setAsset(null); if (palette) palette.select(null); }
    if (tool !== 'road') { roadTool.cancelDraft(); roadTool.clearSelection(); roadTool.clearMergeCandidates(); }
    if (tool !== 'select') selectTool.clear();
    if (tool !== 'scatter') scatterTool.cancelDraft();

    refreshAll();
  }
  toolPlaceBtn.addEventListener('click', () => setActiveTool('place'));
  toolRoadBtn.addEventListener('click', () => setActiveTool('road'));
  toolSelectBtn.addEventListener('click', () => setActiveTool('select'));
  toolScatterBtn.addEventListener('click', () => setActiveTool('scatter'));

  // --- Toolbar: road tool controls (FR-5, FR-6, FR-9) ---
  const roadModeDrawBtn = app.querySelector('#road-mode-draw');
  const roadModeEditBtn = app.querySelector('#road-mode-edit');
  const roadWidthInput = app.querySelector('#road-width');
  const roadDrawGroup = app.querySelector('#road-draw-group');
  const toolStatusEl = app.querySelector('#tool-status');
  const btnFinish = app.querySelector('#road-finish');
  const btnCancel = app.querySelector('#road-cancel');
  const btnSplit = app.querySelector('#road-split');
  const btnDelSeg = app.querySelector('#road-delete-segment');
  const btnDelRoad = app.querySelector('#road-delete-road');
  const btnMerge = app.querySelector('#road-merge');
  const btnClose = app.querySelector('#road-close');

  roadModeDrawBtn.addEventListener('click', () => roadTool.setMode('draw'));
  roadModeEditBtn.addEventListener('click', () => roadTool.setMode('edit'));
  roadWidthInput.addEventListener('change', () => {
    roadTool.setWidth(Number(roadWidthInput.value) || 6);
  });
  // Each of these is one undo step, recorded by roadTool itself (FR-16).
  btnFinish.addEventListener('click', () => roadTool.finishDraft());
  btnCancel.addEventListener('click', () => roadTool.cancelDraft());
  btnSplit.addEventListener('click', () => roadTool.splitAtSelection());
  btnDelSeg.addEventListener('click', () => roadTool.deleteSelectedSegment());
  btnDelRoad.addEventListener('click', () => roadTool.deleteSelectedRoad());
  btnMerge.addEventListener('click', () => roadTool.mergeCandidatesNow());
  btnClose.addEventListener('click', () => roadTool.closeSelectedRoad());

  // --- Toolbar: scatter tool controls (FR-17) ---
  const scatterCountInput = app.querySelector('#scatter-count');
  scatterCountInput.addEventListener('change', () => {
    const v = Math.max(0, Math.round(Number(scatterCountInput.value)));
    scatterTool.setCount(v);
    scatterCountInput.value = v;
  });

  // --- Toolbar: select tool controls (FR-14, FR-15) ---
  const btnCopy = app.querySelector('#select-copy');
  const btnPaste = app.querySelector('#select-paste');
  const btnDuplicate = app.querySelector('#select-duplicate');
  const btnDelete = app.querySelector('#select-delete');
  btnCopy.addEventListener('click', () => selectTool.copySelection());
  btnPaste.addEventListener('click', () => selectTool.pasteClipboard());
  btnDuplicate.addEventListener('click', () => selectTool.duplicateSelection());
  btnDelete.addEventListener('click', () => selectTool.deleteSelection());

  // --- Toolbar: undo/redo (FR-16) ---
  const btnUndo = app.querySelector('#undo-btn');
  const btnRedo = app.querySelector('#redo-btn');
  function doUndo() {
    if (history.undo()) refreshAll();
  }
  function doRedo() {
    if (history.redo()) refreshAll();
  }
  btnUndo.addEventListener('click', doUndo);
  btnRedo.addEventListener('click', doRedo);

  // --- One place that keeps every panel/overlay/button in sync (FR-13,
  // FR-14, FR-16) - called after any project mutation from any source
  // (a tool's own onChange, the inspector panel, undo/redo, load). ---
  //
  // It first drops tool selections whose ids no longer exist: undo/redo,
  // load, a canvas shrink or an inspector delete can remove entities behind
  // a tool's back, and split/merge replace roads with new ids. A prune that
  // changes something fires the tool's onChange - i.e. refreshAll again -
  // which the `refreshing` guard absorbs, since this pass redraws anyway.
  let refreshing = false;
  let refreshQueued = false;
  function scheduleRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => { if (refreshQueued) refreshAll(); });
  }
  function refreshAll() {
    refreshQueued = false; // a synchronous refresh covers any queued one
    if (refreshing) return;
    refreshing = true;
    try {
      selectTool.pruneToExisting();
      roadTool.pruneToExisting();
      refreshView();
    } finally {
      refreshing = false;
    }
  }

  function refreshView() {
    renderer.setOverlay({ ...roadTool.overlay(), active: activeTool === 'road' });
    renderer.setSelectionOverlay(selectTool.overlay());
    renderer.setScatterOverlay(scatterTool.overlay());
    draw();
    toolStatusEl.textContent = tools[activeTool].statusText();
    updateRoadUI();
    updateSelectUI();
    updateScatterUI();
    updateHistoryUI();
    updateRoadDraftLock();
    // Rebuilding the inspector mid-gesture only shows numbers that change
    // again next frame - it catches up once, when the gesture ends (see
    // wireCanvas's pointerup).
    if (!gestureInProgress()) refreshInspector();
  }

  function gestureInProgress() {
    return Object.values(tools).some((t) => t.gestureActive);
  }

  // While a road path is being drawn, everything that would switch tool/mode,
  // mutate the project some other way, or swap it out (undo/redo, save/load/
  // export, palette) is greyed out until Finish or Cancel. Still available:
  // Finish/Cancel, the road width, and the view/snap aids (grid, snap, fit,
  // pan/zoom), which only affect how the path is being drawn.
  const toolbarEl = app.querySelector('#toolbar');
  const lockedDuringRoadDraft = [
    toolPlaceBtn, toolRoadBtn, toolSelectBtn, toolScatterBtn,
    roadModeDrawBtn, roadModeEditBtn,
    app.querySelector('#save-project-btn'),
    app.querySelector('#load-project-btn'),
    app.querySelector('#export-open-btn'),
    app.querySelector('#canvas-size-btn'),
  ];
  function updateRoadDraftLock() {
    const locked = roadTool.drafting;
    for (const btn of lockedDuringRoadDraft) btn.disabled = locked;
    // Scatter additionally waits for a people/vehicles palette selection
    // (never greyed out while it is the active tool - see updateScatterUI).
    if (!scatterTool.armed && activeTool !== 'scatter') toolScatterBtn.disabled = true;
    if (palette) palette.setDisabled(locked);
    toolbarEl.classList.toggle('road-drafting', locked);
  }

  function refreshInspector() {
    let ids = [];
    if (activeTool === 'select') {
      ids = [...selectTool.selectedIds];
    } else if (activeTool === 'road' && roadTool.mode === 'edit' && roadTool.selection) {
      ids = [roadTool.selection.roadId];
    }
    inspectorPanel.render(ids);
  }

  // Undo/redo are also locked while a road path is being drawn (see
  // updateRoadDraftLock) - Finish or Cancel first.
  function updateHistoryUI() {
    btnUndo.disabled = roadTool.drafting || !history.canUndo;
    btnRedo.disabled = roadTool.drafting || !history.canRedo;
  }

  function updateSelectUI() {
    btnPaste.disabled = !selectTool.hasClipboard;
    btnDuplicate.disabled = selectTool.count === 0;
    btnDelete.disabled = selectTool.count === 0;
  }

  function updateScatterUI() {
    toolScatterBtn.title = scatterTool.armed || activeTool === 'scatter'
      ? 'Scatter the selected palette asset over an area'
      : 'Select a People or Vehicles asset in the palette to scatter it';
  }

  function updateRoadUI() {
    roadModeDrawBtn.setAttribute('aria-pressed', String(roadTool.mode === 'draw'));
    roadModeEditBtn.setAttribute('aria-pressed', String(roadTool.mode === 'edit'));
    // Draw-only controls. In Edit mode the width that matters is the SELECTED
    // road's, which the inspector owns (FR-6, per-path) - showing this draft
    // width beside it just offers two different "Width (m)" fields. Finish and
    // Cancel act on an in-progress draft, which only Draw mode can have.
    roadDrawGroup.hidden = roadTool.mode === 'edit';
    const sel = roadTool.selection;
    btnSplit.disabled = !(sel && sel.kind === 'point');
    btnDelSeg.disabled = !(sel && sel.kind === 'segment');
    btnDelRoad.disabled = !sel;
    btnMerge.disabled = roadTool.mergeCandidates.length !== 2;
    const selRoad = sel && project.roads.find((r) => r.id === sel.roadId);
    btnClose.disabled = !(selRoad && selRoad.points.length >= 3 && !isClosedRoad(selRoad));
    btnFinish.disabled = roadTool.draftPoints.length < 2;
    btnCancel.disabled = !roadTool.drafting;
  }
  refreshAll();

  // --- Keyboard (FR-32, FR-16, FR-4): one dispatch path. Global keys first
  // - dialogs, the shortcut reference, tool switching, undo/redo, fit view -
  // then whatever is left goes to the active tool (tools/tool.js onKeyDown).
  let spaceDown = false; // Space held = drag to pan (see wireCanvas)
  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'Space') spaceDown = true;
    // Escape closes an open dialog - and only that, not also whatever Escape
    // means for the active tool.
    if (ev.key === 'Escape' && dialogOpen()) {
      ev.preventDefault();
      for (const d of dialogs) d.close();
      return;
    }
    if (isTyping(ev.target)) return;
    if (ev.key === '?') { // FR-32: the reference is reachable by key, not just the toolbar
      ev.preventDefault();
      shortcutsDialog.toggle();
      return;
    }
    if (dialogOpen()) return; // an open dialog owns the keyboard

    // Tool switching. Locked mid-draft for the same reason the tool buttons
    // are - see updateRoadDraftLock.
    const toolName = TOOL_KEYS[ev.key];
    if (toolName && !roadTool.drafting) {
      ev.preventDefault();
      setActiveTool(toolName);
      return;
    }

    const mod = ev.ctrlKey || ev.metaKey;
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key; // 'Z' with Shift held -> 'z'
    if (mod && (key === 'z' || key === 'y')) {
      ev.preventDefault();
      // Locked while a road path is being drawn - Finish or Cancel first
      // (see updateRoadDraftLock).
      if (roadTool.drafting) return;
      if (key === 'z' && !ev.shiftKey) doUndo();
      else doRedo();
      return;
    }
    if (key === 'f') {
      renderer.fitToView();
      draw();
      return;
    }

    if (tools[activeTool].onKeyDown({ key, shiftKey: ev.shiftKey, mod })) ev.preventDefault();
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.code === 'Space') spaceDown = false;
  });

  // --- Canvas interaction: pan/zoom (FR-4); everything else goes to the
  // active tool ---
  wireCanvas({
    canvasEl,
    renderer,
    getActiveTool: () => tools[activeTool],
    isSpaceDown: () => spaceDown,
    refreshAll,
    coalesceRefresh,
    gestureInProgress,
    readoutEl: app.querySelector('#readout'),
    draw,
  });

  // --- Sizing ---
  window.addEventListener('resize', resizeAndDraw);
  if (window.ResizeObserver) {
    new ResizeObserver(resizeAndDraw).observe(canvasEl.parentElement);
  }
  resizeAndDraw();
}

// Canvas pointer input. main.js keeps only panning (middle button, or Space
// + drag) and wheel zoom; every other gesture goes to the active tool as
// world coordinates (tools/tool.js). A tool that takes a press (returns true
// from onPointerDown) owns the pointer until release, even if the active
// tool changes mid-drag.
function wireCanvas({
  canvasEl, renderer, getActiveTool, isSpaceDown, refreshAll, coalesceRefresh, gestureInProgress, readoutEl, draw,
}) {
  let panning = false;
  let last = null;
  let movedWhilePanning = false;
  let captureTool = null; // the tool whose gesture owns the pointer

  const localPoint = (ev) => {
    const rect = canvasEl.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  const toolInput = (ev) => {
    const p = localPoint(ev);
    const w = renderer.screenToWorld(p.x, p.y);
    return {
      x: w.x,
      y: w.y,
      button: ev.button,
      shiftKey: ev.shiftKey,
      mod: ev.ctrlKey || ev.metaKey,
      hitRadius: HIT_RADIUS_PX / renderer.camera.scale,
    };
  };

  const releasePointer = (ev) => {
    try { canvasEl.releasePointerCapture(ev.pointerId); } catch { /* not captured */ }
  };

  // Scroll to zoom, about the cursor.
  canvasEl.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const { x, y } = localPoint(ev);
    const factor = Math.exp(-ev.deltaY * 0.0015);
    renderer.zoomAt(x, y, factor);
    draw();
    updateReadout(ev);
  }, { passive: false });

  canvasEl.addEventListener('pointerdown', (ev) => {
    if (ev.button === 1 || (ev.button === 0 && isSpaceDown())) {
      panning = true;
      last = localPoint(ev);
      canvasEl.classList.add('panning');
      canvasEl.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0) return;
    movedWhilePanning = false;
    const tool = getActiveTool();
    if (tool.onPointerDown(toolInput(ev))) {
      captureTool = tool;
      canvasEl.setPointerCapture(ev.pointerId);
    }
  });

  canvasEl.addEventListener('pointermove', (ev) => coalesceRefresh(() => {
    if (panning && last) {
      const p = localPoint(ev);
      renderer.panBy(p.x - last.x, p.y - last.y);
      last = p;
      movedWhilePanning = true;
      draw();
    } else {
      (captureTool || getActiveTool()).onPointerMove(toolInput(ev));
    }
    updateReadout(ev);
  }));

  // Ends whichever gesture is in progress. Each tool commits its own undo
  // step for the gesture (FR-16).
  const endGesture = (ev) => {
    const hadGesture = gestureInProgress();
    if (panning) {
      panning = false;
      last = null;
      canvasEl.classList.remove('panning');
    }
    if (captureTool) {
      const tool = captureTool;
      captureTool = null;
      tool.onPointerUp(toolInput(ev));
    }
    releasePointer(ev);
    // One synchronous refresh as the gesture ends: flushes any refresh still
    // queued for the next frame and brings the inspector back up to date.
    if (hadGesture) refreshAll();
  };
  canvasEl.addEventListener('pointerup', endGesture);
  canvasEl.addEventListener('pointercancel', endGesture);

  canvasEl.addEventListener('click', (ev) => {
    if (movedWhilePanning) { movedWhilePanning = false; return; }
    getActiveTool().onClick(toolInput(ev));
  });

  canvasEl.addEventListener('dblclick', (ev) => {
    if (getActiveTool().onDoubleClick(toolInput(ev))) ev.preventDefault();
  });

  canvasEl.addEventListener('pointerleave', () => {
    readoutEl.textContent = '—';
  });

  function updateReadout(ev) {
    const { x, y } = localPoint(ev);
    const w = renderer.screenToWorld(x, y);
    readoutEl.textContent = `x ${w.x.toFixed(2)} m   y ${w.y.toFixed(2)} m`;
  }
}

function isTyping(node) {
  return node && (node.tagName === 'INPUT' || node.tagName === 'SELECT' || node.tagName === 'TEXTAREA');
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

main();
