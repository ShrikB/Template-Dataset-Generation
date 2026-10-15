// Validation pass (FR-21, FR-22). Pure data + logic, zero DOM (NFR-5) - run
// by the export dialog (src/ui/exportDialog.js) before every export, and
// nowhere else (there's no standalone "Validate" action - FR-21 only calls
// for a pass "before export").
//
// Every issue is a warning EXCEPT a missing manifest reference, which is an
// ERROR and blocks export - this is FR-22's explicit exception to FR-21's
// list (FR-21 groups "variant ID no longer in the manifest" in with the
// other non-blocking checks, but FR-22 calls out "missing manifest
// reference" by name as an example of a blocking error; the task owner
// confirmed the FR-22 reading is the one to implement).
//
// The same goes for anything else that would make the export file invalid
// under Document 2 (findExportBlockers): the file has to be standalone and
// every reference in it has to resolve, so a layout that can't be written
// that way is stopped here, with a message, rather than exported broken.

import { findDanglingEnds, MARKING_FEATURES } from './entities/road.js';
import { hasUnusedEndMarkings } from './roadMarkings.js';
import { usedAssets, usedMaterials, scatterVariantPool } from './libraryReferences.js';
import { buildingFootprint } from './entities/building.js';
import { rotatedRectCorners, convexPolygonsOverlap, roundTo } from '../utils/geometry.js';
import {
  scatterObstacles, scatterInstanceFootprint, regionTouchesRoad,
} from './entities/scatterRegion.js';
import { entityType, entityUid } from './entityTypes.js';

export const WARNING = 'warning';
export const ERROR = 'error';

// Overlap is tested on the rotated footprint rectangle the editor actually
// draws - see buildingFootprint: the building's own `footprint` size override
// if it has one (FR-13), else its variant's manifest footprint, times the
// building's scale. Edge-to-edge contact (e.g. terraced row houses) is not an
// overlap.

/** Run every validation rule against the current project + manifest. */
export function validateProject(project, manifest) {
  return [
    ...findOverlappingBuildings(project.buildings, manifest),
    ...findDanglingRoadEnds(project.roads),
    ...findOutOfBoundsEntities(project),
    ...findVehicleScatterWithoutRoad(project, manifest),
    ...findClosedRoadEndMarkings(project.roads),
    ...findMissingManifestReferences(project, manifest),
    ...findExportBlockers(project, manifest),
  ];
}

export function hasBlockingErrors(issues) {
  return issues.some((i) => i.severity === ERROR);
}

// --- overlapping building footprints (FR-21) --------------------------------

function findOverlappingBuildings(buildings, manifest) {
  const issues = [];
  const shapes = buildings.map((b) => {
    const { width, depth } = buildingFootprint(b, manifest);
    return rotatedRectCorners(b.x, b.y, width, depth, b.rotation);
  });
  for (let i = 0; i < buildings.length; i++) {
    for (let j = i + 1; j < buildings.length; j++) {
      const a = buildings[i];
      const b = buildings[j];
      if (convexPolygonsOverlap(shapes[i], shapes[j])) {
        issues.push({
          severity: WARNING,
          code: 'overlapping-buildings',
          message: `Buildings "${a.id}" and "${b.id}" overlap.`,
          entityIds: [a.id, b.id],
        });
      }
    }
  }
  return issues;
}

// --- dangling road ends (FR-21) ---------------------------------------------
// Reuses M2's findDanglingEnds rather than re-deriving connectivity.

function findDanglingRoadEnds(roads) {
  return findDanglingEnds(roads).map((end) => ({
    severity: WARNING,
    code: 'dangling-road-end',
    message: `Road "${end.roadId}" has a dangling end at (${roundTo(end.x)}, ${roundTo(end.y)}).`,
    entityIds: [end.roadId],
    // Structured position (editor coordinates) so an export can carry it
    // in its own coordinate convention - the message text stays as shown
    // in the editor.
    x: end.x,
    y: end.y,
  }));
}

// --- vehicle scatter regions with no road (FR-17/18, FR-21 - warning) ------
// Scattered vehicles only land on roads, so a vehicle region that no road
// reaches into places nothing at all - almost certainly not what was meant,
// but not an unexportable file either, so a warning rather than an error.

function findVehicleScatterWithoutRoad(project, manifest) {
  const regions = project.scatterRegions.filter((r) => r.category === 'vehicles' && r.count > 0);
  if (regions.length === 0) return [];
  const obstacles = scatterObstacles(project, manifest);
  return regions
    .filter((r) => !regionTouchesRoad(r, obstacles, scatterInstanceFootprint(r, manifest)))
    .map((r) => ({
      severity: WARNING,
      code: 'scatter-vehicles-no-road',
      message: `Vehicle scatter region "${r.id}" does not overlap any road - no vehicles will be placed in it.`,
      entityIds: [r.id],
    }));
}

// --- crosswalk / stop line on a closed loop (FMT-21 - warning) --------------
// Both sit at a road's last point. A closed loop has no end, so they are
// neither drawn nor exported (roadMarkingBars) - say so, rather than leave a
// ticked box in the inspector that silently does nothing.

function findClosedRoadEndMarkings(roads) {
  return roads.filter(hasUnusedEndMarkings).map((r) => {
    const which = [r.markings.crosswalk && 'crosswalk', r.markings.stopLine && 'stop line']
      .filter(Boolean).join(' and ');
    return {
      severity: WARNING,
      code: 'closed-road-end-markings',
      message: `Road "${r.id}" is a closed loop, so its ${which} is not drawn or exported - `
        + 'these sit at a road\'s end.',
      entityIds: [r.id],
    };
  });
}

// --- assets outside canvas bounds (FR-21) -----------------------------------

// Same bounds rule the canvas resize uses to decide what it would drop - a
// point entity by its position, a road by any path point, a region by any
// corner - so the warning and the resize can never disagree.
function findOutOfBoundsEntities(project) {
  return project.entitiesOutside().map((e) => ({
    severity: WARNING,
    code: 'out-of-bounds',
    message: `${kindOf(e)} "${e.id}" is placed outside the canvas bounds.`,
    entityIds: [e.id],
  }));
}

// --- missing manifest references (FR-21/FR-22 - the one ERROR case) --------

function findMissingManifestReferences(project, manifest) {
  if (!manifest) {
    return [{
      severity: ERROR,
      code: 'no-manifest',
      message: 'No asset manifest is loaded - asset references cannot be verified.',
      entityIds: [],
    }];
  }

  const issues = [];
  // Every entity that references manifest assets: a single variantId, or a
  // scatter region's list of them.
  for (const e of project.allEntities()) {
    const refs = e.variantIds || (e.variantId ? [e.variantId] : []);
    const missing = refs.filter((v) => !manifest.has(v));
    if (missing.length > 0) issues.push(missingRefIssue(e, missing));
  }
  // Road surface/marking styles resolve against the manifest's roadStyles
  // section the same way a variantId resolves against its assets (FR-8,
  // FR-22) - an id the manifest doesn't list blocks export.
  for (const r of project.roads) {
    const missing = [];
    if (!manifest.hasSurface(r.surface)) missing.push(`surface "${r.surface}"`);
    if (!manifest.hasCenterLine(r.markings.centerLine)) {
      missing.push(`center line "${r.markings.centerLine}"`);
    }
    for (const feature of MARKING_FEATURES) {
      if (r.markings[feature] && !manifest.hasMarkingFeature(feature)) {
        missing.push(`marking "${feature}"`);
      }
    }
    if (missing.length > 0) issues.push(missingRoadStyleIssue(r.id, missing));
  }
  return issues;
}

function missingRoadStyleIssue(id, missingStyles) {
  return {
    severity: ERROR,
    code: 'missing-manifest-reference',
    message: `Road "${id}" uses road style(s) not found in the current manifest: `
      + `${missingStyles.join(', ')}.`,
    entityIds: [id],
  };
}

function missingRefIssue(entity, missingVariantIds) {
  return {
    severity: ERROR,
    code: 'missing-manifest-reference',
    message: `${kindOf(entity)} "${entity.id}" references manifest asset(s) `
      + `not found in the current manifest: ${missingVariantIds.join(', ')}.`,
    entityIds: [entity.id],
  };
}

// --- anything else the export file can't be written with (ERRORs) -----------
// Document 2 makes the export standalone: each asset and material a layout
// uses is copied into the file with a `source` and a `fallback` (§6, §12),
// every scatter pool is listed in full (§10), and every entity has a unique
// numeric `uid` (§7). These check each of those can be done. A reference the
// manifest doesn't know at all is findMissingManifestReferences' to report,
// so it is skipped here rather than reported twice.

function findExportBlockers(project, manifest) {
  if (!manifest) return []; // already one blocking 'no-manifest' error
  return [
    ...findAssetsWithoutExportDefinition(project, manifest),
    ...findMaterialsWithoutExportDefinition(project, manifest),
    ...findEmptyScatterPools(project, manifest),
    ...findUnusableEntityIds(project),
  ];
}

function findAssetsWithoutExportDefinition(project, manifest) {
  const issues = [];
  for (const { id, usedBy } of usedAssets(project, manifest)) {
    const asset = manifest.byId(id);
    if (!asset) continue;
    const missing = [!asset.source && 'source', !asset.fallback && 'fallback'].filter(Boolean);
    if (missing.length === 0) continue;
    issues.push({
      severity: ERROR,
      code: 'missing-export-definition',
      message: `Asset "${id}" has no ${missing.join(' or ')} in the manifest, so it cannot be exported `
        + `(used by ${listIds(usedBy)}).`,
      entityIds: usedBy,
    });
  }
  return issues;
}

function findMaterialsWithoutExportDefinition(project, manifest) {
  const issues = [];
  for (const { id, kind, usedBy } of usedMaterials(project)) {
    // An unlisted road surface is already a missing-manifest-reference.
    if (kind === 'surface' && !manifest.hasSurface(id)) continue;
    const material = manifest.material(id);
    if (material && material.kind === kind) continue;
    const users = usedBy.length > 0 ? listIds(usedBy) : 'the base slab';
    issues.push({
      severity: ERROR,
      code: 'missing-export-definition',
      message: material
        ? `Material "${id}" is a ${material.kind} material in the manifest but is used as a ${kind} `
          + `material, so it cannot be exported (used by ${users}).`
        : `The manifest's materials have no ${kind} material "${id}", so it cannot be exported `
          + `(used by ${users}).`,
      entityIds: usedBy,
    });
  }
  return issues;
}

function findEmptyScatterPools(project, manifest) {
  return project.scatterRegions
    .filter((r) => scatterVariantPool(r, manifest).length === 0)
    .map((r) => ({
      severity: ERROR,
      code: 'scatter-empty-pool',
      message: `Scatter region "${r.id}" has no assets to choose from - the manifest has none in the `
        + `"${r.category}" category.`,
      entityIds: [r.id],
    }));
}

function findUnusableEntityIds(project) {
  const issues = [];
  const byUid = new Map();
  for (const e of project.allEntities()) {
    const uid = entityUid(e);
    if (uid === null) {
      issues.push({
        severity: ERROR,
        code: 'invalid-entity-id',
        message: `${kindOf(e)} "${e.id}" has an id that does not end in a number, so it cannot be exported.`,
        entityIds: [e.id],
      });
    } else {
      if (!byUid.has(uid)) byUid.set(uid, []);
      byUid.get(uid).push(e.id);
    }
  }
  for (const [uid, ids] of byUid) {
    if (ids.length < 2) continue;
    issues.push({
      severity: ERROR,
      code: 'invalid-entity-id',
      message: `${listIds(ids)} share the id number ${uid}, so they cannot be exported.`,
      entityIds: ids,
    });
  }
  return issues;
}

// 'a', 'a, b, c', 'a, b, c and 4 more' - keeps a message readable when
// hundreds of entities use the same asset.
function listIds(ids, max = 3) {
  const shown = ids.slice(0, max).join(', ');
  return ids.length > max ? `${shown} and ${ids.length - max} more` : shown;
}

// 'Building', 'Scatter region', ... - how messages name an entity's type.
function kindOf(entity) {
  const { label } = entityType(entity.type);
  return label[0].toUpperCase() + label.slice(1);
}
