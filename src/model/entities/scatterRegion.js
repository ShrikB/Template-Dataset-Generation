// Scatter region entity — plain data shape (§5 of the requirements doc,
// FR-17/FR-18). A region + density parameters, NOT a pre-expanded list of
// individual points - instance positions are generated on demand by
// placeScatterPoints (for the editor preview, see model/scatterPreview.js,
// and again by the importer from the exported region), always randomized
// fresh (CLAUDE.md: "Scatter regions always randomize on export. No
// seed-lock toggle."). No DOM/canvas code lives here (NFR-5).
//
// Shape: rectangular, not freeform. A freeform polygon would need its own
// point-in-polygon containment math for hit-testing/marquee-select/preview
// sampling that couldn't reuse anything - a rectangle is exactly the shape
// src/tools/selectTool.js's marquee already drags out, so region draw/
// select/move/hit-test all reuse the same simple axis-aligned-rect math
// the rest of the app already has.

import {
  assertFiniteNumber, distanceToSegment, distanceToRotatedRect, distanceSegmentToRect,
} from '../../utils/geometry.js';
import { buildingFootprint } from './building.js';
import { pointAssetFootprint } from './pointAsset.js';

const DEFAULT_COUNT = 10;

// A scatter region is for people OR vehicles (§5: "People: Point or
// scatter region + density" / "Vehicles: ... Freeform placement, same as
// props" - vehicles get scatter too per FR-17's "people or vehicles").
export const SCATTER_CATEGORIES = ['people', 'vehicles'];

function assertPositive(field, value) {
  assertFiniteNumber('scatterRegion', field, value);
  if (!(value > 0)) {
    throw new RangeError(`scatterRegion: ${field} must be a positive number, got ${value}`);
  }
}

export function assertScatterCategory(category) {
  if (!SCATTER_CATEGORIES.includes(category)) {
    throw new RangeError(`scatterRegion: category must be one of ${SCATTER_CATEGORIES.join(', ')}, got ${category}`);
  }
}

export function assertCount(count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`scatterRegion: count must be a non-negative integer, got ${count}`);
  }
}

// The area one scattered instance occupies when it has no variant footprint
// to go on (or the manifest isn't loaded): a 1 m square, the same "a thing at
// a point" default props use.
export const DEFAULT_SCATTER_FOOTPRINT = Object.freeze({ width: 1, depth: 1 });

/**
 * The area one instance of this region occupies, in meters - what the editor
 * preview draws each scattered instance at, so a region of vehicles reads as
 * taking real room while a region of people barely does.
 *
 * A region can draw from several variants at once (FR-18) and only picks
 * between them at export time, so there is no single right answer per
 * instance. This takes the LARGEST of the variants the region may use: the
 * preview then shows how crowded the count could get, rather than
 * understating it. An empty `variantIds` means "any in the category", the
 * same as export-time generation treats it.
 */
export function scatterInstanceFootprint(region, manifest = null) {
  if (!manifest) return { ...DEFAULT_SCATTER_FOOTPRINT };
  const pool = region.variantIds.length > 0
    ? region.variantIds.map((id) => manifest.byId(id)).filter(Boolean)
    : manifest.byCategory(region.category);

  let largest = null;
  for (const asset of pool) {
    const f = asset.footprint;
    if (!f) continue;
    if (!largest || f.width * f.depth > largest.width * largest.depth) largest = f;
  }
  return largest ? { width: largest.width, depth: largest.depth } : { ...DEFAULT_SCATTER_FOOTPRINT };
}

/**
 * The sub-rect an instance's CENTRE may land in, so the whole instance stays
 * inside the region: the region inset by half the instance footprint on each
 * side. A scatter point marks the centre of the block an instance occupies,
 * so without this a 10 m-long vehicle centred near the edge hangs half its
 * length outside the area the user drew.
 *
 * When the region is smaller than one instance, the inset would invert - the
 * area collapses to the region's centre line on that axis instead, so every
 * instance is centred in the region rather than placed outside it.
 */
export function scatterPlacementArea(region, footprint = DEFAULT_SCATTER_FOOTPRINT) {
  const width = Math.max(0, region.width - footprint.width);
  const height = Math.max(0, region.height - footprint.depth);
  return {
    x: width > 0 ? region.x + footprint.width / 2 : region.x + region.width / 2,
    y: height > 0 ? region.y + footprint.depth / 2 : region.y + region.height / 2,
    width,
    height,
  };
}

/** A region's four corners, clockwise from its top-left (x, y). */
export function regionCorners({ x, y, width, height }) {
  return [
    { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
  ];
}

export function assertVariantIds(variantIds) {
  if (!Array.isArray(variantIds) || variantIds.some((v) => typeof v !== 'string' || v === '')) {
    throw new TypeError('scatterRegion: variantIds must be an array of non-empty strings');
  }
}

/**
 * Create a scatter-region data object. `category` ('people'|'vehicles'),
 * finite `x`/`y` (top-left corner) and positive `width`/`height` (meters)
 * are required. `count` is the target instance count (FR-17's "scatter N
 * people/vehicles in this area"); `variantIds` are the manifest asset ids
 * a generated instance may be assigned (FR-18) - may be empty if the
 * manifest doesn't have matching assets yet.
 */
export function createScatterRegion({
  id = null,
  category,
  x,
  y,
  width,
  height,
  count = DEFAULT_COUNT,
  variantIds = [],
} = {}) {
  assertScatterCategory(category);
  assertFiniteNumber('scatterRegion', 'x', x);
  assertFiniteNumber('scatterRegion', 'y', y);
  assertPositive('width', width);
  assertPositive('height', height);
  assertCount(count);
  assertVariantIds(variantIds);
  return {
    type: 'scatterRegion', id, category, x, y, width, height, count, variantIds: [...variantIds],
  };
}

// --- placement rules (FR-17/FR-18) ------------------------------------------
// Where a scattered instance may land, given everything else in the layout:
//  - never inside another placed object's footprint (building, prop,
//    individually placed vehicle or person);
//  - a VEHICLE only on a road; every other category (people) never on one.
// "Inside" is a point-in-footprint test on the instance's CENTER against each
// object's rotated footprint rect, and against each road's strip (within
// width/2 of the centerline, round-capped as drawn) - the instance's own size
// is not part of the test. Scattered instances are NOT tested against each
// other (same region or different regions): each is sampled independently.

// Rejection-sampling budget: at most this many candidate positions per
// requested instance. A region whose valid area is tiny (or empty - a
// vehicle region off-road) yields fewer than `count` instances rather than
// looping forever or placing one somewhere invalid.
export const MAX_ATTEMPTS_PER_INSTANCE = 30;

/**
 * Snapshot of what scatter placement has to respect, from the current
 * project: road strips and every placed object's footprint rect (manifest
 * sizes when `manifest` is given, else the editor defaults - same sizes as
 * the canvas draws). Plain data, so one snapshot serves many checks.
 */
export function scatterObstacles(project, manifest = null) {
  const rect = (e, { width, depth }) => ({
    x: e.x, y: e.y, width, depth, rotation: e.rotation,
  });
  return {
    roads: project.roads.map((r) => ({ points: r.points.map((p) => ({ x: p.x, y: p.y })), halfWidth: r.width / 2 })),
    footprints: [
      ...project.buildings.map((b) => rect(b, buildingFootprint(b, manifest))),
      ...[...project.props, ...project.vehicles, ...project.people]
        .map((e) => rect(e, pointAssetFootprint(e, manifest))),
    ],
  };
}

/**
 * The part of an obstacle snapshot that can affect a point inside `rect`
 * (`{x, y, width, height}`): roads whose strip reaches into it, and
 * footprints whose rotated rect could overlap it (tested conservatively by
 * the rect's circumscribed circle). isValidScatterPoint gives the same answer
 * for any point in `rect` against this subset as against the whole snapshot
 * - it is only an optimization, so a region's placement need not be redone
 * when something far away from it moves.
 */
export function obstaclesWithin(obstacles, rect) {
  const reaches = (px, py, radius) => {
    const dx = Math.max(rect.x - px, 0, px - (rect.x + rect.width));
    const dy = Math.max(rect.y - py, 0, py - (rect.y + rect.height));
    return Math.hypot(dx, dy) <= radius;
  };
  return {
    roads: obstacles.roads.filter((road) => road.points.slice(1).some(
      (b, i) => distanceSegmentToRect(road.points[i], b, rect) <= road.halfWidth,
    )),
    footprints: obstacles.footprints.filter((f) => reaches(f.x, f.y, Math.hypot(f.width, f.depth) / 2)),
  };
}

/** True if (x, y) lies on any road strip. */
export function isOnRoad(x, y, obstacles) {
  return obstacles.roads.some((road) => {
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i];
      const b = road.points[i + 1];
      if (distanceToSegment(x, y, a.x, a.y, b.x, b.y) <= road.halfWidth) return true;
    }
    return false;
  });
}

/** True if a `category` instance centered at (x, y) is a valid placement. */
export function isValidScatterPoint(category, x, y, obstacles) {
  const insideObject = obstacles.footprints.some(
    (f) => distanceToRotatedRect(x, y, f.x, f.y, f.width, f.depth, f.rotation) === 0,
  );
  if (insideObject) return false;
  const onRoad = isOnRoad(x, y, obstacles);
  return category === 'vehicles' ? onRoad : !onRoad;
}

/**
 * True if any road strip reaches into the area this region places instance
 * centers in - false means a vehicle region can place nothing at all (a
 * validation warning, see model/validation.js).
 */
export function regionTouchesRoad(region, obstacles, footprint = DEFAULT_SCATTER_FOOTPRINT) {
  const area = scatterPlacementArea(region, footprint);
  return obstacles.roads.some((road) => {
    for (let i = 0; i < road.points.length - 1; i++) {
      if (distanceSegmentToRect(road.points[i], road.points[i + 1], area) <= road.halfWidth) return true;
    }
    return false;
  });
}

/**
 * THE scatter placement algorithm (FR-17/FR-18) - the one implementation the
 * editor preview, Flatten, and (mirrored) the Blender importer all follow:
 *
 *   for i = 0, 1, 2, ... while fewer than `count` points are placed and
 *   i < count * MAX_ATTEMPTS_PER_INSTANCE:
 *     take candidate i, a unit-space pair (u, v) in [0, 1)
 *     map it onto the placement area (scatterPlacementArea):
 *       x = area.x + u * area.width, y = area.y + v * area.height
 *     keep (x, y) if isValidScatterPoint(category, x, y, obstacles)
 *
 * So a mostly-blocked region yields fewer than `count` points rather than
 * looping forever or placing one somewhere invalid.
 *
 * `candidate(i)` supplies the unit pairs. The importer draws them fresh from
 * a random source every time (randomCandidates - FR-18, no seed lock); the
 * editor preview replays a cached stream per region instead
 * (model/scatterPreview.js), which is what keeps its dots from reshuffling
 * on every edit. Either way the placement itself is this function.
 *
 * `footprint` is the area one instance occupies (scatterInstanceFootprint);
 * `obstacles` is a scatterObstacles snapshot of the layout. Returns world
 * points `{ x, y }` - rotation and variant are assigned later, per instance
 * (flattenInstances; the importer does the same).
 */
export function placeScatterPoints(region, {
  footprint = DEFAULT_SCATTER_FOOTPRINT, obstacles, candidate = randomCandidates(),
} = {}) {
  if (!obstacles) throw new TypeError('scatterRegion: placeScatterPoints needs an obstacles snapshot');
  const area = scatterPlacementArea(region, footprint);
  const budget = region.count * MAX_ATTEMPTS_PER_INSTANCE;
  const points = [];
  for (let i = 0; points.length < region.count && i < budget; i++) {
    const { u, v } = candidate(i);
    const x = area.x + u * area.width;
    const y = area.y + v * area.height;
    if (isValidScatterPoint(region.category, x, y, obstacles)) points.push({ x, y });
  }
  return points;
}

/**
 * A candidate source for placeScatterPoints that draws every pair fresh from
 * `rng` (u first, then v) - what export-time generation does. `rng` defaults
 * to Math.random and is only overridable for deterministic unit tests, not a
 * user-facing reproducibility toggle (deferred to v2, §12).
 */
export function randomCandidates(rng = Math.random) {
  return () => ({ u: rng(), v: rng() });
}

// --- flattening ---------------------------------------------------------------
// "Flatten" turns a region into ordinary individually placed vehicles/people
// at fixed positions (one-way; the region is removed - see
// Project.flattenScatterRegion, which uses these). It does not lock a seed on the region
// (§12 still defers that): once flattened there is no region left to
// re-randomize, just placed instances like any other (§5).

/**
 * The variant ids a flattened instance of this region may be given: the
 * region's own `variantIds`, or - when that is empty, "any in the category",
 * same as generation treats it - every manifest asset in the category. Empty
 * means the region can't be flattened (a placed instance needs a variant).
 */
export function flattenVariantPool(region, manifest = null) {
  if (region.variantIds.length > 0) return [...region.variantIds];
  return manifest ? manifest.byCategory(region.category).map((a) => a.id) : [];
}

/**
 * The instances a flatten places: one per point in `points` (world coords,
 * typically the editor preview's positions so the result is exactly what was
 * on screen), each given a random variant from flattenVariantPool and a
 * random facing rotation, uniform in [0, 360) - the same per-instance
 * randomness the importer applies. `rng` is only overridable for unit tests.
 */
export function flattenInstances(region, points, manifest = null, rng = Math.random) {
  const pool = flattenVariantPool(region, manifest);
  if (pool.length === 0) {
    throw new RangeError(`scatterRegion: "${region.id}" has no variants to flatten into`);
  }
  return points.map((p) => ({
    x: p.x,
    y: p.y,
    rotation: rng() * 360,
    variantId: pool[Math.floor(rng() * pool.length)],
  }));
}
