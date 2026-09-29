// Road path drawing + editing tool (FR-5, FR-6, FR-9, FR-10).
//
// Canvas interaction -> model mutation, same shape as tools/placeTool.js.
// Works entirely in world coordinates (meters) - screen<->world conversion
// happens at the call site (main.js), same as PlaceTool.
//
// Two modes:
//  - 'draw': click adds points to an in-progress path. The draft is kept as
//    transient tool state, NOT written to the project until finish() commits
//    it - so the model never holds a half-formed (<2 point) road.
//  - 'edit': drag an existing point to reshape it; click a point or segment
//    to select it, then use Split / Delete Segment / Delete Road / Merge.
//
// Every project mutation is one undo step (FR-16), recorded here: atomic
// actions via history.record(), a point drag via begin()/commit().

import { snapPoint, distanceToSegment, closestPointOnSegment } from '../utils/geometry.js';
import { History } from '../model/history.js';
import { Tool } from './tool.js';

const DEFAULT_WIDTH = 6;

export class RoadTool extends Tool {
  constructor(project, { onChange, history = new History(project) } = {}) {
    super();
    this.project = project;
    this.history = history;
    this.onChange = onChange || (() => {});
    this.mode = 'draw';
    this.width = DEFAULT_WIDTH;
    this.draftPoints = [];
    this.draftCursor = null;
    this.selection = null; // { kind: 'point' | 'segment', roadId, index }
    this.mergeCandidates = [];
    this.dragging = null; // { roadId, index }
    // One-line feedback for the status bar when an action was refused (e.g.
    // a merge of roads that don't meet) - transient view state, never model
    // data. Cleared by the next road-tool action.
    this.notice = null;
    // What the current draft cursor snapped onto ('road end' | 'path start'
    // | 'road segment'), for the status bar - null when it didn't.
    this.cursorSnap = null;
  }

  // --- pointer / keyboard input (see tool.js) ---------------------------------

  /** Edit mode: pressing on a path point starts dragging it (FR-9). */
  onPointerDown({ x, y, hitRadius }) {
    if (this.mode !== 'edit') return false;
    const hit = this.hitTestPoint(x, y, hitRadius);
    if (!hit) return false;
    this.beginDragPoint(hit.roadId, hit.index);
    return true;
  }

  /** Drag the grabbed point, or move the draft's rubber band while drawing. */
  onPointerMove({ x, y, hitRadius }) {
    if (this.dragging) this.dragTo(x, y, hitRadius);
    else if (this.mode === 'draw' && this.drafting) this.setDraftCursor(x, y, hitRadius);
  }

  onPointerUp() {
    if (this.dragging) this.endDrag();
  }

  /**
   * Draw mode: add a path point (FR-5). Edit mode: a point press was already
   * handled (selected + drag-armed) on pointer down, so a click only matters
   * with Shift, to mark the road for merging; a segment click selects the
   * segment (Shift: marks the road for merging); empty canvas clears the
   * selection.
   */
  onClick({
    x, y, hitRadius, shiftKey,
  }) {
    if (this.mode === 'draw') {
      this.addDraftPoint(x, y, hitRadius);
      return;
    }
    const pointHit = this.hitTestPoint(x, y, hitRadius);
    if (pointHit) {
      if (shiftKey) this.toggleMergeCandidate(pointHit.roadId);
      return;
    }
    const segHit = this.hitTestSegment(x, y, hitRadius);
    if (segHit) {
      if (shiftKey) this.toggleMergeCandidate(segHit.roadId);
      else this.selectSegment(segHit.roadId, segHit.index);
      return;
    }
    if (!shiftKey) this.clearSelection();
  }

  /** Double-click finishes the path being drawn (FR-5). */
  onDoubleClick() {
    if (this.mode !== 'draw' || !this.drafting) return false;
    this.finishDraftAtDoubleClick();
    return true;
  }

  /** Enter finishes the draft; Esc cancels it / clears the edit selection; M merges. */
  onKeyDown({ key }) {
    if (key === 'Enter' && this.mode === 'draw') {
      this.finishDraft();
    } else if (key === 'Escape') {
      if (this.mode === 'draw') this.cancelDraft();
      else { this.clearSelection(); this.clearMergeCandidates(); }
    } else if (key === 'm' && this.mode === 'edit') {
      this.mergeCandidatesNow();
    } else {
      return false;
    }
    return true;
  }

  get gestureActive() {
    return this.dragging !== null;
  }

  statusText() {
    const parts = [];
    if (this.notice) parts.push(this.notice);
    if (this.drafting) {
      const n = this.draftPoints.length;
      parts.push(n < 2
        ? 'drafting 1 pt — click to add the next point, Esc to cancel'
        : `drafting ${n} pts — Finish (Enter) or Cancel (Esc) to use other tools`);
      if (this.cursorSnap === 'road end') parts.push('snapped to road end');
      if (this.cursorSnap === 'path start') parts.push('snapped to start — click, then Enter to close the loop');
      if (this.cursorSnap === 'road segment') parts.push('snapped onto a road — ending here makes a T-junction');
    }
    if (this.selection) parts.push(`selected ${this.selection.kind} on ${this.selection.roadId}`);
    if (this.mergeCandidates.length > 0) {
      parts.push(`merge candidates: ${this.mergeCandidates.join(', ')} (shift-click a road to pick, M to merge)`);
    }
    if (parts.length === 0) {
      parts.push(
        this.mode === 'draw'
          ? 'Click to draw a road path · double-click or Enter to finish'
          : 'Drag a point to reshape · click a point/segment to select · shift-click 2 roads to merge',
      );
    }
    return parts.join(' · ');
  }

  setMode(mode) {
    this.mode = mode === 'edit' ? 'edit' : 'draw';
    this.draftPoints = [];
    this.draftCursor = null;
    this.selection = null;
    this.mergeCandidates = [];
    this.dragging = null;
    this.notice = null;
    this.onChange();
  }

  setWidth(width) {
    this.width = width;
  }

  // --- draw mode (FR-5) ---------------------------------------------------

  get drafting() {
    return this.draftPoints.length > 0;
  }

  /**
   * `snapRadius` (world meters - the caller's click radius) lets the point
   * land exactly on a nearby road end or on this draft's own start, see
   * _snap().
   */
  addDraftPoint(x, y, snapRadius = 0) {
    if (this.mode !== 'draw' || this.project.isLayerLocked('roads')) return;
    this.draftPoints.push(this._snap(x, y, snapRadius).point);
    this.notice = null;
    this.onChange();
  }

  /**
   * Move the rubber-band preview point. Snapped through the same _snap() as
   * addDraftPoint (FR-3): the preview has to land exactly where the click
   * will, or with snapping on the line follows the raw cursor and then the
   * committed point jumps to the grid somewhere else.
   */
  setDraftCursor(x, y, snapRadius = 0) {
    if (this.mode !== 'draw') return;
    const { point, snappedTo } = this._snap(x, y, snapRadius);
    this.draftCursor = point;
    this.cursorSnap = snappedTo;
    this.onChange();
  }

  cancelDraft() {
    this.draftPoints = [];
    this.draftCursor = null;
    this.cursorSnap = null;
    this.onChange();
  }

  /** Commit the in-progress path as a new road (FR-6: one width per path). */
  finishDraft() {
    if (this.draftPoints.length < 2) {
      this.cancelDraft();
      return null;
    }
    const points = this.draftPoints;
    const road = this.history.record(() => this.project.addRoad({ points, width: this.width }));
    this.draftPoints = [];
    this.draftCursor = null;
    this.cursorSnap = null;
    this.onChange(road);
    return road;
  }

  /**
   * Finish the path from a double-click on the canvas (FR-5), the usual
   * polyline-drawing gesture, alongside the Finish button and Enter.
   *
   * A double-click fires click, click, dblclick - so by the time this runs,
   * the second click has ALREADY landed as a draft point on top of the
   * first. Dropping it is what keeps a double-click-finished road from
   * ending in a zero-length segment.
   */
  finishDraftAtDoubleClick() {
    if (this.mode !== 'draw' || !this.drafting) return null;
    this.draftPoints.pop();
    return this.finishDraft(); // < 2 points left over = nothing worth keeping, cancels
  }

  // --- edit mode (FR-9) ---------------------------------------------------

  /** Nearest path point across all roads within `maxDist` (world units), or null. */
  hitTestPoint(x, y, maxDist) {
    let best = null;
    for (const road of this.project.roads) {
      road.points.forEach((p, index) => {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d <= maxDist && (!best || d < best.dist)) best = { roadId: road.id, index, dist: d };
      });
    }
    return best;
  }

  /** Nearest road segment across all roads within `maxDist` (world units), or null. */
  hitTestSegment(x, y, maxDist) {
    let best = null;
    for (const road of this.project.roads) {
      for (let i = 0; i < road.points.length - 1; i++) {
        const a = road.points[i];
        const b = road.points[i + 1];
        const d = distanceToSegment(x, y, a.x, a.y, b.x, b.y);
        if (d <= maxDist && (!best || d < best.dist)) best = { roadId: road.id, index: i, dist: d };
      }
    }
    return best;
  }

  /** Begin dragging an existing point (also selects it, e.g. for Split). */
  beginDragPoint(roadId, index) {
    if (this.mode !== 'edit' || this.project.isLayerLocked('roads')) return;
    this.history.begin();
    this.dragging = { roadId, index };
    this.selection = { kind: 'point', roadId, index };
    this.onChange();
  }

  dragTo(x, y, snapRadius = 0) {
    if (!this.dragging) return;
    const { roadId, index } = this.dragging;
    const p = this._snap(x, y, snapRadius, this.dragging).point;
    this.project.moveRoadPoint(roadId, index, p.x, p.y);
    this.onChange();
  }

  endDrag() {
    if (!this.dragging) return;
    this.dragging = null;
    this.history.commit();
  }

  selectSegment(roadId, index) {
    this.selection = { kind: 'segment', roadId, index };
    this.onChange();
  }

  clearSelection() {
    this.selection = null;
    this.onChange();
  }

  /**
   * Drop any selection / merge candidate / in-progress drag whose road no
   * longer exists, or whose index no longer addresses a real point or
   * segment. Split and merge replace roads with brand-new ids (FR-9), so an
   * undo/redo or a project load can strand this tool's ids - main.js calls
   * this after each of those, same as selectTool.pruneToExisting().
   */
  pruneToExisting() {
    const roadsById = new Map(this.project.roads.map((r) => [r.id, r]));
    let changed = false;

    if (this.selection && !addressesLivePart(roadsById.get(this.selection.roadId), this.selection)) {
      this.selection = null;
      changed = true;
    }
    if (this.dragging && !roadsById.has(this.dragging.roadId)) {
      this.dragging = null;
      changed = true;
    }
    const liveCandidates = this.mergeCandidates.filter((id) => roadsById.has(id));
    if (liveCandidates.length !== this.mergeCandidates.length) {
      this.mergeCandidates = liveCandidates;
      changed = true;
    }

    if (changed) this.onChange();
  }

  /** Split the selected point's road there (FR-9). No-op if no point selected. */
  splitAtSelection() {
    if (!this.selection || this.selection.kind !== 'point') return null;
    const { roadId, index } = this.selection;
    const result = this.history.record(() => this.project.splitRoad(roadId, index));
    this.selection = null;
    this.onChange(result);
    return result;
  }

  /** Delete the currently selected segment (FR-9). No-op if none selected. */
  deleteSelectedSegment() {
    if (!this.selection || this.selection.kind !== 'segment') return null;
    const { roadId, index } = this.selection;
    const result = this.history.record(() => this.project.deleteRoadSegment(roadId, index));
    this.selection = null;
    this.onChange(result);
    return result;
  }

  /** Delete the whole road the current selection belongs to (FR-9). */
  deleteSelectedRoad() {
    if (!this.selection) return null;
    const { roadId } = this.selection;
    const removed = this.history.record(() => this.project.removeEntity(roadId));
    this.selection = null;
    this.onChange(removed);
    return removed;
  }

  /**
   * Close the selected road into a loop (FR-9). A road that can't be closed
   * (under 3 points, or already a loop) is reported through `notice`.
   */
  closeSelectedRoad() {
    if (!this.selection) return null;
    let road;
    try {
      const { roadId } = this.selection;
      road = this.history.record(() => this.project.closeRoad(roadId));
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      this.notice = `Can't close: ${err.message.replace(/^road: /, '')}`;
      this.onChange();
      return null;
    }
    this.selection = null;
    this.notice = null;
    this.onChange(road);
    return road;
  }

  /** Toggle a road as a merge candidate (keeps at most the 2 most recent). */
  toggleMergeCandidate(roadId) {
    this.notice = null;
    const i = this.mergeCandidates.indexOf(roadId);
    if (i !== -1) {
      this.mergeCandidates.splice(i, 1);
    } else {
      this.mergeCandidates.push(roadId);
      if (this.mergeCandidates.length > 2) this.mergeCandidates.shift();
    }
    this.onChange();
  }

  clearMergeCandidates() {
    this.notice = null;
    this.mergeCandidates = [];
    this.onChange();
  }

  /**
   * Merge the two selected candidate roads (FR-9). Roads only merge end to
   * end at a shared point; anything else (a T, an X, ends that merely look
   * close) is refused by the model - reported through `notice`, with the
   * candidates kept selected so the user can see which pair was refused.
   */
  mergeCandidatesNow() {
    if (this.mergeCandidates.length !== 2) return null;
    const [a, b] = this.mergeCandidates;
    let merged;
    try {
      merged = this.history.record(() => this.project.mergeRoads(a, b));
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      this.notice = "Can't merge: these roads don't share an end point";
      this.onChange();
      return null;
    }
    this.mergeCandidates = [];
    this.notice = null;
    this.onChange(merged);
    return merged;
  }

  /**
   * Where a drawn or dragged point lands. Roads only connect (merge,
   * junctions, dangling-end checks) at points that coincide within
   * CONNECT_EPSILON, which a hand-placed click never hits - so within
   * `snapRadius` the point lands EXACTLY on, in priority order:
   *  1. an existing road end ('road end');
   *  2. while drawing, the draft's own first point once it has 3+ points,
   *     to close a loop ('path start');
   *  3. the nearest point along an existing road's segment ('road
   *     segment') - an end placed there is a T-junction stem, which
   *     findJunctions detects;
   * and otherwise the grid snap applies (FR-3). Within a tier the nearest
   * candidate wins. Returns `{ point, snappedTo }`.
   *
   * `dragging` (`{ roadId, index }`, for a point drag) keeps the point off
   * itself and its own neighbours (that would collapse a segment to zero
   * length) - its road's OTHER end is fair game on a 3+ point road, which
   * closes the loop - and off its own road's segments (a road meeting
   * itself is not a junction).
   */
  _snap(x, y, snapRadius = 0, dragging = null) {
    if (snapRadius > 0) {
      const nearest = (candidates) => {
        let best = null;
        for (const p of candidates) {
          const d = Math.hypot(p.x - x, p.y - y);
          if (d <= snapRadius && (!best || d < best.d)) best = { p, d };
        }
        return best && { point: { x: best.p.x, y: best.p.y } };
      };
      const ownRoad = (road) => dragging && road.id === dragging.roadId;

      const ends = [];
      for (const road of this.project.roads) {
        for (const i of [0, road.points.length - 1]) {
          if (!(ownRoad(road) && Math.abs(i - dragging.index) <= 1)) ends.push(road.points[i]);
        }
      }
      const end = nearest(ends);
      if (end) return { ...end, snappedTo: 'road end' };

      if (this.mode === 'draw' && this.draftPoints.length >= 3) {
        const start = nearest([this.draftPoints[0]]);
        if (start) return { ...start, snappedTo: 'path start' };
      }

      const onSegments = [];
      for (const road of this.project.roads) {
        if (ownRoad(road)) continue;
        for (let i = 0; i < road.points.length - 1; i++) {
          const a = road.points[i];
          const b = road.points[i + 1];
          onSegments.push(closestPointOnSegment(x, y, a.x, a.y, b.x, b.y));
        }
      }
      const onSegment = nearest(onSegments);
      if (onSegment) return { ...onSegment, snappedTo: 'road segment' };
    }
    const { grid } = this.project;
    return { point: grid.snap ? snapPoint(x, y, grid.size) : { x, y }, snappedTo: null };
  }

  /** Snapshot for the renderer overlay - transient tool/view state, not model data. */
  overlay() {
    return {
      mode: this.mode,
      draft: this.draftPoints,
      cursor: this.draftCursor,
      selection: this.selection,
      mergeCandidates: this.mergeCandidates,
    };
  }
}

// A road with N points has N points (0..N-1) and N-1 segments (0..N-2), so a
// selection can go stale by its road shrinking under it, not just by the road
// disappearing outright.
function addressesLivePart(road, { kind, index }) {
  if (!road) return false;
  const lastIndex = kind === 'point' ? road.points.length - 1 : road.points.length - 2;
  return Number.isInteger(index) && index >= 0 && index <= lastIndex;
}
