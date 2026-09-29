// Project — the single source of truth for editor state (NFR-5).
// Pure data + logic: zero DOM / canvas code. tools/ and ui/ mutate the project
// through these methods rather than holding their own copies of state.

import { normalizeFootprint } from './entities/building.js';
import {
  createRoad,
  movePoint as moveRoadPointOnEntity,
  splitRoadPoints,
  mergeRoadPoints,
  removeSegment,
  closeRoadPoints,
  assertWidth,
  assertSurface,
  createMarkings,
  assertLaneWidth,
} from './entities/road.js';
import {
  assertScatterCategory,
  assertCount as assertScatterCount,
  assertVariantIds,
  flattenInstances,
  regionCorners,
} from './entities/scatterRegion.js';
import {
  ENTITY_TYPES, entityType, cloneEntity, placeableTypeFor,
} from './entityTypes.js';
import { isFiniteNumber, assertFiniteNumber } from '../utils/geometry.js';

// One toggle-able layer per asset category (FR-19). Only buildings/props carry
// entities in M1; the rest are declared so layer state is complete from the start.
export const LAYERS = ['buildings', 'roads', 'props', 'vehicles', 'people'];

const DEFAULT_GRID = { size: 5, visible: true, snap: false };

export function createProject(opts = {}) {
  return new Project(opts);
}

export class Project {
  constructor({ width = 100, height = 100, grid = {} } = {}) {
    assertSize(width, height);
    // Canvas / site dimensions in meters (FR-1, FR-2).
    this.canvas = { width, height };
    // Snapping grid — a placement aid only (FR-3).
    this.grid = { ...DEFAULT_GRID, ...grid };
    // Per-category layer visibility / lock (FR-19).
    this.layers = {};
    for (const name of LAYERS) this.layers[name] = { visible: true, locked: false };
    // Placed entities, one list per type: this.buildings, this.props,
    // this.roads, this.vehicles, this.people, this.scatterRegions.
    for (const t of ENTITY_TYPES) this[t.list] = [];

    this._nextId = 1;
  }

  _id(prefix) {
    return `${prefix}_${this._nextId++}`;
  }

  // --- Canvas size (FR-2) -----------------------------------------------------
  // Expanding is always safe (nothing can fall outside a bigger canvas).
  // Shrinking can strand entities outside the new bounds - entitiesOutside()
  // below answers "what would be dropped" so the UI can confirm first, and
  // this setter stays a plain store either way. No partial-preservation
  // logic: what falls outside is dropped whole (§12 - deferred to v2).
  setCanvasSize(width, height) {
    assertSize(width, height);
    this.canvas = { width, height };
    return this.canvas;
  }

  /**
   * Every entity that would fall outside a canvas of `width` x `height`, in
   * the order they would be dropped. Same bounds rule as the FR-21
   * out-of-bounds validation: a point entity by its position, a road by any
   * of its path points, a region by any of its corners.
   *
   * Pass no size to test against the current canvas.
   */
  entitiesOutside(width = this.canvas.width, height = this.canvas.height) {
    assertSize(width, height);
    const inBounds = (x, y) => x >= 0 && x <= width && y >= 0 && y <= height;
    return this.allEntities().filter((e) => {
      if (e.type === 'road') return e.points.some((p) => !inBounds(p.x, p.y));
      if (e.type === 'scatterRegion') return regionCorners(e).some((p) => !inBounds(p.x, p.y));
      return !inBounds(e.x, e.y);
    });
  }

  /**
   * Resize the canvas, dropping whatever no longer fits (FR-2). Returns the
   * dropped entities so the caller can report them. Callers are expected to
   * have confirmed with the user first - entitiesOutside() is the preview of
   * exactly this - and to wrap it in one history step.
   */
  resizeCanvas(width, height) {
    const dropped = this.entitiesOutside(width, height);
    for (const e of dropped) this.removeEntity(e.id);
    this.setCanvasSize(width, height);
    return dropped;
  }

  // --- Entities (FR-12) ------------------------------------------------------
  /**
   * Add an entity of `type` ('building', 'road', ... - see entityTypes.js),
   * built and validated by that type's factory, with a fresh id.
   */
  addEntity(type, data = {}) {
    const t = entityType(type);
    const entity = t.create({ ...data, id: this._id(t.idPrefix) });
    this[t.list].push(entity);
    return entity;
  }

  addBuilding(data) { return this.addEntity('building', data); }

  addProp(data) { return this.addEntity('prop', data); }

  // Vehicles and people are individually placeable too (§5: vehicles are
  // "freeform placement, same as props"; people are "point OR scatter
  // region"). A scatter region stays the way to ask for many at once.
  addVehicle(data) { return this.addEntity('vehicle', data); }

  addPerson(data) { return this.addEntity('person', data); }

  allEntities() {
    return ENTITY_TYPES.flatMap((t) => this[t.list]);
  }

  getEntity(id) {
    return this.allEntities().find((e) => e.id === id) || null;
  }

  removeEntity(id) {
    for (const t of ENTITY_TYPES) {
      const i = this[t.list].findIndex((e) => e.id === id);
      if (i !== -1) return this[t.list].splice(i, 1)[0];
    }
    return null;
  }

  _entity(id) {
    const entity = this.getEntity(id);
    if (!entity) throw new RangeError(`project: unknown entity "${id}"`);
    return entity;
  }

  // --- Generic entity edits, for the inspector panel (FR-13) and bulk
  // selection ops (FR-14) --------------------------------------------------
  // Each setter only accepts entity types that actually carry that field -
  // e.g. roads have no x/y/rotation/scale, props have no height - so a
  // wrong-type call fails loudly rather than silently corrupting shape.

  /** Absolute position (buildings/props only - a road has no single position). */
  setEntityPosition(id, x, y) {
    assertFiniteNumber('project', 'x', x);
    assertFiniteNumber('project', 'y', y);
    const entity = this._entity(id);
    if (entity.type === 'road') {
      throw new RangeError('project: roads have no single position - move points individually');
    }
    entity.x = x;
    entity.y = y;
    return entity;
  }

  /** Shift an entity by (dx, dy) - for a road this shifts every point (FR-14 bulk move). */
  moveEntityBy(id, dx, dy) {
    assertFiniteNumber('project', 'dx', dx);
    assertFiniteNumber('project', 'dy', dy);
    const entity = this._entity(id);
    if (entity.type === 'road') {
      entity.points = entity.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    } else {
      entity.x += dx;
      entity.y += dy;
    }
    return entity;
  }

  setEntityRotation(id, rotation) {
    assertFiniteNumber('project', 'rotation', rotation);
    const entity = this._entity(id);
    assertHasField(entity, 'rotation');
    entity.rotation = rotation;
    return entity;
  }

  /** Rotate an entity by a relative amount, in degrees (FR-14 bulk rotate). */
  rotateEntityBy(id, deltaDeg) {
    assertFiniteNumber('project', 'deltaDeg', deltaDeg);
    const entity = this._entity(id);
    assertHasField(entity, 'rotation');
    entity.rotation += deltaDeg;
    return entity;
  }

  setEntityScale(id, scale) {
    assertFiniteNumber('project', 'scale', scale);
    if (!(scale > 0)) throw new RangeError(`project: scale must be a positive number, got ${scale}`);
    const entity = this._entity(id);
    assertHasField(entity, 'scale');
    entity.scale = scale;
    return entity;
  }

  /** Building height (buildings only - props have no height field). */
  setBuildingHeight(id, height) {
    assertFiniteNumber('project', 'height', height);
    const entity = this._building(id);
    entity.height = height;
    return entity;
  }

  /**
   * Give a building an explicit footprint size in meters, replacing the size
   * it would otherwise inherit from its variant's manifest entry (FR-13).
   * `scale` still multiplies on top - see buildingFootprint.
   */
  setBuildingFootprint(id, width, depth) {
    const entity = this._building(id);
    entity.footprint = normalizeFootprint({ width, depth });
    return entity;
  }

  /** Drop a building's size override so it follows its variant again (FR-13). */
  clearBuildingFootprint(id) {
    const entity = this._building(id);
    entity.footprint = null;
    return entity;
  }

  _building(id) {
    const entity = this._entity(id);
    if (entity.type !== 'building') {
      throw new RangeError(`project: entity "${id}" is not a building`);
    }
    return entity;
  }

  /**
   * Swap the manifest asset id of a building/prop instance (variant dropdown,
   * FR-13). A building's `footprint` override is deliberately left alone - an
   * explicitly typed size outlives switching the variant back and forth.
   */
  setEntityVariant(id, variantId) {
    if (typeof variantId !== 'string' || variantId === '') {
      throw new TypeError('project: variantId is required');
    }
    const entity = this._entity(id);
    assertHasField(entity, 'variantId');
    entity.variantId = variantId;
    return entity;
  }

  // --- Undo/redo support (FR-16) ------------------------------------------
  // Plain-data snapshot of every mutable field, deep-cloned so neither side
  // can mutate the other's copy afterwards. `history.js` calls these - it
  // has no idea what a "building" or "road" is, it just snapshots/restores
  // whatever this returns/accepts.

  snapshot() {
    const snap = {
      canvas: { ...this.canvas },
      grid: { ...this.grid },
      layers: mapValues(this.layers, (l) => ({ ...l })),
      nextId: this._nextId,
    };
    for (const t of ENTITY_TYPES) snap[t.list] = this[t.list].map(cloneEntity);
    return snap;
  }

  restore(snapshot) {
    this.canvas = { ...snapshot.canvas };
    this.grid = { ...snapshot.grid };
    this.layers = mapValues(snapshot.layers, (l) => ({ ...l }));
    for (const t of ENTITY_TYPES) this[t.list] = snapshot[t.list].map(cloneEntity);
    this._nextId = snapshot.nextId;
  }

  // --- Roads (FR-5, FR-6, FR-9) -----------------------------------------
  // Points are continuous floats (meters), same as buildings/props (FR-3).
  // One width value per whole path, not per segment (FR-6, locked-in - no
  // tapering). A road is only added once it has >= 2 points - an
  // in-progress draft path (single click so far) is transient tool state,
  // not project state, so it never exists here half-formed.

  addRoad(data) { return this.addEntity('road', data); }

  /** Drag an existing path point to reshape the road. */
  moveRoadPoint(roadId, index, x, y) {
    return moveRoadPointOnEntity(this._road(roadId), index, x, y);
  }

  setRoadWidth(roadId, width) {
    assertWidth(width);
    const road = this._road(roadId);
    road.width = width;
    return road;
  }

  /**
   * Set the lane width this path's lane dividers are spaced by (FR-8,
   * per-path like every other road style property).
   */
  setRoadLaneWidth(roadId, laneWidth) {
    assertLaneWidth(laneWidth);
    const road = this._road(roadId);
    road.laneWidth = laneWidth;
    return road;
  }

  /** Set the drive-surface style for a whole path (FR-8, per-path only). */
  setRoadSurface(roadId, surface) {
    assertSurface(surface);
    const road = this._road(roadId);
    road.surface = surface;
    return road;
  }

  /** Set the marking style for a whole path (FR-8, per-path only). */
  /**
   * Set the whole marking set for a path (FR-8). Callers pass a complete or
   * partial marking object - anything omitted falls back to off - so a single
   * toggle is `{ ...road.markings, crosswalk: true }`. Normalized into a
   * fresh object, so no two roads ever share one.
   */
  setRoadMarkings(roadId, markings) {
    const normalized = createMarkings(markings);
    const road = this._road(roadId);
    road.markings = normalized;
    return road;
  }

  /**
   * Split a road at an interior point into two roads that still share that
   * point. Replaces the original road with two new entities, carrying over
   * its width/surface/markings (FR-6, FR-8: per-path properties).
   */
  splitRoad(roadId, index) {
    const road = this._road(roadId);
    const [ptsA, ptsB] = splitRoadPoints(road, index);
    const style = {
      width: road.width, surface: road.surface, markings: road.markings, laneWidth: road.laneWidth,
    };
    const roadA = createRoad({ id: this._id('road'), points: ptsA, ...style });
    const roadB = createRoad({ id: this._id('road'), points: ptsB, ...style });
    this.roads.splice(this.roads.indexOf(road), 1, roadA, roadB);
    return [roadA, roadB];
  }

  /**
   * Merge two roads that share an endpoint into one path. The merged road
   * takes its width/surface/markings from `roadIdA` (FR-6, FR-8).
   */
  mergeRoads(roadIdA, roadIdB) {
    if (roadIdA === roadIdB) {
      throw new RangeError('project: cannot merge a road with itself');
    }
    const a = this._road(roadIdA);
    const b = this._road(roadIdB);
    const points = mergeRoadPoints(a, b);
    const merged = createRoad({
      id: this._id('road'),
      points,
      width: a.width,
      surface: a.surface,
      markings: a.markings,
      laneWidth: a.laneWidth,
    });
    this.roads = this.roads.filter((r) => r !== a && r !== b);
    this.roads.push(merged);
    return merged;
  }

  /**
   * Close a road into a loop by joining its last point back to its first
   * (FR-9). Same road, same id and style - just one more segment.
   */
  closeRoad(roadId) {
    const road = this._road(roadId);
    road.points = closeRoadPoints(road);
    return road;
  }

  /**
   * Delete one segment of a road. Removing an end segment shortens the
   * road; removing an interior segment splits it into two roads (leaving a
   * gap - the exposed ends may show as dangling, FR-10), each carrying over
   * the original width/surface/markings.
   */
  deleteRoadSegment(roadId, segmentIndex) {
    const road = this._road(roadId);
    const result = removeSegment(road, segmentIndex);
    const i = this.roads.indexOf(road);

    if (result.kind === 'empty') {
      this.roads.splice(i, 1);
      return { kind: 'removed' };
    }
    if (result.kind === 'shrink') {
      road.points = result.points;
      return { kind: 'shrink', road };
    }
    const [ptsA, ptsB] = result.points;
    const style = {
      width: road.width, surface: road.surface, markings: road.markings, laneWidth: road.laneWidth,
    };
    const roadA = createRoad({ id: this._id('road'), points: ptsA, ...style });
    const roadB = createRoad({ id: this._id('road'), points: ptsB, ...style });
    this.roads.splice(i, 1, roadA, roadB);
    return { kind: 'split', roads: [roadA, roadB] };
  }

  _road(id) {
    const road = this.roads.find((r) => r.id === id);
    if (!road) throw new RangeError(`project: unknown road "${id}"`);
    return road;
  }

  // --- Scatter regions (FR-17, FR-18) --------------------------------------
  // A region + density parameters only - never pre-expanded into a fixed
  // point list (placement is regenerated by placeScatterPoints - for the
  // editor preview in model/scatterPreview.js, and by the importer).
  // x/y/width/height use the same setEntityPosition/moveEntityBy as
  // buildings/props (a region's "position" is its top-left corner) - only
  // category/count/variants/size need dedicated setters below.

  addScatterRegion(data) { return this.addEntity('scatterRegion', data); }

  setScatterCategory(id, category) {
    assertScatterCategory(category);
    const region = this._scatterRegion(id);
    region.category = category;
    return region;
  }

  setScatterCount(id, count) {
    assertScatterCount(count);
    const region = this._scatterRegion(id);
    region.count = count;
    return region;
  }

  setScatterVariants(id, variantIds) {
    assertVariantIds(variantIds);
    const region = this._scatterRegion(id);
    region.variantIds = [...variantIds];
    return region;
  }

  setScatterSize(id, width, height) {
    if (!(isFiniteNumber(width) && width > 0)) {
      throw new RangeError(`project: width must be a positive number, got ${width}`);
    }
    if (!(isFiniteNumber(height) && height > 0)) {
      throw new RangeError(`project: height must be a positive number, got ${height}`);
    }
    const region = this._scatterRegion(id);
    region.width = width;
    region.height = height;
    return region;
  }

  /**
   * Replace a region with individually placed vehicles/people, one per point
   * in `points` (world coords - the editor preview's positions, so the result
   * is what was on screen). Each gets a random variant from the region's pool
   * (see flattenVariantPool) and a random rotation, and its own id - an
   * ordinary entity from then on. Returns the new entities. Callers wrap this
   * in one history step (history.record rolls it all back if it throws, e.g.
   * no variant to place).
   */
  flattenScatterRegion(id, points, manifest = null, rng = Math.random) {
    const region = this._scatterRegion(id);
    const type = placeableTypeFor(region.category);
    const created = flattenInstances(region, points, manifest, rng)
      .map((instance) => this.addEntity(type, instance));
    this.removeEntity(id);
    return created;
  }

  _scatterRegion(id) {
    const region = this.scatterRegions.find((r) => r.id === id);
    if (!region) throw new RangeError(`project: unknown scatter region "${id}"`);
    return region;
  }

  // --- Layers (FR-19) -------------------------------------------------------
  setLayerVisible(name, visible) {
    this._layer(name).visible = !!visible;
  }

  setLayerLocked(name, locked) {
    this._layer(name).locked = !!locked;
  }

  isLayerVisible(name) {
    return this._layer(name).visible;
  }

  isLayerLocked(name) {
    return this._layer(name).locked;
  }

  _layer(name) {
    const layer = this.layers[name];
    if (!layer) throw new RangeError(`project: unknown layer "${name}"`);
    return layer;
  }

  // --- Grid (FR-3) --------------------------------------------------------
  setGridSize(size) {
    if (!isFiniteNumber(size) || size <= 0) {
      throw new RangeError(`project: grid size must be a positive number, got ${size}`);
    }
    this.grid.size = size;
  }

  setGridVisible(visible) {
    this.grid.visible = !!visible;
  }

  setGridSnap(snap) {
    this.grid.snap = !!snap;
  }
}

function assertSize(width, height) {
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
    throw new RangeError(
      `project: canvas size must be positive numbers, got ${width} x ${height}`,
    );
  }
}

function assertHasField(entity, field) {
  if (!(field in entity)) {
    throw new RangeError(`project: entity "${entity.id}" (${entity.type}) has no ${field} field`);
  }
}

function mapValues(obj, fn) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}
