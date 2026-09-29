// Scatter preview points (FR-17/FR-18) - where the editor shows each scatter
// region's instances, and exactly where Flatten places them.
//
// Pure data + logic, no DOM/canvas (NFR-5). It lives in model/ rather than
// render/ or tools/ because what it returns becomes model data (Flatten
// writes these points into the project), so it must not depend on whether
// or how anything was drawn - the renderer only draws what this returns,
// and Flatten reads the same thing. It is not tool state either: no gesture
// owns it, and every tool and panel sees the same preview.
//
// It is NOT project state: never saved, never part of an undo snapshot.
// A region stores only area + count + variants (FR-18, always randomized on
// export). What this holds is a per-session random candidate stream per
// region, so the preview stays put while the user works - redraws happen on
// every pan/zoom/edit, and a reshuffling preview reads as the region itself
// changing. The points are always placeScatterPoints (the one placement
// implementation, mirrored by the importer) run over that stream:
//  - moving/resizing a region carries its pattern along (the stream is in
//    unit space);
//  - raising the count adds points without moving existing ones, and
//    lowering it then raising it back restores the originals (the stream
//    only grows);
//  - a building or road moved over a region hides/reveals individual
//    points without reshuffling the rest.
//
// Streams are keyed by region id. Undo/redo restores regions with their ids,
// so the preview comes back exactly as it was. clear() drops every stream
// (main.js calls it after loading a file, so a loaded region never inherits
// a stale pattern from an unrelated region that had the same id).

import {
  placeScatterPoints, scatterInstanceFootprint, scatterObstacles, obstaclesWithin,
} from './entities/scatterRegion.js';

export class ScatterPreview {
  /** `rng` is only overridable for deterministic tests, not a seed lock (§12). */
  constructor({ rng = Math.random } = {}) {
    this._rng = rng;
    // region id -> { unit: [{u, v}], key, points }
    this._entries = new Map();
  }

  /**
   * `{ footprint, points }` for one region: the instance size the preview
   * draws and the world points (copies) - what Flatten places. Works for any
   * region, whether or not its layer is visible or it has ever been drawn.
   */
  regionPreview(region, project, manifest = null) {
    const { footprint, points } = this._compute(region, scatterObstacles(project, manifest), manifest);
    return { footprint, points: points.map((p) => ({ x: p.x, y: p.y })) };
  }

  /** Just the points of regionPreview. */
  pointsFor(region, project, manifest = null) {
    return this.regionPreview(region, project, manifest).points;
  }

  /**
   * `{ footprint, points }` for every region in `regions` (defaults to all),
   * keyed by region id - one obstacle snapshot shared across them, which is
   * what a full redraw wants. Points are read-only here (the memo's own
   * arrays); use regionPreview for copies.
   */
  previewAll(project, manifest = null, regions = project.scatterRegions) {
    const out = new Map();
    if (regions.length === 0) return out;
    const obstacles = scatterObstacles(project, manifest);
    for (const region of regions) out.set(region.id, this._compute(region, obstacles, manifest));
    return out;
  }

  /** Forget every region's stream (e.g. after loading a different project). */
  clear() {
    this._entries.clear();
  }

  _compute(region, allObstacles, manifest) {
    const footprint = scatterInstanceFootprint(region, manifest);
    let entry = this._entries.get(region.id);
    if (!entry) {
      entry = { unit: [], key: null, points: [] };
      this._entries.set(region.id, entry);
    }
    // Memoized against everything the placement reads, so a plain pan/zoom
    // redraw costs nothing extra - and only against the obstacles near this
    // region, so dragging a building elsewhere does not redo it (that was
    // the dominant cost of a drag on a large layout).
    const obstacles = obstaclesWithin(allObstacles, region);
    const key = JSON.stringify([
      region.x, region.y, region.width, region.height, region.count, region.category,
      footprint.width, footprint.depth, obstacles,
    ]);
    if (entry.key !== key) {
      const { unit } = entry;
      const candidate = (i) => {
        while (unit.length <= i) unit.push({ u: this._rng(), v: this._rng() });
        return unit[i];
      };
      entry.points = placeScatterPoints(region, { footprint, obstacles, candidate });
      entry.key = key;
    }
    return { footprint, points: entry.points };
  }
}
