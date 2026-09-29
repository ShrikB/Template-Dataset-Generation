// Implied base slab — the rectangular "concrete pad" everything in the layout
// sits on. Pure data + geometry, no DOM (NFR-5).
//
// This is DERIVED, never authored and never stored on the Project: it is
// recomputed from the current layout every time a file is written, so it can
// never go stale against what was actually placed. There is no base entity to
// select, move or undo — moving a building that sits at the edge of the
// layout simply moves the slab edge with it on the next save/export.
//
// The bounds are taken from what each entity actually OCCUPIES, not from its
// origin point: a building/prop/vehicle/person contributes its rotated
// footprint's corners, a road its full strip (including the round end caps
// the renderer draws), and a scatter region its whole rect. Scatter instances
// are kept inside their region (see scatterPlacementArea), so the region rect
// already covers them.

import { entityFootprint } from './entityTypes.js';
import { rotatedRectCorners } from '../utils/geometry.js';

// How far the slab extends past the outermost thing standing on it. A little
// visible apron reads as ground rather than as a tight cut-out.
export const DEFAULT_BASE_MARGIN_M = 2;

// Slab depth in meters — a typical concrete pad, not a structural raft.
export const DEFAULT_BASE_THICKNESS_M = 0.2;

/**
 * The axis-aligned extent of everything placed in the layout, in meters, or
 * null when nothing is placed at all.
 */
export function layoutBounds(project, manifest = null) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const e of project.allEntities()) {
    const footprint = entityFootprint(e, manifest);
    if (!footprint) continue;
    for (const c of rotatedRectCorners(e.x, e.y, footprint.width, footprint.depth, e.rotation)) {
      add(c.x, c.y);
    }
  }
  for (const road of project.roads) {
    // A round-capped strip reaches half its width in every direction from
    // each path point, so the box is just the points inflated by that.
    const reach = road.width / 2;
    for (const p of road.points) {
      add(p.x - reach, p.y - reach);
      add(p.x + reach, p.y + reach);
    }
  }
  for (const r of project.scatterRegions) {
    add(r.x, r.y);
    add(r.x + r.width, r.y + r.height);
  }

  if (!Number.isFinite(minX)) return null; // nothing placed
  return {
    minX, minY, maxX, maxY,
  };
}

/**
 * The base slab for the current layout: the layout's extent grown by
 * `margin` on every side, plus a `thickness`. Returns null for an empty
 * layout — there is nothing for a slab to sit under.
 *
 * Coordinates are continuous floats in meters and `x`/`y` are the slab's
 * min corner, matching how a scatter region stores its rect.
 */
export function computeBaseSlab(project, manifest = null, {
  margin = DEFAULT_BASE_MARGIN_M,
  thickness = DEFAULT_BASE_THICKNESS_M,
} = {}) {
  const bounds = layoutBounds(project, manifest);
  if (!bounds) return null;
  return {
    x: bounds.minX - margin,
    y: bounds.minY - margin,
    width: (bounds.maxX - bounds.minX) + margin * 2,
    depth: (bounds.maxY - bounds.minY) + margin * 2,
    thickness,
  };
}
