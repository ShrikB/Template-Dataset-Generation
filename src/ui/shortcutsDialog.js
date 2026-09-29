// Keyboard shortcut reference (FR-32).
//
// SHORTCUTS is the single source of truth for what this dialog lists - the
// handlers themselves live in main.js's keydown handler (global keys) and in
// each tool's onKeyDown (tools/*.js), so anything added there needs a line
// here to stay discoverable ("with a visible shortcut
// reference" is half of FR-32; the keys alone are not enough).
//
// DOM only: reads nothing from the project and mutates nothing (same rule as
// ui/palettePanel.js).

import { el } from './dom.js';
import { Modal } from './modal.js';

export const SHORTCUTS = [
  {
    group: 'Tools',
    items: [
      ['1', 'Place tool'],
      ['2', 'Road tool'],
      ['3', 'Select tool'],
      ['4', 'Scatter tool'],
    ],
  },
  {
    group: 'Edit',
    items: [
      ['Ctrl/⌘ + Z', 'Undo'],
      ['Ctrl/⌘ + Shift + Z  ·  Ctrl/⌘ + Y', 'Redo'],
      ['Ctrl/⌘ + C', 'Copy selection'],
      ['Ctrl/⌘ + V', 'Paste'],
      ['Ctrl/⌘ + D', 'Duplicate selection'],
      ['Del  ·  Backspace', 'Delete selection'],
      ['[  ·  ]', 'Rotate selection by 15°'],
    ],
  },
  {
    group: 'View',
    items: [
      ['F', 'Fit to view'],
      ['Scroll', 'Zoom about the cursor'],
      ['Space + drag  ·  Middle-drag', 'Pan'],
    ],
  },
  {
    group: 'Roads',
    items: [
      ['Double-click  ·  Enter', 'Finish the path being drawn'],
      ['Esc', 'Cancel the path / clear selection'],
      ['M', 'Merge the two shift-clicked roads'],
    ],
  },
  {
    group: 'General',
    items: [
      ['?', 'Show or hide this reference'],
      ['Esc', 'Close a dialog'],
    ],
  },
];

export class ShortcutsDialog extends Modal {
  constructor({ overlayEl, closeBtn, listEl }) {
    super(overlayEl);
    this.list = listEl;
    this._rendered = false;
    closeBtn.addEventListener('click', () => this.close());
  }

  open() {
    if (!this._rendered) {
      this._render();
      this._rendered = true;
    }
    super.open();
  }

  _render() {
    this.list.replaceChildren();
    for (const { group, items } of SHORTCUTS) {
      this.list.appendChild(el('h3', 'shortcut-group-title', group));
      const table = el('dl', 'shortcut-list');
      for (const [keys, description] of items) {
        table.appendChild(el('dt', 'shortcut-keys', keys));
        table.appendChild(el('dd', 'shortcut-desc', description));
      }
      this.list.appendChild(table);
    }
  }
}
