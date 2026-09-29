// Road rendering layer (FR-5, FR-6, FR-7, FR-8, FR-9, FR-10).
//
// Drawing only: reads the project model plus a transient tool overlay
// (draft path, selection, merge candidates - view state, not model data,
// same category as camera.js), never mutates either. There is still no
// junction graph stored in the model - findDanglingEnds/findJunctions are
// still pure functions of project.roads - but both are O(roads^2) (worse
// for findJunctions, which is also O(pointsPerRoad^2)), and drawRoads()
// runs on every render (every pan/zoom tick, every undo/redo). An optional
// `cache` param lets the caller (CanvasRenderer) skip recomputing them on
// a render where the roads haven't actually changed, keyed by a cheap
// fingerprint of the exact fields these two functions depend on. Passing
// no cache (as the existing render-layer tests do) falls back to computing
// fresh every call, same as before.

import { CATEGORY_COLORS } from '../../utils/categories.js';
import {
  findDanglingEnds, findJunctions, laneDividerOffsets, CENTER_LINE_NONE,
} from '../../model/entities/road.js';

// Surface style -> fill color (FR-8). Surface ids come from the manifest's
// roadStyles section, which may give each one a preview `color`; these are
// the fallbacks for a manifest entry without one (or no manifest at all).
// Roads are drawn fully opaque (not blended) specifically so that
// overlapping strips at a junction paint over each other cleanly instead of
// showing a darker double-blended seam.
const FALLBACK_SURFACE_COLORS = {
  asphalt: CATEGORY_COLORS.roads,
  dirt: '#8a6d4b',
};

function surfaceColor(surface, manifest) {
  const style = manifest ? manifest.surface(surface) : null;
  return (style && style.color) || FALLBACK_SURFACE_COLORS[surface] || CATEGORY_COLORS.roads;
}
const MARKING_COLOR_WHITE = '#e8e6df';
const MARKING_COLOR_YELLOW = '#d9b23c';
const DRAFT_COLOR = '#e0c34a';
const SELECT_COLOR = '#4b9fd6';
const MERGE_COLOR = '#c65d3b';
const DANGLE_COLOR = '#e0553f';
const POINT_RADIUS = 4;

// Marking geometry, in meters (converted to px via `scale` at draw time).
const CENTERLINE_WIDTH_M = 0.15;
const DOUBLE_YELLOW_OFFSET_M = 0.2;
const DASH_PATTERN_M = [1.2, 1];
const CROSSWALK_STRIPE_COUNT = 5;
const CROSSWALK_STRIPE_WIDTH_M = 0.5;
const CROSSWALK_BAND_DEPTH_M = 2;
const STOP_LINE_WIDTH_M = 0.4;
const STOP_LINE_SETBACK_M = 1;
const STOP_LINE_INSET_M = 0.3;
// Where the dividers fall is road geometry, not a drawing detail - it lives
// on the entity (laneDividerOffsets) so the lane width can be authored per
// road. Only the dash look belongs here.
const LANE_DIVIDER_DASH_M = [2, 2];

/**
 * Draw all roads for the current project. `worldToScreen` is a (x, y) => {x,
 * y} function (matches CanvasRenderer#worldToScreen); `scale` is screen
 * pixels per meter, used to size road/marking width and highlight strokes.
 * `cache` is an optional, caller-owned `{ fingerprint, junctions,
 * danglingEnds }` object (see the file header) - pass the same object back
 * on every call to get memoization; omit it to always compute fresh.
 */
export function drawRoads(
  ctx, worldToScreen, scale, project, overlay = null, cache = null, manifest = null,
) {
  if (!project.isLayerVisible('roads')) return;

  for (const road of project.roads) {
    _drawPath(ctx, worldToScreen, road.points, road.width * scale, surfaceColor(road.surface, manifest));
  }
  for (const road of project.roads) {
    _drawMarkings(ctx, worldToScreen, scale, road);
  }

  const derived = getDerivedRoadData(project.roads, cache);

  // Junction discs paint over both the strip seams and the marking ends
  // right at the meeting point (FR-7) - real center lines stop short of an
  // intersection too, so this reads correctly rather than as a bug.
  _drawJunctions(ctx, worldToScreen, scale, derived.junctions, manifest);

  if (overlay && overlay.active) {
    if (overlay.mode === 'edit') {
      _drawPointHandles(ctx, worldToScreen, project);
      _drawMergeCandidates(ctx, worldToScreen, scale, project, overlay);
      _drawSelection(ctx, worldToScreen, project, overlay);
    }
    _drawDraft(ctx, worldToScreen, overlay);
  }

  _drawDanglingEnds(ctx, worldToScreen, derived.danglingEnds);
}

// findJunctions is O(roads^2 * pointsPerRoad^2), and findDanglingEnds is
// derived from its result (O(junctions + roads) given it) - cheap for M2/M3-scale layouts but the dominant cost by
// far at NFR-3's upper end (hundreds of segments), and both were being
// recomputed on literally every render. Recompute only when the roads'
// id/points/width/surface actually changed since the last render (the
// only fields either function reads) - a plain point-move drag or an
// undo/redo still change the fingerprint correctly since they mutate
// `points`/these fields directly, so this can't go stale.
function getDerivedRoadData(roads, cache) {
  if (!cache) {
    const junctions = findJunctions(roads);
    return { junctions, danglingEnds: findDanglingEnds(roads, undefined, junctions) };
  }
  const fingerprint = _fingerprintRoads(roads);
  if (cache.fingerprint !== fingerprint) {
    cache.fingerprint = fingerprint;
    cache.junctions = findJunctions(roads);
    // Dangling ends are derived from the junctions (one definition of
    // "connected" - see findDanglingEnds), so reuse them rather than
    // resolving the junctions twice.
    cache.danglingEnds = findDanglingEnds(roads, undefined, cache.junctions);
  }
  return cache;
}

function _fingerprintRoads(roads) {
  let fp = '';
  for (const r of roads) {
    fp += r.id;
    fp += ':';
    fp += r.width;
    fp += ':';
    fp += r.surface;
    fp += ':';
    for (const p of r.points) {
      fp += p.x;
      fp += ',';
      fp += p.y;
      fp += ';';
    }
    fp += '|';
  }
  return fp;
}

function _drawPath(ctx, worldToScreen, points, widthPx, color, alpha = 1) {
  if (points.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, widthPx);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  ctx.beginPath();
  const p0 = worldToScreen(points[0].x, points[0].y);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < points.length; i++) {
    const p = worldToScreen(points[i].x, points[i].y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.restore();
}

// Junction discs (FR-7): a filled circle at each meeting point, sized to
// the widest participating road, so multiple strips (of possibly different
// widths) read as one continuous surface through the junction rather than
// showing gaps/notches at the seam.
function _drawJunctions(ctx, worldToScreen, scale, junctions, manifest) {
  if (junctions.length === 0) return;
  ctx.save();
  for (const j of junctions) {
    const s = worldToScreen(j.x, j.y);
    ctx.fillStyle = surfaceColor(j.surface, manifest);
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(0.5, (j.width * scale) / 2), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// Markings are independent features per path (FR-8), so these are sequential
// `if`s rather than a switch: a road can carry a dashed center line, lane
// dividers AND a crosswalk at once. Lane dividers paint before the center
// line so the center line stays on top where they would touch.
function _drawMarkings(ctx, worldToScreen, scale, road) {
  const m = road.markings;

  if (m.laneDividers) {
    for (const offset of laneDividerOffsets(road)) {
      _drawOffsetLine(
        ctx, worldToScreen, scale, road, offset, MARKING_COLOR_WHITE, LANE_DIVIDER_DASH_M,
      );
    }
  }

  if (m.centerLine === 'solid') {
    _drawCenterline(ctx, worldToScreen, scale, road, MARKING_COLOR_WHITE, null);
  } else if (m.centerLine === 'dashed') {
    _drawCenterline(ctx, worldToScreen, scale, road, MARKING_COLOR_WHITE, DASH_PATTERN_M);
  } else if (m.centerLine === 'double-yellow') {
    _drawOffsetLine(ctx, worldToScreen, scale, road, DOUBLE_YELLOW_OFFSET_M, MARKING_COLOR_YELLOW, null);
    _drawOffsetLine(ctx, worldToScreen, scale, road, -DOUBLE_YELLOW_OFFSET_M, MARKING_COLOR_YELLOW, null);
  } else if (m.centerLine !== CENTER_LINE_NONE) {
    // A manifest center-line style the 2D preview has no dedicated look for
    // - shown as a plain solid line so the road still reads as marked.
    _drawCenterline(ctx, worldToScreen, scale, road, MARKING_COLOR_WHITE, null);
  }

  if (m.crosswalk) _drawCrosswalk(ctx, worldToScreen, scale, road);
  if (m.stopLine) _drawStopLine(ctx, worldToScreen, scale, road);
}

function _drawCenterline(ctx, worldToScreen, scale, road, color, dashPatternM) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, CENTERLINE_WIDTH_M * scale);
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.setLineDash(dashPatternM ? dashPatternM.map((d) => d * scale) : []);
  ctx.beginPath();
  const p0 = worldToScreen(road.points[0].x, road.points[0].y);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < road.points.length; i++) {
    const p = worldToScreen(road.points[i].x, road.points[i].y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.restore();
}

// A line running the path's length, offset to one side of the centerline -
// used for both halves of a double-yellow and for each lane divider.
// Offsetting per-segment (rather than mitering a joined offset polyline) is a
// simple approximation - fine at bends for a v1 marking, per "start simple".
function _drawOffsetLine(ctx, worldToScreen, scale, road, offsetM, color, dashPatternM) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, CENTERLINE_WIDTH_M * scale);
  ctx.lineCap = 'butt';
  ctx.setLineDash(dashPatternM ? dashPatternM.map((d) => d * scale) : []);
  for (let i = 0; i < road.points.length - 1; i++) {
    const a = road.points[i];
    const b = road.points[i + 1];
    const perp = _perpUnit(a, b);
    const a2 = { x: a.x + perp.x * offsetM, y: a.y + perp.y * offsetM };
    const b2 = { x: b.x + perp.x * offsetM, y: b.y + perp.y * offsetM };
    const sa = worldToScreen(a2.x, a2.y);
    const sb = worldToScreen(b2.x, b2.y);
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
  }
  ctx.restore();
}

// A zebra crossing band across the road width, near the path's end.
function _drawCrosswalk(ctx, worldToScreen, scale, road) {
  const pts = road.points;
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  const dir = _unitDir(a, b);
  const perp = { x: -dir.y, y: dir.x };
  const halfWidth = road.width / 2;
  const segLen = Math.hypot(b.x - a.x, b.y - a.y);
  const bandDepth = Math.min(CROSSWALK_BAND_DEPTH_M, segLen * 0.4);

  ctx.save();
  ctx.strokeStyle = MARKING_COLOR_WHITE;
  ctx.lineWidth = Math.max(1, CROSSWALK_STRIPE_WIDTH_M * scale);
  ctx.setLineDash([]);
  for (let i = 0; i < CROSSWALK_STRIPE_COUNT; i++) {
    const t = (i + 0.5) / CROSSWALK_STRIPE_COUNT;
    const across = -halfWidth + t * road.width;
    const cx = b.x + perp.x * across;
    const cy = b.y + perp.y * across;
    const p1 = worldToScreen(cx - dir.x * (bandDepth / 2), cy - dir.y * (bandDepth / 2));
    const p2 = worldToScreen(cx + dir.x * (bandDepth / 2), cy + dir.y * (bandDepth / 2));
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }
  ctx.restore();
}

// A single bar across (most of) the road width, set back slightly from the
// path's very end - where a road stops just before an intersection.
function _drawStopLine(ctx, worldToScreen, scale, road) {
  const pts = road.points;
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  const dir = _unitDir(a, b);
  const perp = { x: -dir.y, y: dir.x };
  const segLen = Math.hypot(b.x - a.x, b.y - a.y);
  const setback = Math.min(STOP_LINE_SETBACK_M, segLen * 0.3);
  const cx = b.x - dir.x * setback;
  const cy = b.y - dir.y * setback;
  const halfWidth = Math.max(0, road.width / 2 - STOP_LINE_INSET_M);

  const p1 = worldToScreen(cx + perp.x * halfWidth, cy + perp.y * halfWidth);
  const p2 = worldToScreen(cx - perp.x * halfWidth, cy - perp.y * halfWidth);
  ctx.save();
  ctx.strokeStyle = MARKING_COLOR_WHITE;
  ctx.lineWidth = Math.max(1, STOP_LINE_WIDTH_M * scale);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
  ctx.restore();
}

function _unitDir(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  return len > 0 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
}

function _perpUnit(a, b) {
  const dir = _unitDir(a, b);
  return { x: -dir.y, y: dir.x };
}

function _drawPointHandles(ctx, worldToScreen, project) {
  ctx.fillStyle = '#0d0f13';
  ctx.strokeStyle = '#d7dbe2';
  ctx.lineWidth = 1;
  for (const road of project.roads) {
    for (const p of road.points) {
      const s = worldToScreen(p.x, p.y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, POINT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

function _drawSelection(ctx, worldToScreen, project, overlay) {
  if (!overlay.selection) return;
  const { kind, roadId, index } = overlay.selection;
  const road = project.roads.find((r) => r.id === roadId);
  if (!road) return;

  ctx.strokeStyle = SELECT_COLOR;
  if (kind === 'point') {
    const p = worldToScreen(road.points[index].x, road.points[index].y);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, POINT_RADIUS + 3, 0, Math.PI * 2);
    ctx.stroke();
  } else if (kind === 'segment') {
    const a = worldToScreen(road.points[index].x, road.points[index].y);
    const b = worldToScreen(road.points[index + 1].x, road.points[index + 1].y);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

function _drawMergeCandidates(ctx, worldToScreen, scale, project, overlay) {
  for (const roadId of overlay.mergeCandidates || []) {
    const road = project.roads.find((r) => r.id === roadId);
    if (road) _drawPath(ctx, worldToScreen, road.points, road.width * scale + 4, MERGE_COLOR, 0.5);
  }
}

function _drawDraft(ctx, worldToScreen, overlay) {
  if (!overlay || overlay.draft.length === 0) return;
  const pts = overlay.cursor ? [...overlay.draft, overlay.cursor] : overlay.draft;

  ctx.save();
  ctx.strokeStyle = DRAFT_COLOR;
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  const p0 = worldToScreen(pts[0].x, pts[0].y);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < pts.length; i++) {
    const p = worldToScreen(pts[i].x, pts[i].y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = DRAFT_COLOR;
  for (const p of overlay.draft) {
    const s = worldToScreen(p.x, p.y);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Non-blocking visual flag for disconnected road ends (FR-10) - not the
// formal validation pass (FR-21/FR-22, M6).
function _drawDanglingEnds(ctx, worldToScreen, ends) {
  if (ends.length === 0) return;

  ctx.strokeStyle = DANGLE_COLOR;
  ctx.lineWidth = 2;
  for (const end of ends) {
    const s = worldToScreen(end.x, end.y);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x - 4, s.y - 4);
    ctx.lineTo(s.x + 4, s.y + 4);
    ctx.moveTo(s.x + 4, s.y - 4);
    ctx.lineTo(s.x - 4, s.y + 4);
    ctx.stroke();
  }
}
