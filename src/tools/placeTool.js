// Click-to-place tool (FR-12).
//
// Canvas interaction -> model mutation. Holds the palette's currently selected
// asset and, on a canvas click, instantiates it in the project at the world
// position under the cursor. All state lives in the project model — this tool
// only holds the transient "what am I about to place" selection.
//
// Buildings, props, vehicles and people (FR-11/FR-12); roads come from roadTool.

import { snapPoint } from '../utils/geometry.js';
import { placeableTypeFor } from '../model/entityTypes.js';
import { History } from '../model/history.js';
import { Tool } from './tool.js';

export class PlaceTool extends Tool {
  constructor(project, { onChange, history = new History(project) } = {}) {
    super();
    this.project = project;
    this.history = history; // each placement is one undo step (FR-16)
    this.onChange = onChange || (() => {});
    this.asset = null;
  }

  /** Set the asset to place (from the palette), or null to disarm the tool. */
  setAsset(asset) {
    // Roads have no placeable type - they come from roadTool, not the palette.
    this.asset = asset && placeableTypeFor(asset.category) ? asset : null;
  }

  get active() {
    return this.asset !== null;
  }

  /** A canvas click places the armed asset there (FR-12). */
  onClick({ x, y }) {
    this.placeAt(x, y);
  }

  /**
   * Place the current asset at a world position (meters). Returns the created
   * entity, or null if nothing was placed (no asset armed, or its layer locked).
   */
  placeAt(worldX, worldY) {
    const asset = this.asset;
    if (!asset) return null;
    if (this.project.isLayerLocked(asset.category)) return null;

    let x = worldX;
    let y = worldY;
    const { grid } = this.project;
    if (grid.snap) ({ x, y } = snapPoint(x, y, grid.size));

    const type = placeableTypeFor(asset.category);
    const entity = this.history.record(() => this.project.addEntity(type, { variantId: asset.id, x, y }));

    this.onChange(entity);
    return entity;
  }
}
