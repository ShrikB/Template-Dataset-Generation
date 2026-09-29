// Bridges inspector-panel field edits into model mutations (FR-13), each
// wrapped as one undo step (FR-16). The panel (src/ui/inspectorPanel.js)
// calls these instead of touching project.js directly, so every edit made
// through the inspector is undoable the same way canvas edits are.
//
// These are for ATOMIC edits only (a dropdown change, a number field
// commit, a button click) - a continuous canvas gesture (drag-to-move,
// the rotation drag-handle) uses history.begin()/commit() directly from
// the tool driving it (src/tools/selectTool.js), since collapsing many
// per-tick mutations into one step needs the transaction API, not record().

export function setPosition(project, history, id, x, y) {
  return history.record(() => project.setEntityPosition(id, x, y));
}

export function setRotation(project, history, id, rotation) {
  return history.record(() => project.setEntityRotation(id, rotation));
}

export function setScale(project, history, id, scale) {
  return history.record(() => project.setEntityScale(id, scale));
}

export function setHeight(project, history, id, height) {
  return history.record(() => project.setBuildingHeight(id, height));
}

export function setBuildingFootprint(project, history, id, width, depth) {
  return history.record(() => project.setBuildingFootprint(id, width, depth));
}

export function clearBuildingFootprint(project, history, id) {
  return history.record(() => project.clearBuildingFootprint(id));
}

export function setVariant(project, history, id, variantId) {
  return history.record(() => project.setEntityVariant(id, variantId));
}

export function setRoadWidth(project, history, id, width) {
  return history.record(() => project.setRoadWidth(id, width));
}

export function setRoadSurface(project, history, id, surface) {
  return history.record(() => project.setRoadSurface(id, surface));
}

export function setRoadLaneWidth(project, history, id, laneWidth) {
  return history.record(() => project.setRoadLaneWidth(id, laneWidth));
}

export function setRoadMarkings(project, history, id, markings) {
  return history.record(() => project.setRoadMarkings(id, markings));
}

export function setScatterCategory(project, history, id, category) {
  return history.record(() => project.setScatterCategory(id, category));
}

export function setScatterCount(project, history, id, count) {
  return history.record(() => project.setScatterCount(id, count));
}

export function setScatterVariants(project, history, id, variantIds) {
  return history.record(() => project.setScatterVariants(id, variantIds));
}

export function setScatterSize(project, history, id, width, height) {
  return history.record(() => project.setScatterSize(id, width, height));
}

/**
 * Flatten a scatter region into individual vehicles/people at the points
 * `preview` (model/scatterPreview.js - the same owner the canvas draws from)
 * gives for it right now, so the result is exactly what the preview shows.
 * One undo step; returns the created entities.
 */
export function flattenScatterRegion(project, history, id, preview, manifest = null) {
  return history.record(() => {
    const region = project.getEntity(id);
    const points = region && region.type === 'scatterRegion'
      ? preview.pointsFor(region, project, manifest)
      : [];
    return project.flattenScatterRegion(id, points, manifest);
  });
}

/** Bulk delete (FR-14). Atomic: either every listed entity is removed, or none are. */
export function deleteEntities(project, history, ids) {
  return history.record(() => ids.map((id) => project.removeEntity(id)));
}

/**
 * Bulk rotate by a relative amount (FR-14). Entities with no `rotation`
 * field (roads) are silently skipped - rotating a whole road path around a
 * shared pivot isn't a requested feature here, and skipping keeps a mixed
 * selection's rotate action well-defined instead of throwing.
 */
export function rotateEntitiesBy(project, history, ids, deltaDeg) {
  return history.record(() => ids
    .map((id) => project.getEntity(id))
    .filter((e) => e && 'rotation' in e)
    .map((e) => project.rotateEntityBy(e.id, deltaDeg)));
}
