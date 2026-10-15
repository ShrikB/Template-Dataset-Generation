// What a layout references in an export's `library` (Document 2 §6, §12):
// the assets and materials it actually uses. An export carries one library
// entry per USED asset or material - never the whole manifest - so both the
// exporter (to write those entries) and validation (to check each one can be
// written) need the same answer to "what does this layout use?". This is that
// answer. Pure data + logic, no DOM (NFR-5).

import { flattenVariantPool } from './entities/scatterRegion.js';
import { roadMarkingGeometry } from './roadMarkings.js';
import { BASE_MATERIAL_ID } from './baseSlab.js';

/**
 * The pool of asset ids a scatter region's instances are drawn from, as an
 * export states it (§10): the region's own `variantIds`, or - when that is
 * empty, "any in the category" - every manifest asset in its category. The
 * same pool Flatten uses, so a flattened region and an imported one pick from
 * the same assets.
 */
export function scatterVariantPool(region, manifest = null) {
  return flattenVariantPool(region, manifest);
}

/**
 * Every asset id the layout uses - by a placed building/prop/vehicle/person,
 * or in a scatter region's pool - with the entities using it:
 *
 *   [{ id, usedBy: [entityId, ...] }]   sorted by id
 *
 * Sorted so the same layout always lists its assets in the same order (the
 * export numbers them by position, `index`). Ids are reported whether or not
 * the manifest knows them.
 */
export function usedAssets(project, manifest = null) {
  const users = new Map();
  const use = (id, entityId) => {
    if (!users.has(id)) users.set(id, []);
    users.get(id).push(entityId);
  };
  for (const e of [...project.buildings, ...project.props, ...project.vehicles, ...project.people]) {
    use(e.variantId, e.id);
  }
  for (const region of project.scatterRegions) {
    for (const id of new Set(scatterVariantPool(region, manifest))) use(id, region.id);
  }
  return sortedById(users);
}

/**
 * Every material id the layout uses, with the kind it has to be (§12) and
 * the entities using it:
 *
 *   [{ id, kind, usedBy: [entityId, ...] }]   sorted by id
 *
 *  - each road's surface                          kind 'surface'
 *  - the paint of each marking a road carries     kind 'marking'
 *  - the base slab's ground, when there is a slab kind 'ground' (usedBy [])
 *
 * A junction's surface is one of its roads' surfaces, so it adds nothing.
 * One id asked for as two different kinds (a road surface that is also named
 * like the ground material, say) is listed once per kind; a material has a
 * single kind, so validation reports whichever use doesn't match it.
 */
export function usedMaterials(project) {
  const uses = new Map(); // id -> kind -> [entityId, ...]
  const use = (id, kind, entityId = null) => {
    if (!uses.has(id)) uses.set(id, new Map());
    const byKind = uses.get(id);
    if (!byKind.has(kind)) byKind.set(kind, []);
    if (entityId !== null && !byKind.get(kind).includes(entityId)) byKind.get(kind).push(entityId);
  };
  for (const road of project.roads) {
    use(road.surface, 'surface', road.id);
    const { lines, areas } = roadMarkingGeometry(road);
    for (const marking of [...lines, ...areas]) use(marking.material, 'marking', road.id);
  }
  // The slab exists exactly when something is placed (computeBaseSlab).
  if (project.allEntities().length > 0) use(BASE_MATERIAL_ID, 'ground');
  return sortedById(uses).flatMap(({ id, usedBy: byKind }) => (
    [...byKind].map(([kind, usedBy]) => ({ id, kind, usedBy }))
  ));
}

function sortedById(users) {
  return [...users.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((id) => ({ id, usedBy: users.get(id) }));
}
