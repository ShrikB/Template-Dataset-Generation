// Export dialog (FR-25, FR-26, FR-27).
//
// Options exposed: filename (the "file destination/download" FR-26 calls
// for - a browser page can't pick an actual folder without the File System
// Access API, so "destination" here means what the download is named; the
// browser's own download UI/settings own where it lands) and whether to
// include a preview image (a PNG snapshot of the current canvas view,
// downloaded as its own file next to the JSON, which names it - a
// simplification worth knowing: it captures whatever is currently
// panned/zoomed into, not a full-layout render).
//
// Runs validation (src/model/validation.js) every time it opens and every
// time Export is clicked, and shows the results through src/ui/validationPanel.js
// - a blocking error (FR-22) stops the export and leaves the dialog open;
// warnings are shown but don't block. Uses src/io/exporter.js's
// prepareExport/downloadExport for the actual "build payload, decide
// blocked-or-not, trigger download" work - this file is just the DOM/event
// wiring around that.

import { validateProject } from '../model/validation.js';
import { prepareExport, downloadExport, previewImageFilenameFor } from '../io/exporter.js';
import { ValidationPanel } from './validationPanel.js';
import { Modal } from './modal.js';
import { countLabel } from './dom.js';
import { ENTITY_TYPES } from '../model/entityTypes.js';
import { roundTo } from '../utils/geometry.js';

export class ExportDialog extends Modal {
  constructor(
    {
      overlayEl, filenameInput, previewCheckbox, cancelBtn, confirmBtn, summaryEl, validationEl,
    },
    { project, manifest = null, canvasEl = null } = {},
  ) {
    super(overlayEl);
    this.filenameInput = filenameInput;
    this.previewCheckbox = previewCheckbox;
    this.summaryEl = summaryEl;
    this.project = project;
    this.manifest = manifest;
    this.canvasEl = canvasEl;
    this.validationPanel = new ValidationPanel(validationEl);

    cancelBtn.addEventListener('click', () => this.close());
    confirmBtn.addEventListener('click', () => {
      // _doExport is async - a rejected promise here would otherwise be
      // unhandled and the dialog would just sit there.
      this._doExport().catch((err) => {
        this.summaryEl.hidden = false;
        this.summaryEl.textContent = `Export failed - ${err.message || err}`;
      });
    });
  }

  open() {
    super.open();
    this.summaryEl.hidden = true;
    this.summaryEl.textContent = '';
    this._revalidate();
  }

  _revalidate() {
    const issues = validateProject(this.project, this.manifest);
    this.validationPanel.render(issues);
    return issues;
  }

  async _doExport() {
    const issues = this._revalidate(); // re-check - the project may have changed since open()
    const filename = this.filenameInput.value;
    const previewImage = this.previewCheckbox.checked && this.canvasEl
      ? await canvasPng(this.canvasEl)
      : null;

    const result = prepareExport(this.project, issues, {
      // The payload only names the PNG; downloadExport saves it alongside.
      previewImageFilename: previewImage ? previewImageFilenameFor(filename) : null,
      manifest: this.manifest, // sizes each entity's footprint for the base slab
    });
    if (result.blocked) {
      // The validation panel above already shows the blocking error(s) -
      // nothing else to do, export simply doesn't happen (FR-22).
      return;
    }

    // Surface a failure rather than leaving the dialog looking like it worked.
    try {
      downloadExport(result.payload, filename, { previewImage });
    } catch (err) {
      this.summaryEl.hidden = false;
      this.summaryEl.textContent = `Export failed - ${err.message || err}`;
      return;
    }
    this._showSummary(result.summary);
  }

  _showSummary(summary) {
    this.summaryEl.hidden = false;
    // One entry per counted category (FR-27) - driven off summary.counts so a
    // new category shows up here automatically instead of being silently
    // dropped from the confirmation.
    const parts = ENTITY_TYPES.map((t) => `${summary.counts[t.list]} ${countLabel(t, summary.counts[t.list])}`);
    parts.push(`canvas ${summary.canvas.width}m × ${summary.canvas.height}m`);
    if (summary.base) {
      parts.push(`base slab ${roundTo(summary.base.width, 1)}m × ${roundTo(summary.base.depth, 1)}m`);
    }
    if (summary.warnings.length > 0) {
      parts.push(`${summary.warnings.length} warning${summary.warnings.length === 1 ? '' : 's'} carried over`);
    }
    this.summaryEl.textContent = `Export complete - ${parts.join(', ')}.`;
  }
}

/** The canvas as a PNG Blob (null if the browser can't encode one). */
function canvasPng(canvasEl) {
  return new Promise((resolve) => canvasEl.toBlob(resolve, 'image/png'));
}
