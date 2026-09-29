// Validation panel (FR-22): a dismissible list of the warnings/errors from
// the last validation pass (src/model/validation.js). This layer only reads
// issue data and drives DOM - it does not run validation itself and does
// not mutate project state (same rule as ui/palettePanel.js). Owned by
// src/ui/exportDialog.js, which is the only thing that runs validation
// (FR-21: "Before export, the tool runs a validation pass").

import { el } from './dom.js';

const SEVERITY_LABELS = { error: 'Error', warning: 'Warning' };

export class ValidationPanel {
  constructor(rootEl) {
    this.root = rootEl;
  }

  /** Render the given issues (from validateProject), or hide if there are none. */
  render(issues = []) {
    this.root.replaceChildren();

    if (issues.length === 0) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;

    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');

    const header = el('div', 'validation-header');
    const summary = [];
    if (errors.length > 0) summary.push(`${errors.length} error${errors.length === 1 ? '' : 's'}`);
    if (warnings.length > 0) summary.push(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);
    header.appendChild(el('strong', 'validation-summary', summary.join(', ')));

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'validation-dismiss';
    dismissBtn.setAttribute('aria-label', 'Dismiss');
    dismissBtn.textContent = '×';
    dismissBtn.addEventListener('click', () => this.hide());
    header.appendChild(dismissBtn);
    this.root.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'validation-list';
    for (const issue of [...errors, ...warnings]) {
      const item = el('li', `validation-item validation-${issue.severity}`);
      item.appendChild(el('span', 'validation-badge', SEVERITY_LABELS[issue.severity] || issue.severity));
      item.appendChild(document.createTextNode(issue.message));
      list.appendChild(item);
    }
    this.root.appendChild(list);
  }

  /** Hide the panel without clearing its content (dismiss). */
  hide() {
    this.root.hidden = true;
  }
}
