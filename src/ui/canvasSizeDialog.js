// Canvas / site size dialog (FR-2).
//
// Set the site's width x depth in meters. Expanding is always safe. Shrinking
// below the current extent lists exactly what would be dropped and waits for
// a second confirmation before committing - no partial-preservation logic
// (§12: deferred to v2, so an entity that no longer fits is dropped whole).
//
// DOM only: it reads project.canvas and asks project.entitiesOutside() what a
// given size would cost, but the commit itself goes through the onApply
// callback so main.js can wrap it in one undo step (FR-16).

import { el } from './dom.js';
import { Modal } from './modal.js';

const MAX_LISTED = 12; // beyond this the list is summarized rather than enumerated

export class CanvasSizeDialog extends Modal {
  constructor({
    overlayEl, widthInput, heightInput, warningEl, cancelBtn, confirmBtn,
  }, { project } = {}, { onApply } = {}) {
    super(overlayEl);
    this.widthInput = widthInput;
    this.heightInput = heightInput;
    this.warningEl = warningEl;
    this.confirmBtn = confirmBtn;
    this.project = project;
    this.onApply = onApply || (() => {});

    cancelBtn.addEventListener('click', () => this.close());
    confirmBtn.addEventListener('click', () => this._apply());
    for (const input of [widthInput, heightInput]) {
      input.addEventListener('input', () => this._preview());
    }
  }

  open() {
    this.widthInput.value = String(this.project.canvas.width);
    this.heightInput.value = String(this.project.canvas.height);
    super.open();
    this._preview();
    this.widthInput.focus();
  }

  /** The entered size, or null if either field isn't a positive number. */
  _size() {
    const width = Number(this.widthInput.value);
    const height = Number(this.heightInput.value);
    if (!(Number.isFinite(width) && width > 0)) return null;
    if (!(Number.isFinite(height) && height > 0)) return null;
    return { width, height };
  }

  // Live preview of the cost of the entered size, so the confirmation isn't a
  // surprise at the moment of clicking Apply.
  _preview() {
    const size = this._size();
    if (!size) {
      this.confirmBtn.disabled = true;
      this._warn('Width and depth must be positive numbers (meters).');
      return;
    }
    this.confirmBtn.disabled = false;

    const dropped = this.project.entitiesOutside(size.width, size.height);
    if (dropped.length === 0) {
      this.warningEl.hidden = true;
      this.warningEl.replaceChildren();
      this.confirmBtn.textContent = 'Apply';
      return;
    }
    this.confirmBtn.textContent = `Apply and drop ${dropped.length}`;
    this._warn(
      `Shrinking to ${size.width}m × ${size.height}m drops `
      + `${dropped.length} item${dropped.length === 1 ? '' : 's'} that fall outside it:`,
      dropped,
    );
  }

  _warn(message, dropped = []) {
    this.warningEl.hidden = false;
    this.warningEl.replaceChildren();
    this.warningEl.appendChild(el('p', 'canvas-warning-text', message));
    if (dropped.length === 0) return;

    const list = el('ul', 'canvas-warning-list');
    for (const e of dropped.slice(0, MAX_LISTED)) {
      list.appendChild(el('li', null, `${e.type} — ${e.id}`));
    }
    if (dropped.length > MAX_LISTED) {
      list.appendChild(el('li', 'canvas-warning-more', `…and ${dropped.length - MAX_LISTED} more`));
    }
    this.warningEl.appendChild(list);
  }

  _apply() {
    const size = this._size();
    if (!size) return;
    this.onApply(size.width, size.height);
    this.close();
  }
}
