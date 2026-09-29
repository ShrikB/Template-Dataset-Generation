// Asset manifest (FR-11, FR-28, FR-29).
//
// The palette is driven entirely by this manifest — the same id -> name ->
// category -> thumbnail file the Blender add-on reads, so the two stay in sync.
// It is loaded ONCE at app start from public/manifest/asset-manifest.json;
// there is no live hot-reload or admin screen in v1 (edit the file + refresh).
//
// Pure data + validation: no DOM. `loadManifest` uses fetch (a plain web API,
// injectable for tests) — it never touches document or canvas.

import { MARKING_FEATURES, CENTER_LINE_NONE } from './entities/road.js';

export const MANIFEST_URL = '/manifest/asset-manifest.json';

// Categories from §5 of the requirements doc.
export const ASSET_CATEGORIES = ['buildings', 'roads', 'props', 'vehicles', 'people'];

export class Manifest {
  /**
   * `version` is the manifest file's own version number - carried into the
   * export so the Blender side can check it loaded the same manifest.
   * `roadStyles` is the parsed `roadStyles` section (see parseRoadStyles);
   * omitted, it is empty - no road style resolves, same as an asset id that
   * isn't listed.
   */
  constructor(assets = [], { version = 1, roadStyles = EMPTY_ROAD_STYLES } = {}) {
    this.assets = assets;
    this.version = version;
    this.roadStyles = roadStyles;
    this._byId = new Map(assets.map((a) => [a.id, a]));
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
 * Validate a raw manifest object and return `{ version, assets, roadStyles }` with each
 * asset normalized to `{ id, name, category, thumbnail, footprint }`.
 * `footprint` is an optional `{ width, depth }` in meters - the default
 * top-down size a building variant is drawn at in the editor (see
 * model/entities/building.js's buildingFootprint); null when absent. Throws on any
 * structural problem so a broken manifest fails loudly at startup.
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
      id, name, category, thumbnail, footprint,
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
    };
  });

  return {
    version: Number.isFinite(raw.version) ? raw.version : 1,
    assets,
    roadStyles: parseRoadStyles(raw.roadStyles),
  };
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
  const { version, assets, roadStyles } = parseManifest(raw);
  return new Manifest(assets, { version, roadStyles });
}
