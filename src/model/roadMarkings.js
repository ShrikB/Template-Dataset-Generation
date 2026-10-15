// Road marking geometry (FR-8) — where every marking a road carries sits and
// how big it is, in meters. Pure data + geometry, no DOM / canvas code
// (NFR-5).
//
// This is the ONE source for both consumers: the canvas draws from it
// (render/layers/roadLayer.js) and the export writes it out as a road's
// `markingGeometry` (Document 2 §8.1), so what is exported is what was on
// screen. Which markings a road has is the road's own data (entities/road.js);
// this file only turns that into shapes.
//
// Two kinds of shape, matching the export:
//  - LINES run the whole length of the road, parallel to its centerline, and
//    are described by their OFFSET from it rather than by points - the
//    importer may round the road's corners (FMT-34), and an offset follows
//    whatever curve it builds.
//  - BARS are short straight strokes at the road's last point (crosswalk
//    stripes, the stop line), in absolute coordinates. The export writes each
//    one as a four-corner polygon (barPolygon).
//
// Everything here is in EDITOR coordinates (+y down the screen). A positive
// line offset is toward (-dir.y, dir.x) of the direction of travel
// (points[0] -> last point): the right-hand side as seen on screen. The
// export's convention is the opposite side, so the exporter negates it.

import { laneDividerOffsets, isClosedRoad, CENTER_LINE_NONE } from './entities/road.js';

// The paint each marking uses - ids of `marking`-kind materials in the asset
// manifest's `materials` section (Document 2 §12).
export const MARKING_MATERIAL_WHITE = 'marking_white';
export const MARKING_MATERIAL_YELLOW = 'marking_yellow';

// Painted width of every line marking.
export const MARKING_LINE_WIDTH_M = 0.15;
// Each half of a double-yellow sits this far either side of the centerline.
export const DOUBLE_YELLOW_OFFSET_M = 0.2;
export const CENTER_LINE_DASH = Object.freeze({ length: 1.2, gap: 1 });
// Where the dividers fall is road geometry (laneDividerOffsets, per road);
// only the dash look is fixed here.
export const LANE_DIVIDER_DASH = Object.freeze({ length: 2, gap: 2 });

// A zebra crossing: stripes running along the road, spread evenly across its
// width, in a band centered on the road's last point.
export const CROSSWALK_STRIPE_COUNT = 5;
export const CROSSWALK_STRIPE_WIDTH_M = 0.5;
export const CROSSWALK_BAND_DEPTH_M = 2;
// ...but never deeper than this share of the last segment, so a short final
// segment isn't swallowed by its own crossing.
export const CROSSWALK_MAX_SEGMENT_SHARE = 0.4;

// A single bar across the road, set back from its last point and stopping
// short of each edge.
export const STOP_LINE_WIDTH_M = 0.4;
export const STOP_LINE_SETBACK_M = 1;
export const STOP_LINE_MAX_SEGMENT_SHARE = 0.3;
export const STOP_LINE_INSET_M = 0.3;

/**
 * The line markings a road carries, in paint order (lane dividers first, so
 * the center line stays on top where they would touch):
 *
 *   [{ material, offset, width, dash }]
 *
 * `offset` is meters from the centerline (0 = on it; see the file header for
 * which side is positive), `width` the painted width, and `dash` either null
 * (solid) or a repeating `{ length, gap }` in meters.
 */
export function roadMarkingLines(road) {
  const m = road.markings;
  const lines = [];
  const add = (material, offset, dash) => lines.push({
    material, offset, width: MARKING_LINE_WIDTH_M, dash: dash ? { ...dash } : null,
  });

  if (m.laneDividers) {
    for (const offset of laneDividerOffsets(road)) add(MARKING_MATERIAL_WHITE, offset, LANE_DIVIDER_DASH);
  }

  if (m.centerLine === 'double-yellow') {
    add(MARKING_MATERIAL_YELLOW, DOUBLE_YELLOW_OFFSET_M, null);
    add(MARKING_MATERIAL_YELLOW, -DOUBLE_YELLOW_OFFSET_M, null);
  } else if (m.centerLine === 'dashed') {
    add(MARKING_MATERIAL_WHITE, 0, CENTER_LINE_DASH);
  } else if (m.centerLine !== CENTER_LINE_NONE) {
    // 'solid' - and any manifest center-line style with no dedicated look
    // here, shown as a plain solid line so the road still reads as marked.
    add(MARKING_MATERIAL_WHITE, 0, null);
  }
  return lines;
}

/**
 * The bar markings a road carries - its crosswalk stripes, then its stop
 * line - each a straight stroke of a given thickness with square ends:
 *
 *   [{ material, a: { x, y }, b: { x, y }, width }]
 *
 * Both sit at the road's LAST point, oriented by its last segment. A bar
 * with no length (a crossing on a zero-length last segment, a stop line on a
 * road too narrow to hold one) is left out - there is nothing to paint.
 *
 * A closed loop has no end for them to sit at, so it has none (FMT-21) -
 * neither drawn nor exported, however the road's markings are set
 * (hasUnusedEndMarkings is what validation warns about).
 */
export function roadMarkingBars(road) {
  const m = road.markings;
  if (!m.crosswalk && !m.stopLine) return [];
  if (isClosedRoad(road)) return [];

  const pts = road.points;
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  const dir = unitDir(a, b);
  const perp = { x: -dir.y, y: dir.x };
  const segLen = Math.hypot(b.x - a.x, b.y - a.y);
  const bars = [];
  const add = (from, to, width) => {
    if (from.x === to.x && from.y === to.y) return;
    bars.push({
      material: MARKING_MATERIAL_WHITE, a: from, b: to, width,
    });
  };

  if (m.crosswalk) {
    const halfWidth = road.width / 2;
    const bandDepth = Math.min(CROSSWALK_BAND_DEPTH_M, segLen * CROSSWALK_MAX_SEGMENT_SHARE);
    for (let i = 0; i < CROSSWALK_STRIPE_COUNT; i++) {
      const t = (i + 0.5) / CROSSWALK_STRIPE_COUNT;
      const across = -halfWidth + t * road.width;
      const cx = b.x + perp.x * across;
      const cy = b.y + perp.y * across;
      add(
        { x: cx - dir.x * (bandDepth / 2), y: cy - dir.y * (bandDepth / 2) },
        { x: cx + dir.x * (bandDepth / 2), y: cy + dir.y * (bandDepth / 2) },
        CROSSWALK_STRIPE_WIDTH_M,
      );
    }
  }

  if (m.stopLine) {
    const setback = Math.min(STOP_LINE_SETBACK_M, segLen * STOP_LINE_MAX_SEGMENT_SHARE);
    const cx = b.x - dir.x * setback;
    const cy = b.y - dir.y * setback;
    const halfWidth = Math.max(0, road.width / 2 - STOP_LINE_INSET_M);
    add(
      { x: cx + perp.x * halfWidth, y: cy + perp.y * halfWidth },
      { x: cx - perp.x * halfWidth, y: cy - perp.y * halfWidth },
      STOP_LINE_WIDTH_M,
    );
  }
  return bars;
}

/**
 * True for a road whose crosswalk or stop line is switched on but can't be
 * placed, because the road is a closed loop (FMT-21).
 */
export function hasUnusedEndMarkings(road) {
  return (road.markings.crosswalk || road.markings.stopLine) && isClosedRoad(road);
}

/**
 * A bar's outline as four corners, in order around it (the first is not
 * repeated): the rectangle `width` thick around the stroke from a to b.
 */
export function barPolygon(bar) {
  const dir = unitDir(bar.a, bar.b);
  const nx = -dir.y * (bar.width / 2);
  const ny = dir.x * (bar.width / 2);
  return [
    { x: bar.a.x + nx, y: bar.a.y + ny },
    { x: bar.b.x + nx, y: bar.b.y + ny },
    { x: bar.b.x - nx, y: bar.b.y - ny },
    { x: bar.a.x - nx, y: bar.a.y - ny },
  ];
}

/**
 * Everything a road's markings resolve to, in the shape the export carries
 * (Document 2 §8.1) but still in editor coordinates:
 *
 *   { lines: [{ material, offset, width, dash }],
 *     areas: [{ material, polygon: [{ x, y }, ...] }] }
 *
 * Both lists are empty for a road with no markings.
 */
export function roadMarkingGeometry(road) {
  return {
    lines: roadMarkingLines(road),
    areas: roadMarkingBars(road).map((bar) => ({ material: bar.material, polygon: barPolygon(bar) })),
  };
}

/**
 * Where a line `offset` meters from the centerline runs, one straight piece
 * per road segment: `[{ a: { x, y }, b: { x, y } }]`. Each segment is shifted
 * sideways on its own, so the pieces are NOT joined at a bend (they gap on
 * the outside and cross on the inside) - a simple approximation that is what
 * the 2D preview draws. The export carries the offset itself, not these.
 */
export function offsetSegments(road, offset) {
  const segments = [];
  for (let i = 0; i < road.points.length - 1; i++) {
    const a = road.points[i];
    const b = road.points[i + 1];
    const dir = unitDir(a, b);
    const perp = { x: -dir.y, y: dir.x };
    segments.push({
      a: { x: a.x + perp.x * offset, y: a.y + perp.y * offset },
      b: { x: b.x + perp.x * offset, y: b.y + perp.y * offset },
    });
  }
  return segments;
}

// Unit vector from a to b; +x for two coincident points, so a zero-length
// segment still has a usable (if arbitrary) direction.
function unitDir(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  return len > 0 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
}
