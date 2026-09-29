// The input interface every canvas tool implements (FR-32 and the per-tool
// FRs). main.js turns DOM canvas/keyboard events into these calls for the
// active tool and keeps only the global concerns (pan, zoom, undo/redo, fit
// view, dialogs, tool switching) for itself - so a new tool is a new class
// here, not another branch in main.js.
//
// Tools never touch the DOM. They get world coordinates (meters) and plain
// modifier/button info:
//
//   pointer input  { x, y, button, shiftKey, mod, hitRadius }
//     x, y       world position
//     button     0 = primary (main.js handles middle-button / Space panning
//                itself; tools only ever see button 0)
//     shiftKey   Shift held
//     mod        Ctrl (or Cmd on macOS) held
//     hitRadius  the hit-test / snap radius, in meters at the current zoom
//
//   key input      { key, shiftKey, mod }
//     key        KeyboardEvent.key, lower-cased when it is a single
//                character ('Z' with Shift held -> 'z')
//
// Each handler mutates the model through Project methods, records its own
// undo steps, and calls the tool's onChange like any other tool action.

export class Tool {
  /** Primary-button press. Return true to own the pointer until release (a gesture). */
  onPointerDown() { return false; }

  /** Pointer moved - during this tool's gesture, or hovering while it is active. */
  onPointerMove() {}

  /** Release (or cancel) of a gesture this tool started in onPointerDown. */
  onPointerUp() {}

  /** A click that was not the end of a pan. */
  onClick() {}

  /** Double-click. Return true if handled (main.js then prevents the default). */
  onDoubleClick() { return false; }

  /** A key press not claimed by a global shortcut. Return true if handled. */
  onKeyDown() { return false; }

  /** True while a pointer gesture (drag, marquee, rubber band...) is in progress. */
  get gestureActive() { return false; }

  /** One-line hint for the status bar while this tool is active. */
  statusText() { return ''; }

  /** Transient state for the renderer to draw (view state, not model data). */
  overlay() { return null; }
}
