// Scatter region draw tool (FR-17).
//
// Canvas interaction -> model mutation, same shape as placeTool.js /
// roadTool.js: works entirely in world coordinates (meters), screen<->world
// conversion happens at the call site (main.js).
//
// This tool ONLY draws a new region (drag out a rectangle, release to
// commit) - same drag-two-corners mechanic as selectTool.js's marquee,
// reused here to create instead of select. It deliberately has no "edit
// mode" of its own: once a region exists, it's a plain entity like any
// other (project.js's addScatterRegion puts it in allEntities()), so
// selecting it, dragging it to move, deleting it, and editing its
// category/count/variants/size all go through the *existing* select tool
// (src/tools/selectTool.js) and inspector panel (src/ui/inspectorPanel.js)
// exactly like a building or prop - no parallel selection/edit system.
//
// What gets scattered comes from the palette, same as placeTool: the
// selected asset's category becomes the region's category and the asset
// itself its variant. Only people/vehicles scatter (FR-17) - with anything
// else (or nothing) selected the tool is disarmed and draws nothing.

import { SCATTER_CATEGORIES } from '../model/entities/scatterRegion.js';
import { History } from '../model/history.js';
import { Tool } from './tool.js';

const MIN_REGION_SIZE = 0.5; // meters - guards against an accidental click-with-no-drag
const DEFAULT_COUNT = 10;

export class ScatterTool extends Tool {
  constructor(project, { onChange, history = new History(project) } = {}) {
    super();
    this.project = project;
    this.history = history; // a new region is one undo step (FR-16)
    this.onChange = onChange || (() => {});
    this.asset = null; // the palette's selected manifest asset, when scatterable
    this.count = DEFAULT_COUNT;
    this.drag = null; // { x0, y0, x1, y1 } in world coords, while dragging out a new region
  }

  /**
   * Set the asset to scatter (from the palette selection), or null. An asset
   * outside SCATTER_CATEGORIES disarms the tool rather than being coerced.
   */
  setAsset(asset) {
    this.asset = asset && SCATTER_CATEGORIES.includes(asset.category) ? asset : null;
    if (!this.asset) this.cancelDraft();
  }

  /** True when a scatterable asset is selected, i.e. a region can be drawn. */
  get armed() {
    return this.asset !== null;
  }

  /** The category a new region gets - the selected asset's, or null when disarmed. */
  get category() {
    return this.asset ? this.asset.category : null;
  }

  setCount(count) {
    this.count = count;
  }

  get drafting() {
    return this.drag !== null;
  }

  beginDraft(x, y) {
    if (!this.armed || this.project.isLayerLocked(this.category)) return;
    this.drag = {
      x0: x, y0: y, x1: x, y1: y,
    };
    this.onChange();
  }

  updateDraft(x, y) {
    if (!this.drag) return;
    this.drag.x1 = x;
    this.drag.y1 = y;
    this.onChange();
  }

  cancelDraft() {
    if (!this.drag) return;
    this.drag = null;
    this.onChange();
  }

  /**
   * Commit the dragged rectangle as a new scatter region (FR-17/FR-18: a
   * region + density, not pre-expanded points). Too-small a drag (a stray
   * click) is treated as a no-op, same as roadTool's <2-point draft.
   */
  finishDraft() {
    if (!this.drag) return null;
    const {
      x0, y0, x1, y1,
    } = this.drag;
    this.drag = null;

    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    const width = Math.abs(x1 - x0);
    const height = Math.abs(y1 - y0);
    if (width < MIN_REGION_SIZE || height < MIN_REGION_SIZE) {
      this.onChange();
      return null;
    }

    const region = this.history.record(() => this.project.addScatterRegion({
      category: this.category, x, y, width, height, count: this.count, variantIds: [this.asset.id],
    }));
    this.onChange(region);
    return region;
  }

  // --- pointer / keyboard input (see tool.js) ---------------------------------

  /** Press starts dragging out a region; release commits it (one drag = one region). */
  onPointerDown({ x, y }) {
    this.beginDraft(x, y);
    return true;
  }

  onPointerMove({ x, y }) {
    if (this.drafting) this.updateDraft(x, y);
  }

  onPointerUp() {
    if (this.drafting) this.finishDraft();
  }

  /** Esc abandons the region being dragged out. */
  onKeyDown({ key }) {
    if (key !== 'Escape') return false;
    this.cancelDraft();
    return true;
  }

  get gestureActive() {
    return this.drafting;
  }

  statusText() {
    if (!this.armed) return 'Select a People or Vehicles asset in the palette to scatter it';
    return this.drafting
      ? 'Release to create the region'
      : `Drag to draw a region of ${this.asset.name} (${this.category})`
        + ' · edit/move/delete it via the Select tool afterward';
  }

  /** Snapshot for the renderer overlay - transient tool/view state, not model data. */
  overlay() {
    return { drag: this.drag, category: this.category };
  }
}
