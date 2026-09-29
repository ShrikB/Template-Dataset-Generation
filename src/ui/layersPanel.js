// Layers panel (FR-19).
//
// One show/hide + lock-from-editing pair per asset category. The model,
// renderer and tools already honoured project.layers - the renderer skips a
// hidden category, selectTool won't hit-test or marquee one that is hidden or
// locked, and placeTool/roadTool/scatterTool refuse to add to a locked one -
// this panel is the control surface for those flags.
//
// DOM only: drives project state through project.setLayerVisible/-Locked and
// reports back via onChange, same rule as ui/palettePanel.js.

import { LAYERS } from '../model/project.js';
import { CATEGORY_LABELS } from '../utils/categories.js';
import { el } from './dom.js';

export class LayersPanel {
  constructor(rootEl, { project } = {}, { onChange } = {}) {
    this.root = rootEl;
    this.project = project;
    this.onChange = onChange || (() => {});
  }

  render() {
    this.root.replaceChildren();
    this.root.appendChild(el('h2', 'panel-title', 'Layers'));

    const head = el('div', 'layer-row layer-head');
    head.appendChild(el('span', 'layer-name', ''));
    head.appendChild(el('span', 'layer-flag', 'Show'));
    head.appendChild(el('span', 'layer-flag', 'Lock'));
    this.root.appendChild(head);

    for (const name of LAYERS) this.root.appendChild(this._row(name));
  }

  _row(name) {
    const row = el('div', 'layer-row');
    row.appendChild(el('span', 'layer-name', CATEGORY_LABELS[name] || name));
    row.appendChild(this._toggle(
      `Show ${name}`,
      this.project.isLayerVisible(name),
      (on) => this.project.setLayerVisible(name, on),
    ));
    row.appendChild(this._toggle(
      `Lock ${name}`,
      this.project.isLayerLocked(name),
      (on) => this.project.setLayerLocked(name, on),
    ));
    return row;
  }

  _toggle(label, checked, apply) {
    const wrap = el('span', 'layer-flag');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {
      apply(input.checked);
      this.onChange();
    });
    wrap.appendChild(input);
    return wrap;
  }
}
