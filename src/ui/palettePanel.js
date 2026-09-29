// Palette panel (FR-11).
//
// Lists asset variants from the manifest, grouped by category. Selecting one
// hands the asset to a placement tool via the `onSelect` callback. This layer
// only reads the manifest and drives DOM — it does not mutate project state
// directly (the tool it calls does).
//
// Every category that supports click-to-place is shown (FR-11). Roads are the
// one category with no palette entry - they are drawn with the Road tool
// rather than instantiated from a variant.

import { CATEGORY_LABELS } from '../utils/categories.js';
import { PLACEABLE_CATEGORIES } from '../model/entityTypes.js';
import { el } from './dom.js';

export class PalettePanel {
  constructor(rootEl, manifest, { onSelect } = {}) {
    this.root = rootEl;
    this.manifest = manifest;
    this.onSelect = onSelect || (() => {});
    this.selectedId = null;
    this.disabled = false;
  }

  /** Grey out / re-enable every palette item (e.g. while a road is being drawn). */
  setDisabled(disabled) {
    this.disabled = disabled;
    for (const node of this.root.querySelectorAll('.palette-item')) node.disabled = disabled;
  }

  render() {
    this.root.replaceChildren();

    const heading = el('h2', 'panel-title', 'Palette');
    this.root.appendChild(heading);

    let rendered = 0;
    for (const category of PLACEABLE_CATEGORIES) {
      const assets = this.manifest.byCategory(category);
      if (assets.length === 0) continue;
      rendered += assets.length;

      const group = el('div', 'palette-group');
      group.appendChild(el('h3', 'palette-group-title', CATEGORY_LABELS[category] || category));
      for (const asset of assets) group.appendChild(this._item(asset));
      this.root.appendChild(group);
    }

    if (rendered === 0) {
      this.root.appendChild(el('p', 'palette-empty', 'No placeable assets in the manifest.'));
    }
  }

  _item(asset) {
    const btn = el('button', 'palette-item');
    btn.type = 'button';
    btn.dataset.assetId = asset.id;
    btn.disabled = this.disabled;
    btn.setAttribute('aria-pressed', String(asset.id === this.selectedId));

    if (asset.thumbnail) {
      const img = document.createElement('img');
      img.className = 'palette-thumb';
      img.src = asset.thumbnail;
      img.alt = '';
      btn.appendChild(img);
    }
    btn.appendChild(el('span', 'palette-item-name', asset.name));

    btn.addEventListener('click', () => this.select(asset));
    return btn;
  }

  /** Select an asset (or pass null to clear). Updates highlight + notifies. */
  select(asset) {
    this.selectedId = asset ? asset.id : null;
    for (const node of this.root.querySelectorAll('.palette-item')) {
      node.setAttribute('aria-pressed', String(node.dataset.assetId === this.selectedId));
    }
    this.onSelect(asset || null);
  }
}
