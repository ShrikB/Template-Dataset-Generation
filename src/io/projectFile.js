// Project save/load (FR-23) — explicit file only, never autosave/crash
// recovery (locked-in decision, CLAUDE.md).
//
// This is a DIFFERENT format from M6's export (src/io/exporter.js): export
// produces the Blender-facing `city-layout` file (Document 2 - a deliberately
// different, lossy-by-design shape in Blender's coordinates); this file
// round-trips the editor's own full internal state so a layout can be closed
// and resumed in THIS tool.
//
// Rather than writing a second entity-to-plain-object serializer, this
// reuses what already exists:
//   - Project.snapshot()/restore() (src/model/project.js) already IS a full,
//     tested "all entities + canvas size + layer state (+ grid, + id
//     counter)" serializer/deserializer — that's exactly FR-23's scope, and
//     it's the same mechanism undo/redo already relies on.
//   - Each entity type's own factory (model/entityTypes.js) already validates its shape (required
//     fields, finite numbers, enums, etc.) — reused here to both validate
//     and freshly clone every loaded entity, rather than re-deriving that
//     validation a second time.
// The only piece actually shared with exporter.js is the browser-download
// mechanics, factored out into src/io/download.js.

import { createProject, LAYERS } from '../model/project.js';
import { ENTITY_TYPES } from '../model/entityTypes.js';
import { isFiniteNumber } from '../utils/geometry.js';
import { downloadJson } from './download.js';
import { computeBaseSlab } from '../model/baseSlab.js';

// project-v2: road markings are always a markings object (FR-8).
// project-v1: markings might still be a single pre-FR-8 style string.
// Older versions keep loading - see MIGRATIONS below.
export const PROJECT_FILE_FORMAT_VERSION = 'project-v2';
export const DEFAULT_PROJECT_FILENAME = 'layout-project.json';

/** Thrown for any malformed/foreign project file — always has a clear, user-facing message. */
export class ProjectFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

/**
 * Build the save-file payload from the current project state. Pure - no DOM,
 * fully unit-testable. `project.snapshot()` already deep-clones everything.
 */
export function serializeProject(project, { manifest = null, base = {} } = {}) {
  return {
    formatVersion: PROJECT_FILE_FORMAT_VERSION,
    savedAt: new Date().toISOString(),
    // Derived, not authored: recomputed on every save and ignored on load, so
    // it can never disagree with `project` below. It sits outside `project`
    // for exactly that reason - it is a description OF the layout, not part
    // of the layout's state.
    base: computeBaseSlab(project, manifest, base),
    project: project.snapshot(),
  };
}

/**
 * Validate a parsed project-file object and return a snapshot-shaped plain
 * object ready to pass to `Project#restore()`. Throws `ProjectFileError`
 * with a clear message on any structural problem instead of letting a
 * malformed/foreign file crash the app.
 */
export function deserializeProject(raw) {
  assertShape(raw);
  const migrate = MIGRATIONS[raw.formatVersion];
  return reconstructSnapshot(migrate ? migrate(raw.project) : raw.project);
}

// --- migrations ----------------------------------------------------------------
// Each older format version maps to a function that turns its `project`
// data into the current version's shape, before validation. The model's
// factories only accept the current shape.

// A pre-FR-8 road stored its markings as one style string. Mapping them
// forward keeps those files loadable - dropping to "no markings" would
// silently lose authored data.
const LEGACY_MARKINGS = {
  none: {},
  solid: { centerLine: 'solid' },
  dashed: { centerLine: 'dashed' },
  'double-yellow': { centerLine: 'double-yellow' },
  crosswalk: { crosswalk: true },
  'stop-line': { stopLine: true },
};

function migrateV1(p) {
  return {
    ...p,
    roads: p.roads.map((road, i) => {
      if (!isPlainObject(road) || typeof road.markings !== 'string') return road;
      const mapped = LEGACY_MARKINGS[road.markings];
      if (!mapped) {
        throw new ProjectFileError(
          `project file: "project.roads[${i}]" is invalid - unknown marking style "${road.markings}" `
          + `(expected one of ${Object.keys(LEGACY_MARKINGS).join(', ')})`,
        );
      }
      return { ...road, markings: { ...mapped } };
    }),
  };
}

const MIGRATIONS = {
  'project-v1': migrateV1,
};

/** Parse raw file text (e.g. from `File#text()`) into a restorable snapshot. */
export function parseProjectFileText(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ProjectFileError(`project file: could not parse as JSON (${err.message})`);
  }
  return deserializeProject(raw);
}

// --- validation --------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assertShape(raw) {
  if (!isPlainObject(raw)) {
    throw new ProjectFileError('project file: root must be a JSON object');
  }
  if (raw.formatVersion !== PROJECT_FILE_FORMAT_VERSION && !MIGRATIONS[raw.formatVersion]) {
    throw new ProjectFileError(
      `project file: unrecognized format "${raw.formatVersion}" `
      + `(expected "${PROJECT_FILE_FORMAT_VERSION}" - this may be an export file, not a project file, or from an incompatible version)`,
    );
  }
  if (!isPlainObject(raw.project)) {
    throw new ProjectFileError('project file: missing "project" data');
  }

  const p = raw.project;
  assertCanvas(p.canvas);
  assertGrid(p.grid);
  assertLayers(p.layers);
  for (const key of ['buildings', 'props', 'roads', 'scatterRegions']) {
    if (!Array.isArray(p[key])) {
      throw new ProjectFileError(`project file: "project.${key}" must be an array`);
    }
  }
  // Individually placed vehicles/people arrived after the first project files
  // were written (FR-11), so a file without them is valid - it simply has
  // none. Anything present must still be a well-formed array.
  for (const key of ['vehicles', 'people']) {
    if (p[key] !== undefined && !Array.isArray(p[key])) {
      throw new ProjectFileError(`project file: "project.${key}" must be an array`);
    }
  }
  if (!Number.isInteger(p.nextId) || p.nextId < 1) {
    throw new ProjectFileError('project file: "project.nextId" must be a positive integer');
  }
}

function assertCanvas(canvas) {
  if (!isPlainObject(canvas) || !isFiniteNumber(canvas.width) || !isFiniteNumber(canvas.height)
    || canvas.width <= 0 || canvas.height <= 0) {
    throw new ProjectFileError('project file: "project.canvas" must have positive width/height numbers');
  }
}

function assertGrid(grid) {
  if (!isPlainObject(grid) || !isFiniteNumber(grid.size) || grid.size <= 0
    || typeof grid.visible !== 'boolean' || typeof grid.snap !== 'boolean') {
    throw new ProjectFileError('project file: "project.grid" is missing or malformed');
  }
}

function assertLayers(layers) {
  if (!isPlainObject(layers)) {
    throw new ProjectFileError('project file: "project.layers" must be an object');
  }
  for (const name of LAYERS) {
    const layer = layers[name];
    if (!isPlainObject(layer) || typeof layer.visible !== 'boolean' || typeof layer.locked !== 'boolean') {
      throw new ProjectFileError(`project file: "project.layers.${name}" is missing or malformed`);
    }
  }
}

function requireId(entity) {
  if (!isPlainObject(entity) || typeof entity.id !== 'string' || entity.id === '') {
    throw new Error('missing a valid "id"');
  }
  return entity.id;
}

/** Reconstruct + validate every entity via its own constructor, in one pass, with a clear per-entry error on failure. */
function mapEntities(list, key, factory) {
  return list.map((entry, i) => {
    try {
      return factory({ ...entry, id: requireId(entry) });
    } catch (err) {
      throw new ProjectFileError(`project file: "project.${key}[${i}]" is invalid - ${err.message}`);
    }
  });
}

function reconstructSnapshot(p) {
  const snapshot = {
    canvas: { width: p.canvas.width, height: p.canvas.height },
    grid: { size: p.grid.size, visible: p.grid.visible, snap: p.grid.snap },
    layers: Object.fromEntries(
      LAYERS.map((name) => [name, { visible: p.layers[name].visible, locked: p.layers[name].locked }]),
    ),
    nextId: p.nextId,
  };
  // `|| []`: older files have no vehicles/people lists (see assertShape).
  for (const t of ENTITY_TYPES) snapshot[t.list] = mapEntities(p[t.list] || [], t.list, t.create);
  return snapshot;
}

// --- browser save/load (DOM/File-only, not unit-tested for the download
// half - same convention as exporter.js; loadProjectFileInto is pure enough
// past File#text() to cover in tests/io/) -----------------------------------

/** Serialize and trigger a browser download of the project file (FR-23). */
export function downloadProjectFile(project, filename = DEFAULT_PROJECT_FILENAME, options = {}) {
  return downloadJson(serializeProject(project, options), filename || DEFAULT_PROJECT_FILENAME);
}

/**
 * Read a File/Blob (e.g. from a file input) and restore it onto `project` in
 * place, so every existing reference to `project` (renderer, tools, panels)
 * keeps working post-load. Throws `ProjectFileError` on a malformed/foreign
 * file - callers should catch it and show `err.message` rather than let it
 * crash the app.
 */
export async function loadProjectFileInto(project, file) {
  const text = await file.text();
  const snapshot = parseProjectFileText(text);
  project.restore(snapshot);
  return project;
}

/** Build a fresh Project from a project-file snapshot (used by tests / callers with no live project yet). */
export function projectFromSnapshot(snapshot) {
  const project = createProject({ width: snapshot.canvas.width, height: snapshot.canvas.height, grid: snapshot.grid });
  project.restore(snapshot);
  return project;
}
