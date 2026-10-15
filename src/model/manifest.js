// Asset manifest (FR-11, FR-28, FR-29).
//
// The palette is driven entirely by this manifest (id -> name -> category ->
// thumbnail). It is loaded ONCE at app start from
// public/manifest/asset-manifest.json; there is no live hot-reload or admin
// screen in v1 (edit the file + refresh).
//
// It is also where each asset's and material's Blender-side definition is
// authored (Document 2 §6, §12): a `source` (where the real model/material
// lives) and a `fallback` (the stand-in to build when that is missing). The
// Blender importer never reads this file - the exporter copies those
// definitions into each export (FMT-18), so an export is standalone.
//
// Pure data + validation: no DOM. `loadManifest` uses fetch (a plain web API,
// injectable for tests) — it never touches document or canvas.

import { MARKING_FEATURES, CENTER_LINE_NONE } from './entities/road.js';

export const MANIFEST_URL = '/manifest/asset-manifest.json';

// Categories from §5 of the requirements doc.
export const ASSET_CATEGORIES = ['buildings', 'roads', 'props', 'vehicles', 'people'];

// The values Document 2 defines for city-layout/1.0. The format's
// enumerations are open (FMT-32) - a later version may add to these - but a
// value this editor doesn't know is rejected here, so a typo fails at startup
// rather than quietly becoming a fallback box in Blender.
export const ASSET_SOURCE_KINDS = ['file', 'procedural']; // §6.3
export const FALLBACK_SHAPES = ['box', 'cylinder', 'cone']; // §6.4
export const MATERIAL_KINDS = ['surface', 'marking', 'ground']; // §12

// Procedural generators (FMT-14) and the numeric params each one needs.
export const PROCEDURAL_GENERATORS = Object.freeze({
  simple_building: Object.freeze(['floorHeight', 'windowSpacing']),
});

// A fallback has to state its own height for these: unlike a building, the
// entities placed from them carry no `height` of their own (§6.4).
const FALLBACK_HEIGHT_REQUIRED = ['props', 'vehicles', 'people'];

export class Manifest {
  /**
   * `version` is the manifest file's own version number - carried into the
   * export for traceability only (FMT-5).
   * `roadStyles` is the parsed `roadStyles` section (see parseRoadStyles);
   * omitted, it is empty - no road style resolves, same as an asset id that
   * isn't listed. `materials` is the parsed `materials` section (see
   * parseMaterials), empty when omitted.
   */
  constructor(assets = [], { version = 1, roadStyles = EMPTY_ROAD_STYLES, materials = [] } = {}) {
    this.assets = assets;
    this.version = version;
    this.roadStyles = roadStyles;
    this.materials = materials;
    this._byId = new Map(assets.map((a) => [a.id, a]));
    this._materialsById = new Map(materials.map((m) => [m.id, m]));
  }

  byId(id) {
    return this._byId.get(id) || null;
  }

  has(id) {
    return this._byId.has(id);
  }

  byCategory(category) {
    return this.assets.filter((a) => a.category === category);
  }

  /** Surface style ids (FR-8), resolved against the manifest like a variantId. */
  hasSurface(id) {
    return this.roadStyles.surfaces.some((s) => s.id === id);
  }

  /** Center-line style ids. 'none' (no center line) always resolves. */
  hasCenterLine(id) {
    return id === CENTER_LINE_NONE || this.roadStyles.centerLines.some((s) => s.id === id);
  }

  /** On/off marking features (lane dividers, crosswalk, stop line) this manifest offers. */
  hasMarkingFeature(id) {
    return this.roadStyles.markingFeatures.some((s) => s.id === id);
  }

  surface(id) {
    return this.roadStyles.surfaces.find((s) => s.id === id) || null;
  }

  /** A material definition (Document 2 §12) by id, or null. */
  material(id) {
    return this._materialsById.get(id) || null;
  }

  /** Distinct categories present in the manifest, in first-seen order. */
  categories() {
    const seen = [];
    for (const a of this.assets) {
      if (!seen.includes(a.category)) seen.push(a.category);
    }
    return seen;
  }
}

const EMPTY_ROAD_STYLES = Object.freeze({
  surfaces: Object.freeze([]),
  centerLines: Object.freeze([]),
  markingFeatures: Object.freeze([]),
});

/**
 * Validate a raw manifest object and return `{ version, assets, roadStyles,
 * materials }` with each asset normalized to `{ id, name, category,
 * thumbnail, footprint, source, fallback }`.
 * `footprint` is an optional `{ width, depth }` in meters - the default
 * top-down size a building variant is drawn at in the editor (see
 * model/entities/building.js's buildingFootprint); null when absent.
 * `source` and `fallback` are the asset's export definition (see
 * parseAssetSource / parseAssetFallback); each is null when absent, which
 * the editor itself never minds - only an export needs them.
 * Throws on any structural problem so a broken manifest fails loudly at
 * startup.
 */
export function parseManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('manifest: root must be an object');
  }
  if (!Array.isArray(raw.assets)) {
    throw new TypeError('manifest: "assets" must be an array');
  }

  const seen = new Set();
  const assets = raw.assets.map((entry, i) => {
    const at = `manifest: assets[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`${at} must be an object`);
    }
    const {
      id, name, category, thumbnail, footprint, source, fallback,
    } = entry;
    if (typeof id !== 'string' || id === '') {
      throw new TypeError(`${at}.id is required (non-empty string)`);
    }
    if (seen.has(id)) {
      throw new Error(`${at}.id "${id}" is duplicated`);
    }
    seen.add(id);
    if (typeof name !== 'string' || name === '') {
      throw new TypeError(`${at}.name is required (non-empty string)`);
    }
    if (!ASSET_CATEGORIES.includes(category)) {
      throw new TypeError(
        `${at}.category "${category}" is not one of: ${ASSET_CATEGORIES.join(', ')}`,
      );
    }
    if (thumbnail != null && typeof thumbnail !== 'string') {
      throw new TypeError(`${at}.thumbnail must be a string when present`);
    }
    if (footprint != null && !isValidFootprint(footprint)) {
      throw new TypeError(`${at}.footprint must be { width, depth } with positive numbers (meters)`);
    }
    return {
      id,
      name,
      category,
      thumbnail: thumbnail || null,
      footprint: footprint ? { width: footprint.width, depth: footprint.depth } : null,
      source: source == null ? null : parseAssetSource(source, `${at}.source`),
      fallback: fallback == null ? null : parseAssetFallback(fallback, `${at}.fallback`, category),
    };
  });

  return {
    version: Number.isFinite(raw.version) ? raw.version : 1,
    assets,
    roadStyles: parseRoadStyles(raw.roadStyles),
    materials: parseMaterials(raw.materials),
  };
}

// --- export definitions (Document 2 §6, §12) --------------------------------

/**
 * An asset's `source` (§6.3) - where its real model comes from:
 *
 *   { kind: 'file', path }                       a model file, or a folder of
 *                                                them (a "family", FMT-13),
 *                                                relative to the asset folder
 *   { kind: 'procedural', generator, params }    built in Blender, no file
 *                                                (FMT-14)
 */
function parseAssetSource(raw, at) {
  assertPlainObject(raw, at);
  if (!ASSET_SOURCE_KINDS.includes(raw.kind)) {
    throw new TypeError(`${at}.kind "${raw.kind}" is not one of: ${ASSET_SOURCE_KINDS.join(', ')}`);
  }
  if (raw.kind === 'file') {
    assertRelativePath(raw.path, `${at}.path`);
    return { kind: 'file', path: raw.path };
  }

  const paramNames = Object.hasOwn(PROCEDURAL_GENERATORS, raw.generator)
    ? PROCEDURAL_GENERATORS[raw.generator]
    : null;
  if (!paramNames) {
    throw new TypeError(
      `${at}.generator "${raw.generator}" is not one of: ${Object.keys(PROCEDURAL_GENERATORS).join(', ')}`,
    );
  }
  const params = raw.params == null ? {} : raw.params;
  assertPlainObject(params, `${at}.params`);
  for (const name of paramNames) {
    if (!isPositiveNumber(params[name])) {
      throw new TypeError(`${at}.params.${name} must be a positive number (meters)`);
    }
  }
  return { kind: 'procedural', generator: raw.generator, params: { ...params } };
}

/**
 * An asset's `fallback` (§6.4) - the primitive Blender builds when the
 * source can't be resolved: `{ shape, color, height }`. `height` (meters) is
 * required for props, vehicles and people; a building's stand-in uses the
 * placed building's own height, so there it is optional (null when absent).
 */
function parseAssetFallback(raw, at, category) {
  assertPlainObject(raw, at);
  if (!FALLBACK_SHAPES.includes(raw.shape)) {
    throw new TypeError(`${at}.shape "${raw.shape}" is not one of: ${FALLBACK_SHAPES.join(', ')}`);
  }
  assertColor(raw.color, `${at}.color`);
  if (raw.height == null) {
    if (FALLBACK_HEIGHT_REQUIRED.includes(category)) {
      throw new TypeError(`${at}.height is required for ${category} (positive number, meters)`);
    }
  } else if (!isPositiveNumber(raw.height)) {
    throw new TypeError(`${at}.height must be a positive number (meters)`);
  }
  return { shape: raw.shape, color: raw.color, height: raw.height == null ? null : raw.height };
}

/**
 * The manifest's `materials` section (§12): the Blender materials an export
 * can reference - one per road surface (same id as the `roadStyles.surfaces`
 * entry), the marking paints, and the ground under the base slab.
 *
 *   [{ id, kind, source: { path, name }, fallback: { color } }]
 *
 * `source.path` is a .blend file relative to the asset folder and
 * `source.name` the material's name inside it; `fallback.color` is the plain
 * color used when that can't be loaded. A missing section parses to an empty
 * list: nothing resolves, the same as a missing `roadStyles` section.
 */
function parseMaterials(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new TypeError('manifest: "materials" must be an array');
  }
  const seen = new Set();
  return raw.map((entry, i) => {
    const at = `manifest: materials[${i}]`;
    assertPlainObject(entry, at);
    if (typeof entry.id !== 'string' || entry.id === '') {
      throw new TypeError(`${at}.id is required (non-empty string)`);
    }
    if (seen.has(entry.id)) throw new Error(`${at}.id "${entry.id}" is duplicated`);
    seen.add(entry.id);
    if (!MATERIAL_KINDS.includes(entry.kind)) {
      throw new TypeError(`${at}.kind "${entry.kind}" is not one of: ${MATERIAL_KINDS.join(', ')}`);
    }
    assertPlainObject(entry.source, `${at}.source`);
    assertRelativePath(entry.source.path, `${at}.source.path`);
    if (!/\.blend$/i.test(entry.source.path)) {
      throw new TypeError(`${at}.source.path must be a .blend file, got "${entry.source.path}"`);
    }
    if (typeof entry.source.name !== 'string' || entry.source.name === '') {
      throw new TypeError(`${at}.source.name is required (the material's name inside the .blend file)`);
    }
    assertPlainObject(entry.fallback, `${at}.fallback`);
    assertColor(entry.fallback.color, `${at}.fallback.color`);
    return {
      id: entry.id,
      kind: entry.kind,
      source: { path: entry.source.path, name: entry.source.name },
      fallback: { color: entry.fallback.color },
    };
  });
}

function assertPlainObject(value, at) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${at} must be an object`);
  }
}

// FMT-12: forward slashes, relative to the asset folder, never absolute.
function assertRelativePath(path, at) {
  if (typeof path !== 'string' || path === '') {
    throw new TypeError(`${at} is required (non-empty string)`);
  }
  if (path.includes('\\')) {
    throw new TypeError(`${at} must use forward slashes, got "${path}"`);
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new TypeError(`${at} must be relative to the asset folder, got "${path}"`);
  }
}

function assertColor(color, at) {
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
    throw new TypeError(`${at} must be a "#rrggbb" color, got ${JSON.stringify(color)}`);
  }
}

function isPositiveNumber(v) {
  return Number.isFinite(v) && v > 0;
}

/**
 * The manifest's `roadStyles` section (FR-8): the road surface and marking
 * styles a road may use, resolved against the manifest the same way a
 * variantId is.
 *
 *   surfaces        [{ id, name, color? }]  drive-surface look; `color` is the
 *                                           editor's 2D preview fill only
 *   centerLines     [{ id, name }]          center-line styles ('none' is
 *                                           implicit - never listed)
 *   markingFeatures [{ id, name }]          on/off features offered, from the
 *                                           set the editor can store and draw
 *                                           (MARKING_FEATURES in road.js)
 *
 * A missing section parses to empty lists: nothing resolves, so any road
 * blocks export with a missing-reference error (FR-22) rather than
 * silently exporting a style Blender has never heard of.
 */
function parseRoadStyles(raw) {
  if (raw == null) return EMPTY_ROAD_STYLES;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('manifest: "roadStyles" must be an object');
  }
  const surfaces = parseStyleList(raw.surfaces, 'surfaces', (entry, at) => {
    if (entry.color != null && typeof entry.color !== 'string') {
      throw new TypeError(`${at}.color must be a string when present`);
    }
    return { color: entry.color || null };
  });
  const centerLines = parseStyleList(raw.centerLines, 'centerLines', (entry, at) => {
    if (entry.id === CENTER_LINE_NONE) {
      throw new TypeError(`${at}.id "${CENTER_LINE_NONE}" is implicit and must not be listed`);
    }
    return {};
  });
  const markingFeatures = parseStyleList(raw.markingFeatures, 'markingFeatures', (entry, at) => {
    if (!MARKING_FEATURES.includes(entry.id)) {
      throw new TypeError(
        `${at}.id "${entry.id}" is not a marking feature the editor supports: ${MARKING_FEATURES.join(', ')}`,
      );
    }
    return {};
  });
  return { surfaces, centerLines, markingFeatures };
}

function parseStyleList(raw, key, extra) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new TypeError(`manifest: roadStyles.${key} must be an array`);
  }
  const seen = new Set();
  return raw.map((entry, i) => {
    const at = `manifest: roadStyles.${key}[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`${at} must be an object`);
    }
    if (typeof entry.id !== 'string' || entry.id === '') {
      throw new TypeError(`${at}.id is required (non-empty string)`);
    }
    if (seen.has(entry.id)) throw new Error(`${at}.id "${entry.id}" is duplicated`);
    seen.add(entry.id);
    if (typeof entry.name !== 'string' || entry.name === '') {
      throw new TypeError(`${at}.name is required (non-empty string)`);
    }
    return { id: entry.id, name: entry.name, ...extra(entry, at) };
  });
}

function isValidFootprint(f) {
  return typeof f === 'object' && !Array.isArray(f)
    && Number.isFinite(f.width) && f.width > 0
    && Number.isFinite(f.depth) && f.depth > 0;
}

/**
 * Fetch and parse the manifest. `fetchFn` defaults to the global fetch and is
 * injectable for tests.
 */
export async function loadManifest(url = MANIFEST_URL, fetchFn = globalThis.fetch) {
  if (typeof fetchFn !== 'function') {
    throw new Error('manifest: no fetch implementation available');
  }
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`manifest: failed to load ${url} (HTTP ${res.status})`);
  }
  const raw = await res.json();
  const {
    version, assets, roadStyles, materials,
  } = parseManifest(raw);
  return new Manifest(assets, { version, roadStyles, materials });
}
