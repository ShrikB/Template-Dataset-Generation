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
import { findDanglingEnds, findJunctions } from '../../model/entities/road.js';
import {
  roadMarkingLines, roadMarkingBars, offsetSegments,
  MARKING_MATERIAL_WHITE, MARKING_MATERIAL_YELLOW,
} from '../../model/roadMarkings.js';

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
// Marking paint -> 2D preview color. Which paint a marking uses, and where
// it sits and how big it is, is model data (model/roadMarkings.js) shared
// with the export - only the screen color belongs here.
const MARKING_COLORS = {
  [MARKING_MATERIAL_WHITE]: '#e8e6df',
  [MARKING_MATERIAL_YELLOW]: '#d9b23c',
};

function markingColor(material) {
  return MARKING_COLORS[material] || MARKING_COLORS[MARKING_MATERIAL_WHITE];
}
const DRAFT_COLOR = '#e0c34a';
const SELECT_COLOR = '#4b9fd6';
const MERGE_COLOR = '#c65d3b';
const DANGLE_COLOR = '#e0553f';
const POINT_RADIUS = 4;

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

// Markings (FR-8) are independent features per path - a road can carry a
// dashed center line, lane dividers AND a crosswalk at once. What they are
// and where they sit comes resolved from the model (model/roadMarkings.js),
// in meters and already in paint order; this only strokes them, converting
// to px via `scale`.
function _drawMarkings(ctx, worldToScreen, scale, road) {
  for (const line of roadMarkingLines(road)) {
    _drawMarkingLine(ctx, worldToScreen, scale, road, line);
  }
  for (const bar of roadMarkingBars(road)) {
    _drawMarkingBar(ctx, worldToScreen, scale, bar);
  }
}

// A line running the path's length. On the centerline it is one continuous
// stroke along the road's own points; offset to one side (each half of a
// double-yellow, each lane divider) it is one stroke per segment
// (offsetSegments) rather than a mitered offset polyline - a simple
// approximation, fine at bends for a v1 marking, per "start simple".
function _drawMarkingLine(ctx, worldToScreen, scale, road, line) {
  ctx.save();
  ctx.strokeStyle = markingColor(line.material);
  ctx.lineWidth = Math.max(1, line.width * scale);
  ctx.lineCap = 'butt';
  if (line.offset === 0) ctx.lineJoin = 'round';
  ctx.setLineDash(line.dash ? [line.dash.length * scale, line.dash.gap * scale] : []);

  if (line.offset === 0) {
    ctx.beginPath();
    const p0 = worldToScreen(road.points[0].x, road.points[0].y);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < road.points.length; i++) {
      const p = worldToScreen(road.points[i].x, road.points[i].y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  } else {
    for (const segment of offsetSegments(road, line.offset)) {
      const sa = worldToScreen(segment.a.x, segment.a.y);
      const sb = worldToScreen(segment.b.x, segment.b.y);
      ctx.beginPath();
      ctx.moveTo(sa.x, sa.y);
      ctx.lineTo(sb.x, sb.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// A short straight stroke with square ends: one zebra-crossing stripe, or
// the stop line.
function _drawMarkingBar(ctx, worldToScreen, scale, bar) {
  const p1 = worldToScreen(bar.a.x, bar.a.y);
  const p2 = worldToScreen(bar.b.x, bar.b.y);
  ctx.save();
  ctx.strokeStyle = markingColor(bar.material);
  ctx.lineWidth = Math.max(1, bar.width * scale);
  ctx.lineCap = 'butt';
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
  ctx.restore();
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
