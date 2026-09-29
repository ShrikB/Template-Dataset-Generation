// Select tool (FR-14, FR-15).
//
// Canvas interaction -> model mutation, same shape as placeTool.js /
// roadTool.js: works entirely in world coordinates (meters), screen<->world
// conversion happens at the call site (main.js). Owns a general-purpose,
// mixed-type entity selection (building/prop/road/scatterRegion ids) - this
// is a different, coarser concept than roadTool's own point/segment
// selection, which stays scoped to path-editing gestures inside Road+Edit
// mode. Scatter regions (M5, FR-17) are a plain entity like any other here
// - scatterTool.js only draws new ones; selecting/moving/deleting/editing
// an existing one is entirely this tool + the inspector panel, no parallel
// system.
//
// Continuous canvas gestures (drag-to-move, the rotation drag-handle) call
// history.begin()/commit() directly here, collapsing many per-tick
// mutations into one undo step (FR-16). Atomic inspector-panel edits go
// through src/tools/inspectorActions.js instead - see that file.

import {
  distanceToSegment, distanceToRotatedRect, rotatedRectCorners, snapPoint, distanceSegmentToRect,
} from '../utils/geometry.js';
import { categoryOf, cloneEntity, entityFootprint } from '../model/entityTypes.js';
import { regionCorners } from '../model/entities/scatterRegion.js';
import { Tool } from './tool.js';

const DUPLICATE_OFFSET = 2; // meters - FR-15 "duplicate with small offset"
const ROTATE_HANDLE_DISTANCE_M = 4; // beyond a building's footprint edge, or from a prop's center

export class SelectTool extends Tool {
  constructor(project, history, { onChange, manifest = null } = {}) {
    super();
    this.project = project;
    this.history = history;
    this.onChange = onChange || (() => {});
    this.manifest = manifest; // building footprints (hit-test/marquee/rotate handle)
    this.selectedIds = new Set();
    this.marquee = null; // { x0, y0, x1, y1 } in world coords, while marquee-dragging
    this.moving = false; // bulk move-drag in progress
    this.rotatingId = null; // entity id while the rotation drag-handle is in use
    this._clipboard = null; // [{...entity}] deep-cloned snapshot from copySelection()
    this._pasteCount = 0;
    this._moveAnchor = null; // grid-snap reference for the open move drag - see beginMove()
    this._lastMovePoint = null; // last world point of the open move drag (pointer input)
    this._marqueeAdditive = false; // the open marquee was started with Shift held
  }

  // --- pointer / keyboard input (see tool.js) ---------------------------------

  /**
   * Press: grab the rotate handle, or select + start moving the entity under
   * the cursor (Shift toggles it in/out of the selection instead), or start a
   * marquee on empty canvas (Shift keeps the current selection).
   */
  onPointerDown({
    x, y, hitRadius, shiftKey,
  }) {
    if (this.canDragRotate && this.hitTestRotateHandle(x, y, hitRadius)) {
      this.beginRotateDrag();
      return true;
    }
    const hit = this.hitTest(x, y, hitRadius);
    if (hit) {
      if (shiftKey) {
        this.toggle(hit.id);
        return false;
      }
      if (!this.isSelected(hit.id)) this.selectOnly(hit.id);
      this._lastMovePoint = { x, y };
      this.beginMove(hit.id); // grabbed entity = the grid-snap anchor (FR-3)
      return true;
    }
    this._marqueeAdditive = shiftKey;
    this.beginMarquee(x, y);
    return true;
  }

  onPointerMove({ x, y }) {
    if (this.moving) {
      if (this._lastMovePoint) this.moveBy(x - this._lastMovePoint.x, y - this._lastMovePoint.y);
      this._lastMovePoint = { x, y };
    } else if (this.rotatingId) {
      this.rotateDragTo(x, y);
    } else if (this.marqueeing) {
      this.updateMarquee(x, y);
    }
  }

  /** Release: each gesture commits its own undo step (FR-16). */
  onPointerUp() {
    if (this.moving) {
      this.endMove();
      this._lastMovePoint = null;
    }
    if (this.rotatingId) this.endRotateDrag();
    if (this.marqueeing) this.endMarquee({ additive: this._marqueeAdditive });
  }

  /** Ctrl+C/V/D, Del/Backspace, [ ], Esc (FR-14, FR-15, FR-32). */
  onKeyDown({ key, mod }) {
    if (mod && key === 'c') this.copySelection();
    else if (mod && key === 'v') this.pasteClipboard();
    else if (mod && key === 'd') this.duplicateSelection();
    else if (key === 'Delete' || key === 'Backspace') this.deleteSelection();
    else if (key === '[' || key === ']') this.rotateSelectionBy(key === '[' ? -15 : 15); // quick bulk-rotate, FR-14
    else if (key === 'Escape') this.clear();
    else return false;
    return true;
  }

  get gestureActive() {
    return this.moving || this.rotatingId !== null || this.marqueeing;
  }

  statusText() {
    return this.count === 0
      ? 'Click to select · drag for marquee · shift-click to add'
      : `${this.count} selected — drag to move${this.canDragRotate ? ' · drag the yellow handle to rotate' : ''} · [ ] to rotate · Del to delete · Ctrl+C/V/D to copy/paste/duplicate`;
  }

  // --- selection state -----------------------------------------------------

  get selection() {
    return [...this.selectedIds].map((id) => this.project.getEntity(id)).filter(Boolean);
  }

  get count() {
    return this.selectedIds.size;
  }

  isSelected(id) {
    return this.selectedIds.has(id);
  }

  /** Select exactly one entity, or pass null to clear. */
  selectOnly(id) {
    this.selectMany(id ? [id] : []);
  }

  /** Replace the selection with exactly these ids (e.g. a flatten's new instances). */
  selectMany(ids) {
    this.selectedIds = new Set(ids);
    this.onChange();
  }

  /** Shift-click: add/remove one entity from the current selection. */
  toggle(id) {
    if (this.selectedIds.has(id)) this.selectedIds.delete(id);
    else this.selectedIds.add(id);
    this.onChange();
  }

  clear() {
    if (this.selectedIds.size === 0) return;
    this.selectedIds = new Set();
    this.onChange();
  }

  /** Drop any selected ids that no longer exist (e.g. after undo/redo). */
  pruneToExisting() {
    const before = this.selectedIds.size;
    // project.getEntity(id) rebuilds allEntities() per call - build the
    // valid-id set once instead of once per selected id (this used to be
    // O(selection size x project size), the dominant cost of an undo/redo
    // when a large selection was active).
    const validIds = new Set(this.project.allEntities().map((e) => e.id));
    this.selectedIds = new Set([...this.selectedIds].filter((id) => validIds.has(id)));
    if (this.selectedIds.size !== before) this.onChange();
  }

  /**
   * Drop any selected entity whose layer is now hidden or locked (FR-19).
   * Hit-testing already refuses those, so without this a selection made
   * before the toggle would stay live in the inspector and stay editable -
   * which is exactly what "lock-from-editing" is meant to prevent.
   */
  pruneToSelectable() {
    const before = this.selectedIds.size;
    const selectable = new Set(
      this.project.allEntities().filter((e) => this._isSelectable(e)).map((e) => e.id),
    );
    this.selectedIds = new Set([...this.selectedIds].filter((id) => selectable.has(id)));
    if (this.selectedIds.size !== before) this.onChange();
  }

  // --- hit testing -----------------------------------------------------------

  /** Nearest selectable entity to a world point within `maxDist`, or null. */
  hitTest(x, y, maxDist) {
    let best = null;
    for (const entity of this.project.allEntities()) {
      if (!this._isSelectable(entity)) continue;
      const d = this._distanceTo(entity, x, y);
      if (d <= maxDist && (!best || d < best.dist)) best = { id: entity.id, dist: d };
    }
    return best;
  }

  _distanceTo(entity, x, y) {
    if (entity.type === 'road') {
      let min = Infinity;
      for (let i = 0; i < entity.points.length - 1; i++) {
        const a = entity.points[i];
        const b = entity.points[i + 1];
        min = Math.min(min, distanceToSegment(x, y, a.x, a.y, b.x, b.y));
      }
      return min;
    }
    if (entity.type === 'scatterRegion') {
      // 0 anywhere inside the rect (click-to-select the whole region, not
      // just near an edge); outside, distance to the nearest edge/corner -
      // same forgiveness near the boundary as every other entity's hit
      // radius.
      const dx = Math.max(entity.x - x, 0, x - (entity.x + entity.width));
      const dy = Math.max(entity.y - y, 0, y - (entity.y + entity.height));
      return Math.hypot(dx, dy);
    }
    // Buildings and props both carry a real footprint: 0 anywhere inside it,
    // distance to the nearest edge outside, same as a scatter region. A prop's
    // footprint is usually small, so this only ever makes it easier to hit
    // than the old centre-point distance, never harder.
    const footprint = entityFootprint(entity, this.manifest);
    if (footprint) {
      return distanceToRotatedRect(
        x, y, entity.x, entity.y, footprint.width, footprint.depth, entity.rotation,
      );
    }
    return Math.hypot(entity.x - x, entity.y - y);
  }

  _isSelectable(entity) {
    const category = categoryOf(entity);
    return this.project.isLayerVisible(category) && !this.project.isLayerLocked(category);
  }

  // --- marquee select (FR-14) ------------------------------------------------

  get marqueeing() {
    return this.marquee !== null;
  }

  beginMarquee(x, y) {
    this.marquee = {
      x0: x, y0: y, x1: x, y1: y,
    };
    this.onChange();
  }

  updateMarquee(x, y) {
    if (!this.marquee) return;
    this.marquee.x1 = x;
    this.marquee.y1 = y;
    this.onChange();
  }

  /** Finish the marquee drag, selecting everything inside it. */
  endMarquee({ additive = false } = {}) {
    if (!this.marquee) return;
    const {
      x0, y0, x1, y1,
    } = this.marquee;
    this.marquee = null;

    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const rect = {
      x: minX, y: minY, width: maxX - minX, height: maxY - minY,
    };
    const hits = this.project.allEntities().filter((e) => {
      if (!this._isSelectable(e)) return false;
      // A road is caught by any of its segments crossing the marquee, not
      // only by a vertex inside it - a long straight road has no vertex
      // anywhere near most of its length.
      if (e.type === 'road') {
        return e.points.slice(1).some((b, i) => distanceSegmentToRect(e.points[i], b, rect) === 0);
      }
      const points = this._marqueeTestPoints(e);
      return points.some((p) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY);
    });

    this.selectedIds = additive
      ? new Set([...this.selectedIds, ...hits.map((e) => e.id)])
      : new Set(hits.map((e) => e.id));
    this.onChange();
  }

  cancelMarquee() {
    if (!this.marquee) return;
    this.marquee = null;
    this.onChange();
  }

  // --- bulk move (FR-14, drag any selected entity) ---------------------------

  /**
   * Start a move drag. `anchorId` is the entity actually grabbed (main.js
   * passes the hit-tested one) - it becomes the grid-snap reference for the
   * whole gesture, so with snapping on THAT entity lands on grid lines and
   * everything else in the selection keeps its offset from it (FR-3, FR-14).
   * Without an anchor the drag is freeform, as before.
   */
  beginMove(anchorId = null) {
    if (this.selectedIds.size === 0) return;
    this.history.begin();
    this.moving = true;
    this._moveAnchor = this._anchorFor(anchorId);
  }

  /**
   * Apply one tick of a move drag. The raw pointer delta accumulates on the
   * anchor's ORIGINAL position rather than compounding per tick, so snapping
   * quantizes where the anchor is going (not each tiny delta, which would
   * round to nothing and never move) and a snapped drag can't drift.
   */
  moveBy(dx, dy) {
    if (!this.moving) return;
    const anchor = this._moveAnchor;
    let stepX = dx;
    let stepY = dy;

    if (anchor) {
      anchor.dx += dx;
      anchor.dy += dy;
      const { grid } = this.project;
      let targetX = anchor.x + anchor.dx;
      let targetY = anchor.y + anchor.dy;
      if (grid.snap) ({ x: targetX, y: targetY } = snapPoint(targetX, targetY, grid.size));
      const current = anchorPosition(this.project.getEntity(anchor.id));
      if (!current) return;
      stepX = targetX - current.x;
      stepY = targetY - current.y;
    }

    // Snapping holds the selection still for most ticks of a drag - skip the
    // whole mutate-and-redraw pass rather than firing onChange on every one.
    if (stepX === 0 && stepY === 0) return;
    for (const id of this.selectedIds) this.project.moveEntityBy(id, stepX, stepY);
    this.onChange();
  }

  endMove() {
    if (!this.moving) return;
    this.moving = false;
    this._moveAnchor = null;
    this.history.commit();
  }

  /** Capture the grabbed entity's start position as the drag's snap reference. */
  _anchorFor(anchorId) {
    if (!anchorId || !this.selectedIds.has(anchorId)) return null;
    const start = anchorPosition(this.project.getEntity(anchorId));
    if (!start) return null;
    return { id: anchorId, x: start.x, y: start.y, dx: 0, dy: 0 };
  }

  // --- bulk rotate / delete (FR-14) -------------------------------------------

  /** Rotate every selected entity that has a `rotation` field by `deltaDeg`. Roads are skipped. */
  rotateSelectionBy(deltaDeg) {
    const rotatable = this.selection.filter((e) => 'rotation' in e);
    if (rotatable.length === 0) return;
    this.history.record(() => {
      for (const e of rotatable) this.project.rotateEntityBy(e.id, deltaDeg);
    });
    this.onChange();
  }

  /** True if the rotation drag-handle applies (single rotatable entity selected). */
  get canDragRotate() {
    return this.selectedIds.size === 1 && 'rotation' in (this.selection[0] || {});
  }

  /** World position of the rotation drag-handle for the single selected rotatable entity, or null. */
  rotateHandlePosition() {
    if (!this.canDragRotate) return null;
    const e = this.selection[0];
    const rad = (e.rotation * Math.PI) / 180;
    // Just past the footprint's edge along its local x axis, so the handle
    // never sits inside the footprint (where a press means move). Props have
    // a footprint now too, so they get the same clearance as buildings.
    const footprint = entityFootprint(e, this.manifest);
    const dist = (footprint ? footprint.width / 2 : 0) + ROTATE_HANDLE_DISTANCE_M;
    return {
      x: e.x + Math.cos(rad) * dist,
      y: e.y + Math.sin(rad) * dist,
    };
  }

  /** True if a world point is within `maxDist` of the rotation drag-handle. */
  hitTestRotateHandle(x, y, maxDist) {
    const p = this.rotateHandlePosition();
    return p !== null && Math.hypot(p.x - x, p.y - y) <= maxDist;
  }

  beginRotateDrag() {
    if (!this.canDragRotate) return;
    this.history.begin();
    this.rotatingId = this.selection[0].id;
  }

  /** Update rotation to point the handle at a world cursor position. */
  rotateDragTo(x, y) {
    if (!this.rotatingId) return;
    const e = this.project.getEntity(this.rotatingId);
    if (!e) return;
    const deg = (Math.atan2(y - e.y, x - e.x) * 180) / Math.PI;
    this.project.setEntityRotation(e.id, deg);
    this.onChange();
  }

  endRotateDrag() {
    if (!this.rotatingId) return;
    this.rotatingId = null;
    this.history.commit();
  }

  /** Delete every selected entity (FR-14). */
  deleteSelection() {
    if (this.selectedIds.size === 0) return;
    const ids = [...this.selectedIds];
    this.history.record(() => {
      for (const id of ids) this.project.removeEntity(id);
    });
    this.selectedIds = new Set();
    this.onChange();
  }

  // --- copy / paste / duplicate (FR-15) ---------------------------------------

  get hasClipboard() {
    return !!this._clipboard && this._clipboard.length > 0;
  }

  copySelection() {
    const selected = this.selection;
    if (selected.length === 0) return;
    this._clipboard = selected.map(cloneEntity);
    this._pasteCount = 0;
    this.onChange(); // clipboard isn't project state, but the Paste button's enabled-ness depends on it
  }

  /** Paste the clipboard as new entities, offset a little further each repeated paste. */
  pasteClipboard() {
    if (!this.hasClipboard) return [];
    this._pasteCount += 1;
    const offset = DUPLICATE_OFFSET * this._pasteCount;
    const created = this._cloneSelectionLike(this._clipboard, offset, offset);
    if (created.length > 0) {
      this.selectedIds = new Set(created.map((e) => e.id));
      this.onChange();
    }
    return created;
  }

  /** Duplicate the current selection right next to itself, in one action. */
  duplicateSelection() {
    const originals = this.selection;
    if (originals.length === 0) return [];
    const created = this._cloneSelectionLike(originals, DUPLICATE_OFFSET, DUPLICATE_OFFSET);
    if (created.length > 0) {
      this.selectedIds = new Set(created.map((e) => e.id));
      this.onChange();
    }
    return created;
  }

  _cloneSelectionLike(entities, dx, dy) {
    const cloneable = entities.filter((e) => this._isSelectable(e));
    if (cloneable.length === 0) return [];
    return this.history.record(() => cloneable.map((e) => {
      const copy = this.project.addEntity(e.type, e);
      return this.project.moveEntityBy(copy.id, dx, dy);
    }));
  }

  /** Points to test against a marquee rect: a footprint's corners (+ center), a region's corners, or the entity itself. */
  _marqueeTestPoints(entity) {
    const footprint = entityFootprint(entity, this.manifest);
    if (footprint) {
      const { width, depth } = footprint;
      return [entity, ...rotatedRectCorners(entity.x, entity.y, width, depth, entity.rotation)];
    }
    return regionTestPoints(entity);
  }

  /** Snapshot for the renderer overlay - transient tool/view state, not model data. */
  overlay() {
    return {
      selectedIds: [...this.selectedIds],
      marquee: this.marquee,
      rotateHandle: this.rotateHandlePosition(),
    };
  }
}

// The point a grid snap lines up during a move drag. A road has no single
// position (project.setEntityPosition rejects one), so its first path point
// stands in - the same point roadTool snaps when drawing the path.
function anchorPosition(entity) {
  if (!entity) return null;
  if (entity.type === 'road') return entity.points[0] || null;
  return { x: entity.x, y: entity.y };
}

/** Points to test against a marquee rect: a region's 4 corners, or just the entity itself. */
function regionTestPoints(entity) {
  if (entity.type === 'scatterRegion') return regionCorners(entity);
  return [entity];
}
