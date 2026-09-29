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

import { findDanglingEnds, MARKING_FEATURES } from './entities/road.js';
import { buildingFootprint } from './entities/building.js';
import { rotatedRectCorners, convexPolygonsOverlap, roundTo } from '../utils/geometry.js';
import {
  scatterObstacles, scatterInstanceFootprint, regionTouchesRoad,
} from './entities/scatterRegion.js';
import { entityType } from './entityTypes.js';

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
    ...findMissingManifestReferences(project, manifest),
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

// 'Building', 'Scatter region', ... - how messages name an entity's type.
function kindOf(entity) {
  const { label } = entityType(entity.type);
  return label[0].toUpperCase() + label.slice(1);
}
