// ============================================================================
// PLACEHOLDER EXPORT FORMAT — NOT Document 2.
//
// Per CLAUDE.md: "Document 2: the export/interchange format... doesn't exist
// yet... expect [this file] to be rewritten later." Everything below is a
// deliberately minimal, reasonable-looking JSON shape covering the current
// model (buildings, props, roads, scatter regions) so the export dialog/
// trigger/validation UX (the actual M6 deliverable) has something real to
// call. Do NOT treat any field name, nesting, or unit convention here as
// settled - none of it has been reviewed against Document 2.
//
// One open question from §10 of the requirements doc that this file makes
// a placeholder call on: scatter regions are exported as region + density
// metadata (matching FR-18's "regenerated on each export"), NOT
// pre-expanded into a fixed point list - §10's open question #2 leaves
// that choice for Document 2/3 to actually decide.
//
// Revised after the export-format gap audit: the file now states its own
// units, axes, anchors and expansion rules (EXPORT_CONVENTIONS), flips to a
// y-up convention, keeps each entity's `type`, resolves footprints to
// concrete sizes, carries the manifest version, resolved junctions and
// export-time warnings. Still a placeholder until Document 2 formalizes it.
// ============================================================================

import { downloadJson, downloadBlob } from './download.js';
import { computeBaseSlab } from '../model/baseSlab.js';
import { buildingFootprint } from '../model/entities/building.js';
import { pointAssetFootprint } from '../model/entities/pointAsset.js';
import { findJunctions, CONNECT_EPSILON } from '../model/entities/road.js';
import { DEFAULT_SCATTER_FOOTPRINT, MAX_ATTEMPTS_PER_INSTANCE } from '../model/entities/scatterRegion.js';

export const EXPORT_FORMAT_VERSION = 'placeholder-1';

// The conventions every number in the file follows, written into the file
// itself (`conventions`) so an importer never has to guess them.
//
// The editor works in canvas coordinates: origin at the top-left corner,
// +y pointing DOWN the screen, rotation in degrees clockwise on screen. That
// stays the internal convention - the flip happens here, on the way out, to
// Blender's: Z up, and in the top-down view (looking down -Z) +X to the right
// and +Y up the screen, away from the default front-view camera. The canvas
// then spans x 0..canvas.width, y 0..canvas.depth with the origin at the
// corner that was bottom-left in the editor.
export const EXPORT_CONVENTIONS = Object.freeze({
  units: { length: 'meters', rotation: 'degrees' },
  axes: {
    origin: 'the canvas corner that is bottom-left in a top-down view',
    x: '+X is right (east) in a top-down view; the canvas spans 0..canvas.width',
    y: '+Y is up (north) in a top-down view, away from the default front-view camera; the canvas spans 0..canvas.depth',
    z: '+Z is up (Blender world up); the file carries no Z coordinates - everything stands on the ground plane',
    rotation: 'degrees counter-clockwise about +Z seen from above, normalized to [0, 360); at 0 an entity\'s local X (footprint width) runs along world +X and its local Y (footprint depth) along world +Y',
  },
  anchors: {
    'buildings, props, vehicles, people': 'x, y is the footprint center; the footprint rotates about it',
    scatterRegions: 'x, y is the center of an axis-aligned width x depth rectangle (never rotated)',
    base: 'x, y is the center of an axis-aligned width x depth rectangle (never rotated)',
    'roads, junctions': 'absolute points - no anchor',
  },
  sizes: {
    footprint: 'final top-down size in meters, footprintScale already applied - never null (a variant with no manifest footprint is resolved to the editor default here)',
    footprintScale: 'the multiplier the editor applied to the variant\'s footprint; informational - already included in footprint',
    height: 'buildings only: absolute height in meters; NOT multiplied by footprintScale',
  },
  roads: {
    points: 'ordered centerline polyline, straight segments only',
    width: 'full road width in meters (edge to edge), one value per path',
    laneWidth: 'meters; spacing of lane dividers when markings.laneDividers is on',
    surface: 'manifest roadStyles.surfaces id',
    markings: 'centerLine is a manifest roadStyles.centerLines id or "none"; laneDividers/crosswalk/stopLine are on/off manifest roadStyles.markingFeatures; crosswalk and stopLine sit at the LAST point of the path',
  },
  junctions: {
    connectionTolerance: CONNECT_EPSILON,
    connectionToleranceNote: 'meters; road points within this distance are the same location',
    attachments: 'one per place a road meets the junction: kind "vertex" = on points[pointIndex]; kind "segment" = partway along segment segmentIndex (points[i] -> points[i+1]); distanceAlongPath = meters from points[0] along the path',
  },
  scatterRegions: {
    count: 'exact number of instances to generate (an absolute count, not a density)',
    variantIds: 'manifest asset ids to pick from uniformly at random; an empty list means any manifest asset in the region\'s category',
    instanceFootprint: 'the largest manifest footprint among the pool; the default below when no pool asset has one',
    defaultInstanceFootprint: { ...DEFAULT_SCATTER_FOOTPRINT },
    placement: 'instance centers uniformly random within the region inset by half the instance footprint on each side, so whole instances stay inside; on an axis where the region is smaller than the footprint, centers sit on the region\'s center line',
    validPlacement: 'a candidate center is rejected when it falls inside any building/prop/vehicle/person footprint in this file (rotated rect); a vehicles-category center must lie on a road strip (within width/2 of the centerline, including the round end caps); every other category must not',
    overlapTest: 'point-in-footprint: only the instance center is tested, not its own footprint',
    instanceOverlap: 'scattered instances are not tested against each other, within or across regions',
    attempts: `rejected candidates are redrawn, up to ${MAX_ATTEMPTS_PER_INSTANCE} candidates per requested instance in total; a region may yield fewer than count instances (zero for a vehicles region no road reaches into - reported as a scatter-vehicles-no-road warning)`,
    rotation: 'uniformly random in [0, 360) per instance',
    randomization: 'regenerated on every import - no seed (FR-18)',
  },
  warnings: 'non-blocking validation warnings at export time (FR-22); message is the editor\'s text, in editor coordinates - use the structured fields',
  previewImage: 'optional: the filename of a PNG snapshot of the editor view, downloaded as a separate file next to this one (not embedded); absent when no preview was requested',
});

/**
 * Build the export payload from the current project state. Pure - no DOM,
 * fully unit-testable (tests/io/exporter.test.js) - the actual file
 * download (triggerDownload) is the only DOM-touching part of this module.
 *
 * `issues` is the validation result the export was allowed on; its
 * warnings are written into the file (see prepareExport).
 */
export function buildExportPayload(project, {
  previewImageFilename = null, manifest = null, base = {}, issues = [],
} = {}) {
  const depth = project.canvas.height;
  // Canvas (y down) -> export (y up) - see EXPORT_CONVENTIONS.
  const flipY = (y) => depth - y;
  const point = (p) => ({ x: p.x, y: flipY(p.y) });

  const pointAsset = (e, footprint) => ({
    type: e.type,
    id: e.id,
    variantId: e.variantId,
    x: e.x,
    y: flipY(e.y),
    rotation: exportRotation(e.rotation),
    footprintScale: e.scale,
    footprint,
  });

  const slab = computeBaseSlab(project, manifest, base);
  const payload = {
    formatVersion: EXPORT_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    manifestVersion: manifest ? manifest.version : null,
    conventions: EXPORT_CONVENTIONS,
    canvas: { width: project.canvas.width, depth },
    // The ground everything stands on, derived from what is actually placed
    // rather than from the canvas - null for an empty layout. `manifest` is
    // what sizes each entity's footprint; without it they fall back to their
    // default sizes and the slab is correspondingly approximate.
    base: slab && {
      ...centeredRect(slab.x, slab.y, slab.width, slab.depth, flipY),
      thickness: slab.thickness,
    },
    buildings: project.buildings.map((b) => ({
      ...pointAsset(b, buildingFootprint(b, manifest)),
      height: b.height, // absolute - footprintScale does not apply (building.js)
    })),
    props: project.props.map((e) => pointAsset(e, pointAssetFootprint(e, manifest))),
    vehicles: project.vehicles.map((e) => pointAsset(e, pointAssetFootprint(e, manifest))),
    people: project.people.map((e) => pointAsset(e, pointAssetFootprint(e, manifest))),
    roads: project.roads.map((r) => ({
      type: r.type,
      id: r.id,
      points: r.points.map(point),
      width: r.width,
      laneWidth: r.laneWidth,
      surface: r.surface,
      markings: { ...r.markings },
    })),
    // Resolved once here from the same function the editor draws junctions
    // with (FR-7), so Blender never has to re-derive road topology. The
    // disc width/surface are the editor's drawing detail and stay behind.
    junctions: findJunctions(project.roads).map((j) => ({
      ...point(j),
      roadIds: [...j.roadIds],
      attachments: j.attachments.map((att) => ({ ...att })),
    })),
    // Scatter regions stay regions + count (FR-18) - never pre-expanded
    // here; the rules for expanding them are in `conventions`.
    scatterRegions: project.scatterRegions.map((r) => ({
      type: r.type,
      id: r.id,
      category: r.category,
      ...centeredRect(r.x, r.y, r.width, r.height, flipY),
      count: r.count,
      variantIds: [...r.variantIds],
    })),
    warnings: issues.filter((i) => i.severity === 'warning').map((i) => exportWarning(i, flipY)),
  };
  // Only the sibling PNG's filename - the image itself is its own download
  // (FR-26), so the JSON stays small and the PNG stays a plain image file.
  if (previewImageFilename) payload.previewImage = previewImageFilename;
  return payload;
}

// Editor rotation is clockwise on a y-down screen; after the y flip the
// same turn is counter-clockwise-negative, so it is negated, then wrapped
// into [0, 360) (bulk rotate lets the editor value run past either end).
function exportRotation(deg) {
  const r = ((-deg % 360) + 360) % 360;
  return r === 0 ? 0 : r; // never -0
}

// An editor rect (top-left corner x, y; +y down) as its center in export
// coordinates.
function centeredRect(x, y, width, depth, flipY) {
  return {
    x: x + width / 2, y: flipY(y + depth / 2), width, depth,
  };
}

function exportWarning(issue, flipY) {
  const warning = { code: issue.code, message: issue.message, entityIds: [...(issue.entityIds || [])] };
  if (Number.isFinite(issue.x) && Number.isFinite(issue.y)) {
    warning.x = issue.x;
    warning.y = flipY(issue.y);
  }
  return warning;
}

// --- validation-gated export decision (FR-21, FR-22, FR-27) -----------------
// Pure - no DOM - so the "run validation, block on error, else export +
// summarize" flow the export dialog needs is fully unit-testable here.

/**
 * Decide whether export can proceed given already-computed validation
 * issues (see src/model/validation.js), and build both the export payload
 * and the FR-27 success summary in one pass. Only a blocking ERROR stops
 * export - any number of warnings still returns a payload (FR-22: "export
 * is still allowed with warnings present, never hard-blocked").
 */
export function prepareExport(project, issues, options = {}) {
  if (issues.some((i) => i.severity === 'error')) {
    return { blocked: true, issues };
  }
  return {
    blocked: false,
    payload: buildExportPayload(project, { ...options, issues }),
    summary: summarizeExport(project, issues, options),
  };
}

/** FR-27: counts per asset category, canvas size, base slab, and warnings carried over. */
export function summarizeExport(project, issues, { manifest = null, base = {} } = {}) {
  return {
    base: computeBaseSlab(project, manifest, base),
    counts: {
      buildings: project.buildings.length,
      props: project.props.length,
      roads: project.roads.length,
      vehicles: project.vehicles.length,
      people: project.people.length,
      scatterRegions: project.scatterRegions.length,
    },
    canvas: { ...project.canvas },
    warnings: issues.filter((i) => i.severity === 'warning'),
  };
}

// --- browser download (DOM-only, not unit-tested - same convention as the
// rest of ui/) --------------------------------------------------------------

const DEFAULT_FILENAME = 'layout-export.json';

/**
 * The preview image's filename for an export named `exportFilename`: the same
 * name with a .png extension ('layout-export.json' -> 'layout-export.png'),
 * so the two files sit side by side. Pure.
 */
export function previewImageFilenameFor(exportFilename = DEFAULT_FILENAME) {
  const name = exportFilename || DEFAULT_FILENAME;
  return `${name.replace(/\.json$/i, '')}.png`;
}

/**
 * Trigger the browser downloads for an export (FR-25/FR-26): the JSON
 * payload, plus the preview PNG as a sibling file when `previewImage` (a
 * Blob) is given - the payload is expected to name it (previewImageFilename).
 */
export function downloadExport(payload, filename = DEFAULT_FILENAME, { previewImage = null } = {}) {
  if (previewImage) downloadBlob(previewImage, payload.previewImage || previewImageFilenameFor(filename));
  downloadJson(payload, filename || DEFAULT_FILENAME);
}
