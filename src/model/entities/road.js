// Road entity — plain data shape (§5 of the requirements doc, FR-5/FR-6/FR-8).
// A polyline (array of continuous-float {x, y} points, meters) + one width,
// surface style and marking style for the whole path. No DOM / canvas code
// lives here (NFR-5).
//
// Straight segments only, per-path width/surface/markings (no per-segment
// tapering or style variation), point drag/reshape, split/merge/delete,
// dangling-end + junction detection (FR-5, FR-6, FR-8, FR-9, FR-10, FR-7).

import { isFiniteNumber, distanceToSegment, segmentsIntersect } from '../../utils/geometry.js';

const DEFAULT_WIDTH = 6;
const DEFAULT_SURFACE = 'asphalt';

// Lane width (FR-8), per path like every other road style property. 3.5 m is
// a normal urban lane; a service road or a rural highway is not, which is why
// this is authored per road rather than fixed in the renderer.
export const DEFAULT_LANE_WIDTH = 3.5;


// Surface style and center-line style (FR-8) are manifest data, not enums
// here: the manifest's `roadStyles` section lists which ids exist (see
// model/manifest.js), and an id it doesn't list is a missing-reference
// ERROR at export (FR-22, model/validation.js) - exactly how a building's
// variantId resolves. So this file only checks shape (a non-empty string);
// whether the id resolves is the manifest's call, not the road's.
//
// Markings (FR-8) are a set of INDEPENDENT features per path, not one style -
// "assign a surface style ... and independently toggle/configure markings:
// center line (solid/dashed/double-yellow), lane dividers, crosswalks, stop
// lines". So a road can carry a dashed center line AND a crosswalk at once.
//
// The center line is a style (it has mutually exclusive looks); the rest are
// plain on/off features. The on/off set is fixed here - it is what a road
// can store and the renderer can draw - and the manifest picks which of them
// it offers. Center line and lane dividers run the full path length;
// crosswalk and stop line are drawn once, at the path's LAST point (the most
// common single-location meaning for either - e.g. a road stopping at an
// intersection).
export const CENTER_LINE_NONE = 'none';
export const MARKING_FEATURES = ['laneDividers', 'crosswalk', 'stopLine'];

export const DEFAULT_MARKINGS = Object.freeze({
  centerLine: CENTER_LINE_NONE,
  laneDividers: false,
  crosswalk: false,
  stopLine: false,
});

/**
 * Normalize a markings input into a fresh, complete markings object. Accepts
 * a partial object (missing features default to off) or nothing at all.
 * (Pre-FR-8 project files stored a single style string; io/projectFile.js
 * migrates those on load - the model itself only knows the object form.)
 */
export function createMarkings(input = undefined) {
  if (input == null) return { ...DEFAULT_MARKINGS };
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('road: markings must be an object of marking features');
  }
  const markings = {
    centerLine: input.centerLine === undefined ? DEFAULT_MARKINGS.centerLine : input.centerLine,
    laneDividers: !!input.laneDividers,
    crosswalk: !!input.crosswalk,
    stopLine: !!input.stopLine,
  };
  if (typeof markings.centerLine !== 'string' || markings.centerLine === '') {
    throw new RangeError(
      `road: markings.centerLine must be a style id (non-empty string), got ${markings.centerLine}`,
    );
  }
  return markings;
}

/** True if the path carries no markings at all. */
export function hasNoMarkings(markings) {
  return markings.centerLine === CENTER_LINE_NONE
    && !markings.laneDividers && !markings.crosswalk && !markings.stopLine;
}

// Connection tolerance, in meters: two road points are "the same location"
// (for merge, dangling-end and junction checks) when they are within this
// distance. Road connections are purely by coincident coordinates - there is
// no separate junction graph - so a tool that wants two roads to connect must
// snap the shared point exactly (e.g. via the grid, or by snapping onto an
// existing endpoint). Exported so the export file can state the tolerance
// its junction data was resolved at.
export const CONNECT_EPSILON = 1e-6;

function assertPoint(field, x, y) {
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
    throw new TypeError(`road: ${field} must be a finite {x, y} point, got (${x}, ${y})`);
  }
}

function assertPoints(points) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new TypeError('road: points must be an array of at least 2 points');
  }
  points.forEach((p, i) => assertPoint(`points[${i}]`, p && p.x, p && p.y));
}

export function assertLaneWidth(laneWidth) {
  if (!isFiniteNumber(laneWidth) || laneWidth <= 0) {
    throw new RangeError(`road: laneWidth must be a positive finite number, got ${laneWidth}`);
  }
}

export function assertWidth(width) {
  if (!isFiniteNumber(width) || width <= 0) {
    throw new RangeError(`road: width must be a positive finite number, got ${width}`);
  }
}

export function assertSurface(surface) {
  if (typeof surface !== 'string' || surface === '') {
    throw new RangeError(`road: surface must be a style id (non-empty string), got ${surface}`);
  }
}

/** Throws unless `markings` can be normalized (see createMarkings). */
export function assertMarkings(markings) {
  createMarkings(markings);
}

function assertIndex(road, index) {
  if (!Number.isInteger(index) || index < 0 || index >= road.points.length) {
    throw new RangeError(`road: point index ${index} out of range`);
  }
}

/**
 * Create a road data object. `points` (>= 2 finite {x, y} points) is
 * required; `width` defaults to a reasonable two-lane width (meters);
 * `surface`/`markings` (FR-8) default to a plain unmarked asphalt strip.
 */
export function createRoad({
  id = null,
  points,
  width = DEFAULT_WIDTH,
  surface = DEFAULT_SURFACE,
  markings = undefined,
  laneWidth = DEFAULT_LANE_WIDTH,
} = {}) {
  assertPoints(points);
  assertWidth(width);
  assertSurface(surface);
  assertLaneWidth(laneWidth);
  return {
    type: 'road',
    id,
    points: points.map((p) => ({ x: p.x, y: p.y })),
    width,
    surface,
    markings: createMarkings(markings),
    laneWidth,
  };
}

/** Move an existing path point to reshape the road (FR-9). Mutates in place. */
export function movePoint(road, index, x, y) {
  assertIndex(road, index);
  assertPoint('point', x, y);
  road.points[index] = { x, y };
  return road;
}

/**
 * Split a road into two point arrays at an interior point index (FR-9). The
 * shared point stays in both halves, so splitting alone never creates a
 * dangling end. Throws if `index` is a path endpoint (nothing to split).
 * Returns plain point arrays - the caller (Project) assigns ids and builds
 * full road entities, since a split produces new entities.
 */
export function splitRoadPoints(road, index) {
  assertIndex(road, index);
  if (index === 0 || index === road.points.length - 1) {
    throw new RangeError('road: cannot split at a path endpoint');
  }
  return [road.points.slice(0, index + 1), road.points.slice(index)];
}

function pointsMatch(p, q, eps) {
  return Math.abs(p.x - q.x) <= eps && Math.abs(p.y - q.y) <= eps;
}

/**
 * Merge two roads into one connected point array (FR-9). Roads only connect
 * by a coincident endpoint in M2 (no separate junction graph), so this
 * requires `a` and `b` to share a start/end point (in any orientation)
 * within `eps`. Throws if no shared endpoint is found.
 */
export function mergeRoadPoints(a, b, eps = CONNECT_EPSILON) {
  const aStart = a.points[0];
  const aEnd = a.points[a.points.length - 1];
  const bStart = b.points[0];
  const bEnd = b.points[b.points.length - 1];

  if (pointsMatch(aEnd, bStart, eps)) return [...a.points, ...b.points.slice(1)];
  if (pointsMatch(aEnd, bEnd, eps)) return [...a.points, ...[...b.points].reverse().slice(1)];
  if (pointsMatch(aStart, bEnd, eps)) return [...b.points, ...a.points.slice(1)];
  if (pointsMatch(aStart, bStart, eps)) {
    return [...[...a.points].reverse(), ...b.points.slice(1)];
  }

  throw new RangeError('road: cannot merge roads that do not share an endpoint');
}

/** True when a road's last point is its first (a loop), within `eps`. */
export function isClosedRoad(road, eps = CONNECT_EPSILON) {
  return pointsMatch(road.points[0], road.points[road.points.length - 1], eps);
}

/**
 * Close a road into a loop (FR-9) by joining its last point back to its
 * first: returns the new point array, ending on an exact copy of the first
 * point so the two ends coincide. Needs 3+ points - closing a 2-point road
 * would only retrace its one segment - and throws if already closed.
 */
export function closeRoadPoints(road, eps = CONNECT_EPSILON) {
  if (road.points.length < 3) {
    throw new RangeError('road: a road needs at least 3 points to close into a loop');
  }
  if (isClosedRoad(road, eps)) throw new RangeError('road: road is already a closed loop');
  return [...road.points.map((p) => ({ ...p })), { ...road.points[0] }];
}

/**
 * Remove one segment from a road (FR-9). Removing an end segment just
 * shortens the same path; removing an interior segment breaks the path
 * into two separate roads (a gap - the newly exposed ends may be dangling,
 * see findDanglingEnds). Returns a description for the caller to apply:
 *  - { kind: 'empty' }                  fewer than 2 points remain
 *  - { kind: 'shrink', points }         road survives as one shorter path
 *  - { kind: 'split', points: [a, b] }  interior removal breaks it in two
 */
export function removeSegment(road, segmentIndex) {
  const segmentCount = road.points.length - 1;
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= segmentCount) {
    throw new RangeError(`road: segment index ${segmentIndex} out of range`);
  }

  if (segmentIndex === 0 || segmentIndex === segmentCount - 1) {
    const points = segmentIndex === 0 ? road.points.slice(1) : road.points.slice(0, -1);
    return points.length < 2 ? { kind: 'empty' } : { kind: 'shrink', points };
  }

  const a = road.points.slice(0, segmentIndex + 1);
  const b = road.points.slice(segmentIndex + 1);
  return a.length < 2 || b.length < 2 ? { kind: 'empty' } : { kind: 'split', points: [a, b] };
}

/**
 * Dangling-end detection (FR-10): a road endpoint is dangling unless it is
 * connected. "Connected" has ONE definition, findJunctions': the endpoint
 * attaches to a junction - it meets another road's end, or lands on another
 * road's segment (a T-junction stem). A closed loop's two ends meet each
 * other, so they are not dangling either. An end that merely comes close
 * (beyond `eps`) is still dangling. This is a simple, non-blocking visual cue
 * and validation warning (FR-10, FR-21).
 *
 * Pass `junctions` when the caller already has findJunctions(roads, eps) in
 * hand (the renderer caches it) to avoid computing it twice.
 */
export function findDanglingEnds(roads, eps = CONNECT_EPSILON, junctions = findJunctions(roads, eps)) {
  const attached = new Set();
  for (const j of junctions) {
    for (const att of j.attachments) {
      if (att.kind === 'vertex') attached.add(`${att.roadId}#${att.pointIndex}`);
    }
  }
  const ends = [];
  for (const road of roads) {
    const last = road.points.length - 1; // always >= 1: a road always has >= 2 points
    if (isClosedRoad(road, eps)) continue;
    for (const pointIndex of [0, last]) {
      if (attached.has(`${road.id}#${pointIndex}`)) continue;
      const p = road.points[pointIndex];
      ends.push({ roadId: road.id, pointIndex, x: p.x, y: p.y });
    }
  }
  return ends;
}

/**
 * Junction resolution (FR-7): find where two or more road paths meet or
 * cross. A junction point is either:
 *  - a shared endpoint (two paths' ends coincide), or an endpoint landing
 *    on another path's segment interior (a T-junction stubbing into a
 *    through-road that has no vertex there), or
 *  - two segments crossing in their interior with no shared vertex at all
 *    (an X-junction).
 * Purely derived from road path data on every call - there is no separate
 * junction graph stored anywhere. This is also the definition of
 * "connected" that findDanglingEnds uses.
 * A shared point involving 3+ roads (a typical 4-way city intersection)
 * falls out of the same clustering step, so N-way junctions need no
 * special-casing.
 *
 * Each junction is `{ x, y, roadIds, width, surface, attachments }`:
 *  - x, y, width, surface: the covering disc the renderer draws (width and
 *    surface of the widest road there, so it hides every strip end).
 *  - roadIds: every road meeting there, sorted.
 *  - attachments: where EACH road meets the junction, one entry per place
 *    (sorted by road id, then distance along the path):
 *      { roadId, kind: 'vertex',  pointIndex, distanceAlongPath }
 *        the junction is on one of the road's own points
 *      { roadId, kind: 'segment', segmentIndex, distanceAlongPath }
 *        the junction is partway along a segment (the through-road of a T,
 *        either road of an X) - segmentIndex i runs points[i] -> points[i+1]
 *    distanceAlongPath is meters from points[0], measured along the path.
 *    A point within `eps` of a vertex counts as that vertex.
 */
export function findJunctions(roads, eps = CONNECT_EPSILON) {
  if (roads.length < 2) return [];
  const candidates = [];

  // An endpoint of `a` landing on a segment of `b` (a != b). This covers
  // both a plain shared endpoint (distance 0 to b's own end segment) and a
  // T-junction stub landing mid-strip on a through-road.
  for (const a of roads) {
    const last = a.points.length - 1;
    for (const b of roads) {
      if (a === b) continue;
      for (const ia of [0, last]) {
        const p = a.points[ia];
        for (let s = 0; s < b.points.length - 1; s++) {
          const b0 = b.points[s];
          const b1 = b.points[s + 1];
          if (distanceToSegment(p.x, p.y, b0.x, b0.y, b1.x, b1.y) <= eps) {
            candidates.push({
              x: p.x,
              y: p.y,
              attachments: [vertexAttachment(a, ia), attachmentOnSegment(b, s, p, eps)],
            });
          }
        }
      }
    }
  }

  // Two segments crossing in their interior - an X with no shared vertex.
  for (let i = 0; i < roads.length; i++) {
    for (let j = i + 1; j < roads.length; j++) {
      const a = roads[i];
      const b = roads[j];
      for (let sa = 0; sa < a.points.length - 1; sa++) {
        for (let sb = 0; sb < b.points.length - 1; sb++) {
          const hit = segmentsIntersect(
            a.points[sa], a.points[sa + 1], b.points[sb], b.points[sb + 1],
          );
          if (hit) {
            candidates.push({
              x: hit.x,
              y: hit.y,
              attachments: [attachmentOnSegment(a, sa, hit, eps), attachmentOnSegment(b, sb, hit, eps)],
            });
          }
        }
      }
    }
  }

  return clusterJunctionCandidates(candidates, roads, eps);
}

// Cumulative path length (meters) at each point: lengths[i] is the distance
// from points[0] to points[i] along the path.
function pathLengths(road) {
  const lengths = [0];
  for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1];
    const b = road.points[i];
    lengths.push(lengths[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return lengths;
}

function vertexAttachment(road, pointIndex) {
  return {
    roadId: road.id,
    kind: 'vertex',
    pointIndex,
    distanceAlongPath: pathLengths(road)[pointIndex],
  };
}

// Where point `p` (known to lie on segment `s` of `road`) sits on the road:
// one of the segment's own end vertices if it's within `eps` of one, else a
// point partway along the segment.
function attachmentOnSegment(road, s, p, eps) {
  const a = road.points[s];
  const b = road.points[s + 1];
  if (Math.hypot(p.x - a.x, p.y - a.y) <= eps) return vertexAttachment(road, s);
  if (Math.hypot(p.x - b.x, p.y - b.y) <= eps) return vertexAttachment(road, s + 1);
  return {
    roadId: road.id,
    kind: 'segment',
    segmentIndex: s,
    distanceAlongPath: pathLengths(road)[s] + Math.hypot(p.x - a.x, p.y - a.y),
  };
}

// Merge nearby candidate points into one junction per meeting point,
// accumulating every road involved there (this is what makes a 3- or 4-way
// intersection "just work" - each pairwise candidate that lands on the same
// spot joins the same cluster). The disc drawn for a junction takes its
// size/color from whichever participating road is widest, so it fully
// covers every narrower road's strip end too. The same meeting place on a
// road is reported by several candidates (e.g. a shared vertex is on both
// of its adjoining segments), so attachments are de-duplicated per place.
function clusterJunctionCandidates(candidates, roads, eps) {
  const byId = new Map(roads.map((r) => [r.id, r]));
  const clusters = [];
  for (const c of candidates) {
    let cluster = clusters.find(
      (cl) => Math.abs(cl.x - c.x) <= eps && Math.abs(cl.y - c.y) <= eps,
    );
    if (!cluster) {
      cluster = { x: c.x, y: c.y, attachments: new Map() };
      clusters.push(cluster);
    }
    for (const att of c.attachments) {
      const key = att.kind === 'vertex'
        ? `${att.roadId}#v${att.pointIndex}`
        : `${att.roadId}#s${att.segmentIndex}`;
      if (!cluster.attachments.has(key)) cluster.attachments.set(key, att);
    }
  }

  return clusters.map((cl) => {
    const attachments = [...cl.attachments.values()].sort((p, q) => (
      p.roadId === q.roadId ? p.distanceAlongPath - q.distanceAlongPath : (p.roadId < q.roadId ? -1 : 1)
    ));
    const roadIds = [...new Set(attachments.map((att) => att.roadId))].sort();
    const widest = roadIds
      .map((id) => byId.get(id))
      .reduce((best, r) => (r.width > best.width ? r : best));
    return {
      x: cl.x, y: cl.y, roadIds, width: widest.width, surface: widest.surface, attachments,
    };
  });
}

/**
 * Offsets from the centerline (meters) at which this road's lane dividers
 * fall: the strip split into `laneWidth`-ish lanes, with the middle boundary
 * left out (that one is the center line's, and drawing both would stack two
 * markings on the same line).
 *
 * A road narrower than two lanes has nothing to divide, so it gets none.
 */
export function laneDividerOffsets(road) {
  const lanes = Math.round(road.width / road.laneWidth);
  if (lanes < 2) return [];
  const actualLaneWidth = road.width / lanes;
  const offsets = [];
  for (let i = 1; i < lanes; i++) {
    const offset = -road.width / 2 + i * actualLaneWidth;
    if (Math.abs(offset) > 1e-9) offsets.push(offset);
  }
  return offsets;
}
