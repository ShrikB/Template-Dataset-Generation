// The Blender-facing export: the `city-layout/1.0` format defined by
// Document 2 (docs/requirements/02-export-format.md). That document is the
// contract with the importer and is normative - where this file and it
// disagree, this file has the bug. FMT-### / SCT-### below are its rule ids.
//
// A format change is one change (FMT-29): Document 2, its §18 version
// history, this file, EXPORT_CONVENTIONS below and a test fixture all move
// together.
//
// The file is STANDALONE: every asset and material the layout uses is copied
// in from the manifest (`library`), so the importer never reads the manifest.
// It is RESOLVED: footprints, junctions, marking positions and scatter pools
// are written out in final form, so Blender never re-implements editor logic.
//
// The editor works in canvas coordinates: origin at the top-left corner,
// +y pointing DOWN the screen, rotation in degrees clockwise on screen. That
// stays the internal convention - the flip happens here, on the way out, to
// Blender's: Z up, and in the top-down view (looking down -Z) +X to the right
// and +Y up the screen. Nothing downstream flips Y again (§3.2).

import { downloadJson, downloadBlob } from './download.js';
import { computeBaseSlab, BASE_MATERIAL_ID } from '../model/baseSlab.js';
import { buildingFootprint } from '../model/entities/building.js';
import { pointAssetFootprint } from '../model/entities/pointAsset.js';
import { findJunctions, isClosedRoad, CONNECT_EPSILON } from '../model/entities/road.js';
import {
  scatterInstanceFootprint, DEFAULT_SCATTER_FOOTPRINT, MAX_ATTEMPTS_PER_INSTANCE,
} from '../model/entities/scatterRegion.js';
import { entityUid } from '../model/entityTypes.js';
import { roadMarkingGeometry } from '../model/roadMarkings.js';
import { usedAssets, usedMaterials, scatterVariantPool } from '../model/libraryReferences.js';

export const EXPORT_FORMAT_VERSION = 'city-layout/1.0';

// The asset folder's name inside the project folder (§6.1). The importer is
// told where the project folder is (FMT-33); every `source.path` in the file
// is relative to this folder (FMT-12).
export const DEFAULT_ASSET_ROOT = 'assets';

/**
 * Thrown when a layout can't be written as a valid export - a reference the
 * manifest can't resolve, an entity with no usable id. The export dialog's
 * validation pass (model/validation.js) reports every such case as a
 * blocking error first, so this only fires if a payload is built without it.
 */
export class ExportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExportError';
  }
}

// A human-readable summary of Document 2 §3, written into every file
// (`conventions`). Informative only - the document is the contract.
export const EXPORT_CONVENTIONS = Object.freeze({
  note: 'summary of the city-layout/1.0 conventions for a reader of this file; the format specification is normative',
  units: { length: 'meters', rotation: 'degrees' },
  axes: {
    origin: 'the canvas corner that is bottom-left in a top-down view',
    x: '+X is right (east) in a top-down view; the canvas spans 0..layout.canvas.width',
    y: '+Y is up (north) in a top-down view, away from the default front-view camera; the canvas spans 0..layout.canvas.depth; already flipped from the editor - never flip it again',
    z: '+Z is up (Blender world up); the file carries no Z coordinates - everything stands on the ground plane; a missing z is 0',
    rotation: 'degrees counter-clockwise about +Z seen from above, normalized to [0, 360); at 0 an entity\'s local X (footprint width) runs along world +X and its local Y (footprint depth) along world +Y',
  },
  anchors: {
    'buildings, props, vehicles, people': 'x, y is the footprint center; the footprint rotates about it',
    scatterRegions: 'x, y is the center of an axis-aligned width x depth rectangle (never rotated)',
    base: 'x, y is the center of an axis-aligned width x depth rectangle (never rotated)',
    'roads, junctions, marking areas': 'absolute points - no anchor',
    'marking lines': 'an offset from the road centerline, not points',
  },
  assetOrientation: {
    front: 'at rotation 0 an asset\'s front (a building\'s door side, a vehicle\'s nose, a person\'s face) faces world -Y',
    origin: 'an asset\'s origin is its footprint center at ground level',
  },
  sizes: {
    footprint: 'final top-down size in meters, footprintScale already applied - never null',
    footprintScale: 'the multiplier the editor applied to the variant\'s footprint; informational - already included in footprint',
    height: 'buildings only: absolute height in meters; NOT multiplied by footprintScale',
  },
  library: {
    assetRoot: 'the asset folder\'s name inside the project folder; the importer is told where the project folder is',
    assets: 'one entry per asset this file uses; id matches variantId on entities and the ids in scatter pools; index is 0..n-1 within this file',
    source: 'kind "file": path is a model file, or a folder of them (a family - one is picked per instance by uid), relative to assetRoot; kind "procedural": built by the named generator from params',
    fallback: 'the primitive to build, sized to the instance\'s footprint, when the source cannot be resolved; height applies to props, vehicles and people (a building uses its own height)',
    materials: 'one entry per material this file uses, referenced by road surface, marking material and base.material; source is a material name inside a .blend file relative to assetRoot; fallback.color is used when that cannot be loaded',
  },
  ids: {
    id: 'unique string within the file',
    uid: 'unique positive integer within the file (the number at the end of id); for stable per-instance randomness',
  },
  roads: {
    points: 'ordered centerline as authored: straight segments, sharp corners; the importer may round the corners',
    closed: 'true for a loop: the last point equals the first and the strip has no end caps; otherwise the ends are round-capped',
    width: 'full road width in meters (edge to edge), one value per path',
    laneWidth: 'meters; informational - lane dividers are already resolved in markingGeometry',
    surface: 'a library.materials id of kind "surface"',
    markings: 'the editor\'s settings, informational - build markings from markingGeometry only',
    markingGeometry: {
      lines: 'run the full length of the road, parallel to its centerline; offset is meters from the centerline, positive to the LEFT of the direction of travel (points[0] toward the last point) seen from above; width is the painted width; dash is null (solid) or a repeating length/gap in meters starting at the first point',
      areas: 'crosswalk stripes and stop lines as closed polygons in absolute coordinates (first point not repeated); only at the last point of an open road',
    },
  },
  junctions: {
    connectionTolerance: CONNECT_EPSILON,
    connectionToleranceNote: 'meters; road points within this distance are the same location (and are written with identical values)',
    attachments: 'one per place a road meets the junction: kind "vertex" = on points[pointIndex]; kind "segment" = partway along segment segmentIndex (points[i] -> points[i+1]); distanceAlongPath = meters from points[0] along the path',
    'width, surface': 'from the widest road at the junction; intended for the junction patch',
  },
  scatterRegions: {
    count: 'exact number of instances to generate (an absolute count, not a density)',
    variantIds: 'the resolved pool of library.assets ids to pick from uniformly at random; never empty',
    instanceFootprint: 'the largest footprint in the pool; the default below when no pool asset has one',
    defaultInstanceFootprint: { ...DEFAULT_SCATTER_FOOTPRINT },
    placement: 'instance centers uniformly random within the region inset by half the instance footprint on each side, so whole instances stay inside; on an axis where the region is smaller than the footprint, centers sit on the region\'s center line',
    validPlacement: 'a candidate center is rejected when it falls inside any building/prop/vehicle/person footprint in this file (rotated rect); a vehicles-category center must lie on a road strip (within width/2 of the centerline, including the round end caps); every other category must not',
    overlapTest: 'point-in-footprint: only the instance center is tested, not its own footprint',
    instanceOverlap: 'scattered instances are not tested against each other, within or across regions',
    attempts: `rejected candidates are redrawn, up to ${MAX_ATTEMPTS_PER_INSTANCE} candidates per requested instance in total; a region may yield fewer than count instances`,
    perInstance: 'a uniformly random variant from variantIds and a uniformly random rotation in [0, 360)',
    randomization: 'regenerated on every import - no seed',
  },
  base: 'null when nothing is placed; otherwise the slab everything stands on, with material a library.materials id of kind "ground"',
  warnings: 'non-blocking issues present at export time; message is the editor\'s own text and may quote EDITOR coordinates (y down) - use the structured x, y, which are in this file\'s coordinates',
  previewImage: 'optional: the filename of a PNG snapshot of the editor view, saved as a separate file next to this one (not embedded); absent when no preview was requested',
});

/**
 * Build the export payload from the current project state. Pure - no DOM,
 * fully unit-testable (tests/io/exporter.test.js) - the actual file
 * download (downloadExport) is the only DOM-touching part of this module.
 *
 * `manifest` is required: the file's `library` is copied out of it. `issues`
 * is the validation result the export was allowed on; its warnings are
 * written into the file (see prepareExport). Throws ExportError for a layout
 * that can't be written as a valid file.
 */
export function buildExportPayload(project, {
  previewImageFilename = null, manifest = null, base = {}, issues = [],
} = {}) {
  if (!manifest) {
    throw new ExportError('export: the asset manifest is not loaded - the file\'s library cannot be written');
  }
  const depth = project.canvas.height;
  // Canvas (y down) -> export (y up).
  const flipY = (y) => depth - y;
  const point = (p) => ({ x: p.x, y: flipY(p.y) });

  const pointAsset = (e, footprint) => ({
    type: e.type,
    id: e.id,
    uid: exportUid(e),
    variantId: e.variantId,
    x: e.x,
    y: flipY(e.y),
    rotation: exportRotation(e.rotation),
    footprintScale: e.scale,
    footprint,
  });

  // Resolved once here from the same function the editor draws junctions
  // with (FR-7), so Blender never has to re-derive road topology.
  const junctions = findJunctions(project.roads);
  const sharedPoints = sharedRoadPoints(junctions);
  const slab = computeBaseSlab(project, manifest, base);

  return {
    formatVersion: EXPORT_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    manifestVersion: manifest.version, // traceability only (FMT-5)
    conventions: EXPORT_CONVENTIONS,
    // Only the sibling PNG's filename - the image itself is its own download
    // (FR-26), so the JSON stays small and the PNG stays a plain image file.
    ...(previewImageFilename ? { previewImage: previewImageFilename } : {}),

    // The catalog: each KIND of thing this file uses, defined once (§6, §12).
    library: {
      assetRoot: DEFAULT_ASSET_ROOT,
      assets: libraryAssets(project, manifest),
      materials: libraryMaterials(project, manifest),
    },

    // The placements: one entry per occurrence on the map, pointing at the
    // catalog by id. Every array is always present, empty if unused (§4).
    layout: {
      canvas: { width: project.canvas.width, depth },
      // The ground everything stands on, derived from what is actually
      // placed rather than from the canvas - null for an empty layout (§11).
      base: slab && {
        ...centeredRect(slab.x, slab.y, slab.width, slab.depth, flipY),
        thickness: slab.thickness,
        material: BASE_MATERIAL_ID,
      },
      buildings: project.buildings.map((b) => ({
        ...pointAsset(b, buildingFootprint(b, manifest)),
        height: b.height, // absolute - footprintScale does not apply (building.js)
      })),
      props: project.props.map((e) => pointAsset(e, pointAssetFootprint(e, manifest))),
      vehicles: project.vehicles.map((e) => pointAsset(e, pointAssetFootprint(e, manifest))),
      people: project.people.map((e) => pointAsset(e, pointAssetFootprint(e, manifest))),
      roads: project.roads.map((r) => exportRoad(r, sharedPoints, point)),
      junctions: junctions.map((j) => ({
        ...point(j),
        roadIds: [...j.roadIds],
        // of the widest road there - what a junction patch has to cover (§9)
        width: j.width,
        surface: j.surface,
        attachments: j.attachments.map((att) => ({ ...att })),
      })),
      // Scatter regions stay regions + count (FR-18) - never pre-expanded
      // here; the importer expands them by the SCT rules (§10).
      scatterRegions: project.scatterRegions.map((r) => exportScatterRegion(r, manifest, flipY)),
    },

    warnings: issues.filter((i) => i.severity === 'warning').map((i) => exportWarning(i, flipY)),
  };
}

// --- library (§6, §12) -------------------------------------------------------
// One entry per asset / material the layout actually uses, copied from the
// manifest (FMT-18) - never the whole manifest.

function libraryAssets(project, manifest) {
  return usedAssets(project, manifest).map(({ id }, index) => {
    const asset = manifest.byId(id);
    if (!asset) throw new ExportError(`export: asset "${id}" is not in the manifest`);
    if (!asset.source || !asset.fallback) {
      throw new ExportError(`export: asset "${id}" has no source/fallback in the manifest`);
    }
    return {
      id,
      index, // position in this (id-sorted) table: stable within the file
      category: asset.category,
      source: asset.source.kind === 'procedural'
        ? { kind: 'procedural', generator: asset.source.generator, params: { ...asset.source.params } }
        : { kind: 'file', path: asset.source.path },
      fallback: {
        shape: asset.fallback.shape,
        color: asset.fallback.color,
        // absent for a building's stand-in, which uses the building's height
        ...(asset.fallback.height == null ? {} : { height: asset.fallback.height }),
      },
    };
  });
}

function libraryMaterials(project, manifest) {
  return usedMaterials(project).map(({ id, kind }) => {
    const material = manifest.material(id);
    if (!material || material.kind !== kind) {
      throw new ExportError(`export: the manifest has no ${kind} material "${id}"`);
    }
    return {
      id,
      kind,
      source: { path: material.source.path, name: material.source.name },
      fallback: { color: material.fallback.color },
    };
  });
}

// --- layout ------------------------------------------------------------------

// §7: the number at the end of the id - unique across every entity type.
function exportUid(entity) {
  const uid = entityUid(entity);
  if (uid === null) throw new ExportError(`export: "${entity.id}" has an id that does not end in a number`);
  return uid;
}

// FMT-9: points at the same location are written with IDENTICAL values, so
// an importer comparing them never depends on the tolerance. A road point
// sitting on a junction (within the editor's connection tolerance) is
// therefore written as the junction's own position. Keyed "roadId#pointIndex".
function sharedRoadPoints(junctions) {
  const shared = new Map();
  for (const j of junctions) {
    for (const att of j.attachments) {
      if (att.kind === 'vertex') shared.set(`${att.roadId}#${att.pointIndex}`, j);
    }
  }
  return shared;
}

function exportRoad(road, sharedPoints, point) {
  const closed = isClosedRoad(road);
  const points = road.points.map((p, i) => point(sharedPoints.get(`${road.id}#${i}`) || p));
  // A loop's last point IS its first (§8) - same values, not merely close.
  if (closed) points[points.length - 1] = { ...points[0] };

  const marking = roadMarkingGeometry(road);
  return {
    type: road.type,
    id: road.id,
    uid: exportUid(road),
    points,
    closed,
    width: road.width,
    laneWidth: road.laneWidth,
    surface: road.surface,
    markings: { ...road.markings }, // the editor's settings - informational
    // What those settings resolve to (§8.1), from the same model code the
    // canvas draws (model/roadMarkings.js).
    markingGeometry: {
      lines: marking.lines.map((line) => ({
        material: line.material,
        offset: exportOffset(line.offset),
        width: line.width,
        dash: line.dash ? { length: line.dash.length, gap: line.dash.gap } : null,
      })),
      areas: marking.areas.map((area) => ({
        material: area.material,
        polygon: area.polygon.map(point),
      })),
    },
  };
}

// The editor measures a line's offset toward the right of travel as seen on
// screen; the export's positive side is the LEFT, seen from above (§8.1).
// The y flip does not change which side that is, so the sign does.
function exportOffset(offset) {
  return offset === 0 ? 0 : -offset; // never -0
}

function exportScatterRegion(region, manifest, flipY) {
  const pool = scatterVariantPool(region, manifest);
  if (pool.length === 0) {
    throw new ExportError(`export: scatter region "${region.id}" has no assets to choose from`);
  }
  return {
    type: region.type,
    id: region.id,
    uid: exportUid(region),
    category: region.category,
    ...centeredRect(region.x, region.y, region.width, region.height, flipY),
    count: region.count,
    // Always the resolved pool and size (§10): "empty = any asset in the
    // category" is expanded here, so the importer never needs the manifest.
    variantIds: pool,
    instanceFootprint: scatterInstanceFootprint(region, manifest),
  };
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

// §13. Only warnings ever reach a file - an error blocks the export.
function exportWarning(issue, flipY) {
  const warning = {
    code: issue.code,
    severity: 'warning',
    message: issue.message,
    entityIds: [...(issue.entityIds || [])],
  };
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
