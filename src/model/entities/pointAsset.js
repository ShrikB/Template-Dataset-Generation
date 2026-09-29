// Shared shape for the "point + rotation + variant + scale" asset categories —
// props (trees, benches, signage, streetlights), vehicles and people (§5 of
// the requirements doc). Vehicles use freeform placement, same as props
// (lane-snapping is deferred to v2 - CLAUDE.md / §12); people are "point OR
// scatter region" (see entities/scatterRegion.js for the region half).
// Buildings are NOT one of these: they additionally carry height and a
// per-instance footprint override, so they keep their own entities/building.js.
//
// Coordinates are continuous floats in meters, never grid indices (FR-3).
// No DOM / canvas code lives here (NFR-5).
//
// §5 lists vehicles as "point + rotation + variant" with no scale of their
// own. They get one anyway, for the same reason props have one: scale is how
// an instance deviates from its variant's manifest footprint, and the
// inspector/renderer/hit-test paths are shared. A vehicle left at scale 1 is
// exactly the §5 shape.

import { assertFiniteNumber } from '../../utils/geometry.js';

// Footprint used when a variant has no `footprint` in the asset manifest (or
// the manifest isn't loaded): 1 m square - small enough to read as "a thing at
// a point" next to a 10 x 20 m house, rather than a guess at some particular
// object's size.
export const DEFAULT_POINT_ASSET_FOOTPRINT = Object.freeze({ width: 1, depth: 1 });

/**
 * Create a point-asset data object of the given `type`. `variantId` (a
 * manifest asset id) and a finite `x`/`y` position are required; everything
 * else has a sensible default.
 */
export function createPointAsset(type, {
  id = null,
  variantId,
  x,
  y,
  rotation = 0,
  scale = 1,
} = {}) {
  if (typeof variantId !== 'string' || variantId === '') {
    throw new TypeError(`${type}: variantId is required`);
  }
  assertFiniteNumber(type, 'x', x);
  assertFiniteNumber(type, 'y', y);
  assertFiniteNumber(type, 'rotation', rotation);
  assertFiniteNumber(type, 'scale', scale);

  return {
    type, id, variantId, x, y, rotation, scale,
  };
}

/** Create a prop / vehicle / person. `variantId` and a finite `x`/`y` are required. */
export const createProp = (data = {}) => createPointAsset('prop', data);
export const createVehicle = (data = {}) => createPointAsset('vehicle', data);
export const createPerson = (data = {}) => createPointAsset('person', data);

/**
 * A point asset's top-down footprint in meters: its variant's manifest
 * `footprint` multiplied by the asset's own `scale`. `width` runs along the
 * asset's rotated local x axis, same convention as buildingFootprint.
 *
 * Unlike a building, these have no per-instance size override - their size
 * comes from the variant (and `scale`) only.
 */
export function pointAssetFootprint(entity, manifest = null) {
  const asset = manifest ? manifest.byId(entity.variantId) : null;
  const base = (asset && asset.footprint) || DEFAULT_POINT_ASSET_FOOTPRINT;
  return { width: base.width * entity.scale, depth: base.depth * entity.scale };
}
