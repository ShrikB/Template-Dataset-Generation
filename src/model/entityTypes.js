// Every entity type the project holds, in one table - which project list it
// lives in, its id prefix, the factory that builds (and validates) it, its
// layer category and its display names. Anything that has to treat each
// type differently (adding, cloning, snapshot/restore, loading a project
// file, labels) reads it from here rather than keeping its own switch.
// Pure data + logic, no DOM (NFR-5).

import { createBuilding, buildingFootprint } from './entities/building.js';
import {
  createProp, createVehicle, createPerson, pointAssetFootprint,
} from './entities/pointAsset.js';
import { createRoad } from './entities/road.js';
import { createScatterRegion } from './entities/scatterRegion.js';

// Order is the order Project#allEntities() returns entities in.
// `placeable`: placed from the palette with a click (FR-11/FR-12) - the
// manifest category IS the project list name for these.
export const ENTITY_TYPES = Object.freeze([
  {
    type: 'building', list: 'buildings', idPrefix: 'bldg', create: createBuilding,
    label: 'building', plural: 'buildings', placeable: true,
  },
  {
    type: 'prop', list: 'props', idPrefix: 'prop', create: createProp,
    label: 'prop', plural: 'props', placeable: true,
  },
  {
    type: 'road', list: 'roads', idPrefix: 'road', create: createRoad,
    label: 'road', plural: 'roads', placeable: false,
  },
  {
    type: 'vehicle', list: 'vehicles', idPrefix: 'vehicle', create: createVehicle,
    label: 'vehicle', plural: 'vehicles', placeable: true,
  },
  {
    type: 'person', list: 'people', idPrefix: 'person', create: createPerson,
    label: 'person', plural: 'people', placeable: true,
  },
  {
    type: 'scatterRegion', list: 'scatterRegions', idPrefix: 'scatter', create: createScatterRegion,
    label: 'scatter region', plural: 'scatter regions', placeable: false,
  },
]);

const BY_TYPE = new Map(ENTITY_TYPES.map((t) => [t.type, t]));

/** The table entry for an entity type name ('building', 'scatterRegion', ...). */
export function entityType(type) {
  const t = BY_TYPE.get(type);
  if (!t) throw new RangeError(`entityTypes: unknown entity type "${type}"`);
  return t;
}

/** Manifest categories that are placed from the palette with a click. */
export const PLACEABLE_CATEGORIES = ENTITY_TYPES.filter((t) => t.placeable).map((t) => t.list);

/**
 * The entity type a palette asset of `category` places, or null for a
 * category that isn't click-placed (roads are drawn with the Road tool).
 */
export function placeableTypeFor(category) {
  const t = ENTITY_TYPES.find((e) => e.placeable && e.list === category);
  return t ? t.type : null;
}

/**
 * The FR-19 layer / manifest category an entity belongs to. For most types
 * that's its list name ('person' -> 'people'), but a scatter region's category
 * is its own field - that is what puts a region on the *same* layer toggle as
 * the individually placed people or vehicles it stands in for.
 */
export function categoryOf(entity) {
  if (entity.type === 'scatterRegion') return entity.category;
  return entityType(entity.type).list;
}

/**
 * An entity's `uid` (Document 2 §7): the number at the end of its id
 * ('bldg_12' -> 12), a positive integer. Every id the editor hands out comes
 * from one counter shared by all entity types (Project#_id), so it is unique
 * across the whole layout, not just within a type. Null when the id doesn't
 * end in one - only possible for an id that didn't come from the editor (a
 * hand-edited project file).
 */
export function entityUid(entity) {
  const match = /_([1-9]\d*)$/.exec(typeof entity.id === 'string' ? entity.id : '');
  if (!match) return null;
  const uid = Number(match[1]);
  return Number.isSafeInteger(uid) ? uid : null;
}

/**
 * A deep, independent copy of an entity. Every factory copies its nested
 * data (points, markings, footprint, variantIds), so rebuilding through it
 * is the clone - and re-validates the shape on the way.
 */
export function cloneEntity(entity) {
  return entityType(entity.type).create({ ...entity });
}

/**
 * The rotated rectangle an entity occupies, in meters, as drawn - or null for
 * types that have no footprint (roads, scatter regions).
 */
export function entityFootprint(entity, manifest = null) {
  if (entity.type === 'building') return buildingFootprint(entity, manifest);
  if (entity.type === 'prop' || entity.type === 'vehicle' || entity.type === 'person') {
    return pointAssetFootprint(entity, manifest);
  }
  return null;
}
