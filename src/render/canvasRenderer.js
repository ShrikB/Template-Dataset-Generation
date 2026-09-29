// Canvas renderer (FR-1, FR-3, FR-4).
//
// Drawing only: reads the project model, never mutates it. The renderer can
// redraw the entire canvas from model state + camera alone at any time — it
// keeps no hidden copy of project state.

import { Camera } from './camera.js';
import { CATEGORY_COLORS } from '../utils/categories.js';
import { drawRoads } from './layers/roadLayer.js';
import { drawSelection } from './layers/selectionLayer.js';
import { drawScatterRegions } from './layers/scatterLayer.js';
import { ScatterPreview } from '../model/scatterPreview.js';
import { entityFootprint } from '../model/entityTypes.js';
import { rotatedRectCorners, roundTo } from '../utils/geometry.js';

const BG = '#1e2127';
const GRID_LINE = '#2b2f38';
const GRID_LINE_MAJOR = '#3a404b';
const SITE_BORDER = '#5a6472';
const RULER_TEXT = '#8a94a3';
const MIN_LABEL_SPACING_PX = 56;
const BUILDING_FILL_ALPHA = 0.55;
// A prop's own footprint is often only a metre or two, so below this on-screen
// size the filled rect is unreadable and the centre marker carries it alone.
const MIN_FOOTPRINT_DRAW_PX = 3;

export class CanvasRenderer {
  // `scatterPreview` is the model-side owner of each scatter region's
  // preview points (model/scatterPreview.js); main.js shares one with the
  // inspector so Flatten places exactly what is drawn.
  constructor(canvasEl, project, manifest = null, { scatterPreview = new ScatterPreview() } = {}) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.project = project;
    // Asset manifest (model data, loaded once at startup) - supplies each
    // building/prop variant's footprint size. Null until loaded / if it failed.
    this.manifest = manifest;
    this.camera = new Camera();
    this._dpr = 1;
    // Transient tool/view state for the active road-editing overlay (draft
    // path, selection, merge candidates) and the select-tool overlay
    // (selected ids, marquee, rotate handle) - not project model data, same
    // category as `camera` (never exported, provided fresh by the active
    // tool on every change).
    this._overlay = null;
    this._selectionOverlay = null;
    this._scatterOverlay = null;
    // Memoizes findJunctions/findDanglingEnds (both O(roads^2), the worse
    // one also O(pointsPerRoad^2)) across renders where the roads haven't
    // actually changed - render() runs on every pan/zoom tick and every
    // undo/redo, so recomputing those unconditionally was the dominant
    // cost of "just redraw the canvas" at NFR-3's upper end. See
    // roadLayer.js's getDerivedRoadData for the invalidation rule.
    this._roadCache = { fingerprint: null, junctions: [], danglingEnds: [] };
    this.scatterPreview = scatterPreview;
  }

  /** Set the road-tool overlay to draw on top of the model (or null to clear it). */
  setOverlay(overlay) {
    this._overlay = overlay;
  }

  /** Set the select-tool overlay to draw on top of the model (or null to clear it). */
  setSelectionOverlay(overlay) {
    this._selectionOverlay = overlay;
  }

  /** Set the scatter-tool overlay (in-progress draft rect) to draw (or null to clear it). */
  setScatterOverlay(overlay) {
    this._scatterOverlay = overlay;
  }

  get viewSize() {
    return { w: this.canvas.clientWidth || 1, h: this.canvas.clientHeight || 1 };
  }

  /** Match the backing store to the element's CSS size and device pixel ratio. */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = this.viewSize;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this._dpr = dpr;
    if (!this.camera.initialised) this.fitToView();
  }

  fitToView() {
    const { w, h } = this.viewSize;
    this.camera.fit(this.project.canvas.width, this.project.canvas.height, w, h);
  }

  screenToWorld(sx, sy) {
    return this.camera.screenToWorld(sx, sy);
  }

  worldToScreen(wx, wy) {
    return this.camera.worldToScreen(wx, wy);
  }

  panBy(dxPx, dyPx) {
    this.camera.panBy(dxPx, dyPx);
  }

  zoomAt(sx, sy, factor) {
    this.camera.zoomAt(sx, sy, factor);
  }

  render() {
    const { ctx } = this;
    const { w, h } = this.viewSize;
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    this._drawGrid(ctx, w, h);
    this._drawSiteBounds(ctx);
    this._drawEntities(ctx);
    this._drawRuler(ctx, w, h);
  }

  // --- pieces --------------------------------------------------------------

  _drawGrid(ctx, w, h) {
    const { grid } = this.project;
    if (!grid.visible) return;
    const step = grid.size;
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(w, h);

    ctx.lineWidth = 1;
    for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
      const sx = Math.round(this.worldToScreen(x, 0).x) + 0.5;
      ctx.strokeStyle = isMajor(x, step) ? GRID_LINE_MAJOR : GRID_LINE;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
      ctx.stroke();
    }
    for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
      const sy = Math.round(this.worldToScreen(0, y).y) + 0.5;
      ctx.strokeStyle = isMajor(y, step) ? GRID_LINE_MAJOR : GRID_LINE;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
      ctx.stroke();
    }
  }

  _drawSiteBounds(ctx) {
    const a = this.worldToScreen(0, 0);
    const b = this.worldToScreen(this.project.canvas.width, this.project.canvas.height);
    ctx.strokeStyle = SITE_BORDER;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }

  _drawEntities(ctx) {
    const { project } = this;
    // Roads under buildings/props for 2D editing clarity (FR-20) - z-order
    // here has no effect on exported data.
    drawRoads(
      ctx,
      (x, y) => this.worldToScreen(x, y),
      this.camera.scale,
      project,
      this._overlay,
      this._roadCache,
      this.manifest, // surface preview colors (FR-8)
    );
    // Scatter region outlines/preview dots under buildings/props too (FR-20
    // z-order is editing clarity only) - a region reads as background area,
    // individually placed objects sit visually on top of it.
    drawScatterRegions(
      ctx,
      (x, y) => this.worldToScreen(x, y),
      project,
      this._scatterOverlay,
      this.scatterPreview,
      this.manifest,
    );
    // Buildings, props, vehicles and people all draw the same way - a
    // footprint rect at their real size plus a centre marker - differing only
    // in category color (FR-33) and the marker: square for buildings.
    for (const category of ['buildings', 'props', 'vehicles', 'people']) {
      if (!project.isLayerVisible(category)) continue;
      const shape = category === 'buildings' ? 'square' : 'circle';
      for (const e of project[category]) this._drawFootprintEntity(ctx, e, CATEGORY_COLORS[category], shape);
    }
    drawSelection(ctx, (x, y) => this.worldToScreen(x, y), project, this._selectionOverlay, this.manifest);
  }

  // Everything with a footprint draws at its real size (variant footprint x
  // scale, or a building's own override), rotated about its position, so a
  // 1 x 4 m bench reads as a bench against a 10 x 20 m house. The centre
  // marker stays: a 0.5 m lamp is sub-pixel at most useful zooms, and every
  // one still needs to be findable and clickable.
  _drawFootprintEntity(ctx, entity, color, markerShape) {
    const { width, depth } = entityFootprint(entity, this.manifest);
    this._fillFootprint(ctx, entity, width, depth, color);
    this._drawMarker(ctx, entity, color, markerShape, 3);
  }

  /** Filled + outlined rotated footprint rect, shared by buildings and props. */
  _fillFootprint(ctx, entity, width, depth, color) {
    if (Math.max(width, depth) * this.camera.scale < MIN_FOOTPRINT_DRAW_PX) return;
    const corners = rotatedRectCorners(entity.x, entity.y, width, depth, entity.rotation)
      .map((p) => this.worldToScreen(p.x, p.y));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.globalAlpha = BUILDING_FILL_ALPHA;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  _drawMarker(ctx, entity, color, shape, r = 6) {
    const { x, y } = this.worldToScreen(entity.x, entity.y);
    ctx.fillStyle = color;
    ctx.strokeStyle = '#0d0f13';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (shape === 'square') {
      ctx.rect(x - r, y - r, r * 2, r * 2);
    } else {
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
  }

  // Meter labels along the top and left edges so real-world scale is always
  // visible (FR-1). Label spacing steps up as you zoom out so labels never
  // collide.
  _drawRuler(ctx, w, h) {
    const step = this.project.grid.size;
    const stepPx = step * this.camera.scale;
    const every = Math.max(1, Math.ceil(MIN_LABEL_SPACING_PX / stepPx));
    const labelStep = step * every;

    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(w, h);

    ctx.fillStyle = RULER_TEXT;
    ctx.font = '10px system-ui, -apple-system, sans-serif';

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    for (let x = Math.ceil(tl.x / labelStep) * labelStep; x <= br.x; x += labelStep) {
      ctx.fillText(`${roundTo(x)} m`, this.worldToScreen(x, 0).x + 3, 3);
    }

    ctx.textBaseline = 'bottom';
    for (let y = Math.ceil(tl.y / labelStep) * labelStep; y <= br.y; y += labelStep) {
      ctx.fillText(`${roundTo(y)} m`, 3, this.worldToScreen(0, y).y - 2);
    }
  }
}

function isMajor(value, step) {
  return Math.abs(Math.round(value / step) % 5) === 0;
}
