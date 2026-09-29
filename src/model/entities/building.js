// Building instance — plain data shape (§5 of the requirements doc).
// Point (footprint origin) + rotation + variant + height/scale.
// The position is the footprint's CENTER; rotation turns it about that point.
// Coordinates are continuous floats in meters, never grid indices (FR-3).
// No DOM / canvas code lives here (NFR-5).

import { isFiniteNumber, assertFiniteNumber } from '../../utils/geometry.js';

/**
 * Create a building data object. `variantId` (a manifest asset id) and a
 * finite `x`/`y` position are required; everything else has a sensible default.
 *
 * `footprint` is an optional `{ width, depth }` size override in meters
 * (FR-13). Null - the default - means "follow the variant's manifest size".
 */
export function createBuilding({
  id = null,
  variantId,
  x,
  y,
  rotation = 0,
  scale = 1,
  height = 10,
  footprint = null,
} = {}) {
  if (typeof variantId !== 'string' || variantId === '') {
    throw new TypeError('building: variantId is required');
  }
  assertFiniteNumber('building', 'x', x);
  assertFiniteNumber('building', 'y', y);
  assertFiniteNumber('building', 'rotation', rotation);
  assertFiniteNumber('building', 'scale', scale);
  assertFiniteNumber('building', 'height', height);

  return {
    type: 'building', id, variantId, x, y, rotation, scale, height,
    footprint: normalizeFootprint(footprint),
  };
}

// Footprint used when a building's variant has no `footprint` in the asset
// manifest (or the manifest isn't loaded): 200 m², same as a standard house.
export const DEFAULT_BUILDING_FOOTPRINT = Object.freeze({ width: 10, depth: 20 });

/**
 * Validate an optional `{ width, depth }` size override and return a fresh
 * copy, so no two entities ever share one footprint object (a shallow entity
 * clone - snapshot/restore, copy/paste - would otherwise alias it). Null and
 * undefined both mean "no override".
 */
export function normalizeFootprint(footprint) {
  if (footprint == null) return null;
  if (typeof footprint !== 'object' || Array.isArray(footprint)) {
    throw new TypeError('building: footprint must be { width, depth } in meters, or null');
  }
  const { width, depth } = footprint;
  if (!(isFiniteNumber(width) && width > 0) || !(isFiniteNumber(depth) && depth > 0)) {
    throw new TypeError(
      `building: footprint width/depth must be positive numbers (meters), got ${width} x ${depth}`,
    );
  }
  return { width, depth };
}

/**
 * The size a building's variant contributes, before the building's own scale:
 * its manifest `footprint`, or DEFAULT_BUILDING_FOOTPRINT when the variant
 * has none / the manifest isn't loaded. This is what "reset to variant size"
 * goes back to.
 */
export function variantFootprint(building, manifest = null) {
  const asset = manifest ? manifest.byId(building.variantId) : null;
  return (asset && asset.footprint) || DEFAULT_BUILDING_FOOTPRINT;
}

/**
 * A building's top-down footprint in meters, as drawn: its own `footprint`
 * override if it has one, else its variant's manifest size, multiplied by the
 * building's `scale`. `width` runs along the building's rotated local x axis.
 *
 * `scale` is a FOOTPRINT multiplier only: `height` is an absolute value in
 * meters and is never multiplied by it (the export names the field
 * `footprintScale` for exactly this reason - see io/exporter.js).
 *
 * An override is deliberately NOT cleared by a variant swap - a size typed
 * into the inspector outlives switching the asset back and forth, and is
 * dropped only by project.clearBuildingFootprint (FR-13).
 */
export function buildingFootprint(building, manifest = null) {
  const base = building.footprint || variantFootprint(building, manifest);
  return { width: base.width * building.scale, depth: base.depth * building.scale };
}
