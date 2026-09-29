// Inspector panel (FR-13).
//
// Renders editable fields for whatever is currently selected - 0, 1, or
// many entities, of any mix of building/prop/road - and drives edits
// through src/tools/inspectorActions.js (which wraps every edit as one
// undo step, FR-16) rather than touching project.js directly itself. This
// layer only reads the manifest/project and drives DOM (same rule as
// ui/palettePanel.js) - it does not mutate project state on its own.
//
// The selection this renders for can come from either src/tools/selectTool.js
// (FR-14 multi-select) or from roadTool's own point/segment selection while
// road-editing (M2/M3) - the caller (main.js) resolves that to a plain id
// list before calling render(), so this panel only ever deals with ids.

import * as actions from '../tools/inspectorActions.js';
import { CENTER_LINE_NONE, MARKING_FEATURES } from '../model/entities/road.js';
import { buildingFootprint } from '../model/entities/building.js';
import { SCATTER_CATEGORIES, flattenVariantPool } from '../model/entities/scatterRegion.js';
import { categoryOf, entityType } from '../model/entityTypes.js';
import { roundTo } from '../utils/geometry.js';
import { el, titleCase, countLabel } from './dom.js';

export class InspectorPanel {
  // `scatterPreview` (model/scatterPreview.js) owns each scatter region's
  // preview points - the canvas draws them and Flatten places instances at
  // them. `onSelect(ids)` replaces the canvas selection, so a flatten leaves
  // its new instances selected.
  constructor(rootEl, {
    project, history, manifest = null, scatterPreview,
  } = {}, { onChange, onSelect } = {}) {
    this.root = rootEl;
    this.project = project;
    this.history = history;
    this.manifest = manifest;
    this.scatterPreview = scatterPreview;
    this.onChange = onChange || (() => {});
    this.onSelect = onSelect || (() => {});
  }

  /** Render fields for the given entity ids (0, 1, or many - FR-14). */
  render(ids = []) {
    this.root.replaceChildren();
    this.root.appendChild(el('h2', 'panel-title', 'Inspector'));

    const entities = ids.map((id) => this.project.getEntity(id)).filter(Boolean);
    if (entities.length === 0) {
      this.root.appendChild(el('p', 'inspector-placeholder', 'Nothing selected.'));
      return;
    }
    if (entities.length === 1) this._renderSingle(entities[0]);
    else this._renderMulti(entities);
  }

  _renderSingle(entity) {
    this.root.appendChild(el('h3', 'panel-group-title', `${titleCase(entityType(entity.type).label)} — ${entity.id}`));

    if (entity.type === 'road') {
      this._numberField('Width (m)', entity.width, 0.5,
        (v) => actions.setRoadWidth(this.project, this.history, entity.id, v));
      this._selectField('Surface', styleOptions(this._roadStyles().surfaces, entity.surface), entity.surface,
        (v) => actions.setRoadSurface(this.project, this.history, entity.id, v));
      this._markingsFields(entity);
    } else if (entity.type === 'scatterRegion') {
      this._selectField('Category', SCATTER_CATEGORIES, entity.category,
        (v) => actions.setScatterCategory(this.project, this.history, entity.id, v));
      this._numberField('X (m)', entity.x, 0.5,
        (v) => actions.setPosition(this.project, this.history, entity.id, v, entity.y));
      this._numberField('Y (m)', entity.y, 0.5,
        (v) => actions.setPosition(this.project, this.history, entity.id, entity.x, v));
      this._numberField('Width (m)', entity.width, 0.5,
        (v) => actions.setScatterSize(this.project, this.history, entity.id, v, entity.height));
      this._numberField('Height (m)', entity.height, 0.5,
        (v) => actions.setScatterSize(this.project, this.history, entity.id, entity.width, v));
      this._numberField('Count', entity.count, 1,
        (v) => actions.setScatterCount(this.project, this.history, entity.id, Math.round(v)));
      this._scatterVariantsField(entity);
      this._flattenButton(entity);
    } else {
      this._numberField('X (m)', entity.x, 0.01,
        (v) => actions.setPosition(this.project, this.history, entity.id, v, entity.y));
      this._numberField('Y (m)', entity.y, 0.01,
        (v) => actions.setPosition(this.project, this.history, entity.id, entity.x, v));
      this._numberField('Rotation (deg)', entity.rotation, 1,
        (v) => actions.setRotation(this.project, this.history, entity.id, v));
      this._numberField('Scale', entity.scale, 0.1,
        (v) => actions.setScale(this.project, this.history, entity.id, v));
      if (entity.type === 'building') {
        this._footprintFields(entity);
        this._numberField('Height (m)', entity.height, 0.5,
          (v) => actions.setHeight(this.project, this.history, entity.id, v));
      }
      this._variantField(entity);
    }

    this._deleteButton([entity.id], 'Delete');
  }

  // Markings are independent per path (FR-8): a style for the center line,
  // plain on/off for the rest. Each control writes the WHOLE marking set
  // (spread over the current one), so project.setRoadMarkings stays a single
  // setter and each edit stays one undo step.
  //
  // Which styles and features are on offer comes from the manifest's
  // roadStyles section (FR-8) - the same file the Blender add-on reads. A
  // road already using a style the manifest doesn't list keeps it visible
  // (marked "missing") so it can be changed; export blocks on it (FR-22).
  _markingsFields(road) {
    const styles = this._roadStyles();
    const patch = (changes) => actions.setRoadMarkings(
      this.project, this.history, road.id, { ...road.markings, ...changes },
    );
    const centerLines = [{ id: CENTER_LINE_NONE, name: 'None' }, ...styles.centerLines];
    this._selectField('Center line', styleOptions(centerLines, road.markings.centerLine),
      road.markings.centerLine, (v) => patch({ centerLine: v }));

    const offered = new Map(styles.markingFeatures.map((f) => [f.id, f.name]));
    for (const feature of MARKING_FEATURES) {
      if (!offered.has(feature) && !road.markings[feature]) continue;
      const label = offered.get(feature) || `${feature} (missing)`;
      this._checkboxField(label, road.markings[feature], (on) => patch({ [feature]: on }));
      // Only meaningful while dividers are drawn - hidden otherwise rather
      // than sitting there inert, same as the building's "Reset to variant".
      if (feature === 'laneDividers' && road.markings.laneDividers) {
        this._numberField('Lane width (m)', road.laneWidth, 0.5,
          (v) => actions.setRoadLaneWidth(this.project, this.history, road.id, v));
      }
    }
  }

  _roadStyles() {
    return this.manifest
      ? this.manifest.roadStyles
      : { surfaces: [], centerLines: [], markingFeatures: [] };
  }

  _renderMulti(entities) {
    const counts = new Map();
    for (const e of entities) counts.set(e.type, (counts.get(e.type) || 0) + 1);
    const summary = [...counts].map(([t, n]) => `${n} ${countLabel(entityType(t), n)}`).join(', ');
    this.root.appendChild(el('p', 'inspector-summary', `${entities.length} items selected — ${summary}`));

    const ids = entities.map((e) => e.id);
    const rotatableIds = entities.filter((e) => 'rotation' in e).map((e) => e.id);
    if (rotatableIds.length > 0) this._rotateByField(rotatableIds);

    this._deleteButton(ids, `Delete ${ids.length} items`);
  }

  // --- field builders --------------------------------------------------------

  _numberField(labelText, value, step, apply) {
    const label = el('label', 'inspector-field');
    label.appendChild(document.createTextNode(labelText));
    const input = document.createElement('input');
    input.type = 'number';
    input.step = String(step);
    input.value = roundTo(value);
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) {
        input.value = roundTo(value);
        return;
      }
      // Only the model edit is guarded - a failure refreshing the rest of
      // the app afterwards must not masquerade as "the edit was rejected"
      // and silently roll the field's display back to a value the model no
      // longer holds.
      try {
        apply(v);
      } catch {
        input.value = roundTo(value); // revert display on a rejected edit (e.g. scale <= 0)
        return;
      }
      this.onChange();
    });
    label.appendChild(input);
    this.root.appendChild(label);
  }

  _selectField(labelText, options, value, apply) {
    const label = el('label', 'inspector-field');
    label.appendChild(document.createTextNode(labelText));
    const select = document.createElement('select');
    // Options are plain strings, or { value, label } when the shown text
    // differs from the stored id (manifest road styles).
    for (const o of options) {
      const option = document.createElement('option');
      option.value = typeof o === 'string' ? o : o.value;
      option.textContent = typeof o === 'string' ? o : o.label;
      option.selected = option.value === value;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      apply(select.value);
      this.onChange();
    });
    label.appendChild(select);
    this.root.appendChild(label);
  }

  // Footprint size in meters (FR-13). These show the building AS DRAWN -
  // its variant's manifest size or its own override, times `scale` - so the
  // numbers always match the canvas and the meter readout (FR-1, FR-34).
  // Typing one therefore divides `scale` back out before storing, and the
  // two fields are independent: a 10x20 variant can be made a 14x8.
  // Buildings are the only entity with a real 2D footprint here - props,
  // vehicles and people are points, and a scatter region's size is its own
  // Width/Height fields above.
  _footprintFields(entity) {
    const drawn = () => buildingFootprint(entity, this.manifest);
    const store = (width, depth) => actions.setBuildingFootprint(
      this.project, this.history, entity.id, width / entity.scale, depth / entity.scale,
    );

    this._numberField('Width (m)', drawn().width, 0.5, (v) => store(v, drawn().depth));
    this._numberField('Depth (m)', drawn().depth, 0.5, (v) => store(drawn().width, v));
    if (entity.footprint) {
      this._actionField('Size', 'Reset to variant', () => {
        actions.clearBuildingFootprint(this.project, this.history, entity.id);
        this.onChange();
      });
    }
  }

  _checkboxField(labelText, checked, apply) {
    const label = el('label', 'inspector-field');
    label.appendChild(document.createTextNode(labelText));
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => {
      apply(input.checked);
      this.onChange();
    });
    label.appendChild(input);
    this.root.appendChild(label);
  }

  _variantField(entity) {
    if (!this.manifest) return;
    const assets = this.manifest.byCategory(categoryOf(entity));
    if (assets.length === 0) return;

    const label = el('label', 'inspector-field');
    label.appendChild(document.createTextNode('Variant'));
    const select = document.createElement('select');
    select.innerHTML = assets
      .map((a) => `<option value="${a.id}"${a.id === entity.variantId ? ' selected' : ''}>${a.name}</option>`)
      .join('');
    select.addEventListener('change', () => {
      actions.setVariant(this.project, this.history, entity.id, select.value);
      this.onChange();
    });
    label.appendChild(select);
    this.root.appendChild(label);
  }

  // A scatter region can draw from several variants at once (FR-18), unlike
  // a building/prop's single variantId - a native multi-select is the
  // simplest control that expresses "any of these", reusing the same
  // <select> pattern as every other dropdown in this panel.
  _scatterVariantsField(region) {
    const label = el('label', 'inspector-field inspector-row');
    label.appendChild(document.createTextNode('Variants'));
    if (!this.manifest) return;
    const assets = this.manifest.byCategory(region.category);
    if (assets.length === 0) {
      label.appendChild(document.createTextNode('none in manifest'));
      this.root.appendChild(label);
      return;
    }
    const select = document.createElement('select');
    select.multiple = true;
    select.size = Math.min(4, assets.length);
    select.innerHTML = assets
      .map((a) => `<option value="${a.id}"${region.variantIds.includes(a.id) ? ' selected' : ''}>${a.name}</option>`)
      .join('');
    select.addEventListener('change', () => {
      const chosen = [...select.selectedOptions].map((o) => o.value);
      actions.setScatterVariants(this.project, this.history, region.id, chosen);
      this.onChange();
    });
    label.appendChild(select);
    this.root.appendChild(label);
  }

  _actionField(labelText, buttonText, onClick) {
    const row = el('div', 'inspector-field inspector-row');
    row.appendChild(document.createTextNode(labelText));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = buttonText;
    btn.addEventListener('click', onClick);
    row.appendChild(btn);
    this.root.appendChild(row);
  }

  _rotateByField(ids) {
    const row = el('div', 'inspector-field inspector-row');
    row.appendChild(document.createTextNode('Rotate by (deg)'));
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '1';
    input.value = '15';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Apply';
    btn.addEventListener('click', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v === 0) return;
      actions.rotateEntitiesBy(this.project, this.history, ids, v);
      this.onChange();
    });
    row.appendChild(input);
    row.appendChild(btn);
    this.root.appendChild(row);
  }

  // Flatten: replace the region with individually placed vehicles/people
  // at the positions the preview shows. Disabled (with the reason as a
  // tooltip) when there is nothing to place, nothing to place it as, or the
  // region's layer is locked.
  _flattenButton(region) {
    const points = this.scatterPreview.pointsFor(region, this.project, this.manifest);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inspector-action inspector-flatten';
    btn.textContent = `Flatten into ${points.length} ${region.category}`;
    if (this.project.isLayerLocked(region.category)) {
      btn.disabled = true;
      btn.title = `The ${region.category} layer is locked`;
    } else if (points.length === 0) {
      btn.disabled = true;
      btn.title = 'The region currently places no instances';
    } else if (flattenVariantPool(region, this.manifest).length === 0) {
      btn.disabled = true;
      btn.title = `No ${region.category} variants to place`;
    } else {
      btn.title = 'Replace this region with individually selectable instances';
    }
    btn.addEventListener('click', () => {
      const created = actions.flattenScatterRegion(
        this.project, this.history, region.id, this.scatterPreview, this.manifest,
      );
      this.onChange();
      this.onSelect(created.map((e) => e.id));
    });
    this.root.appendChild(btn);
  }

  _deleteButton(ids, text) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inspector-action inspector-delete';
    btn.textContent = text;
    btn.addEventListener('click', () => {
      actions.deleteEntities(this.project, this.history, ids);
      this.onChange();
    });
    this.root.appendChild(btn);
  }
}

// Manifest style entries as select options, plus the current value if the
// manifest doesn't list it - so the field never silently shows a different
// style than the road actually has.
function styleOptions(styles, current) {
  const options = styles.map((s) => ({ value: s.id, label: s.name }));
  if (!styles.some((s) => s.id === current)) {
    options.push({ value: current, label: `${current} (missing)` });
  }
  return options;
}
