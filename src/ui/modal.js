// Shared behaviour for the modal dialogs (canvas size, shortcuts, export):
// an overlay element shown/hidden via `hidden`, closed by clicking the
// backdrop outside the dialog box. Subclasses add their own content.

export class Modal {
  constructor(overlayEl) {
    this.overlay = overlayEl;
    overlayEl.addEventListener('click', (ev) => {
      if (ev.target === overlayEl) this.close();
    });
  }

  get isOpen() {
    return !this.overlay.hidden;
  }

  open() {
    this.overlay.hidden = false;
  }

  close() {
    this.overlay.hidden = true;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }
}
