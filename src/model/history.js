// Undo/redo history (FR-16). Minimum 50-step history.
//
// Snapshot-based rather than command/inverse-based: each undo step is a
// full deep clone of project.snapshot() taken *before* a mutation, not a
// hand-written inverse. Project state here is small, plain data (NFR-3:
// hundreds of assets, tens of road segments), so cloning it is cheap, and
// this sidesteps having to hand-write a correct inverse for every mutating
// method on Project (especially fiddly ones like road split/merge, which
// replace entities with brand-new ids). See project.js's snapshot/restore.
//
// Two ways to record a step, matching the two shapes of edit in this app:
//  - record(fn): one atomic mutation (a click, a dropdown change) - snapshot
//    before, run fn, push the "before" snapshot as one step.
//  - begin()/commit(): a multi-tick gesture (a drag) that should collapse
//    into ONE undo step regardless of how many intermediate positions it
//    passed through. Call begin() once at gesture start, mutate the project
//    directly on every tick (no per-tick recording), then commit() once at
//    gesture end. cancel() aborts the gesture and restores pre-gesture state.
//
// `onChange` fires whenever canUndo/canRedo may have changed (a step pushed,
// undone, redone, or the stacks cleared), so the UI never has to remember to
// refresh its Undo/Redo buttons after each call.
//
// No app/DOM state here - just the project + snapshot stacks (NFR-5).

export const DEFAULT_HISTORY_LIMIT = 50;

export class History {
  constructor(project, { limit = DEFAULT_HISTORY_LIMIT, onChange = () => {} } = {}) {
    if (!(limit >= 1)) {
      throw new RangeError(`history: limit must be >= 1, got ${limit}`);
    }
    this.project = project;
    this.limit = limit;
    this.onChange = onChange;
    this._undoStack = [];
    this._redoStack = [];
    this._pending = null; // snapshot taken at begin(), while a gesture is open
  }

  get canUndo() {
    return this._undoStack.length > 0;
  }

  get canRedo() {
    return this._redoStack.length > 0;
  }

  /**
   * Run `mutateFn` (which mutates `project`) as one atomic undo step. If
   * `mutateFn` throws, the project is rolled back to its pre-call state and
   * the error is re-thrown - a partially-applied bulk edit never lingers in
   * the model. Returns whatever `mutateFn` returns.
   */
  record(mutateFn) {
    const before = this.project.snapshot();
    let result;
    try {
      result = mutateFn();
    } catch (err) {
      this.project.restore(before);
      throw err;
    }
    this._push(before);
    return result;
  }

  /** Start a multi-tick gesture (e.g. a drag) as one pending undo step. */
  begin() {
    if (this._pending) return; // a gesture is already open - ignore a nested begin
    this._pending = this.project.snapshot();
  }

  /** True while a begin()/commit() gesture is in progress. */
  get inTransaction() {
    return this._pending !== null;
  }

  /** Finish the open gesture, pushing one undo step only if anything changed. */
  commit() {
    if (!this._pending) return;
    const before = this._pending;
    this._pending = null;
    this._push(before);
  }

  /** Abandon the open gesture, restoring project state to how it was at begin(). */
  cancel() {
    if (!this._pending) return;
    this.project.restore(this._pending);
    this._pending = null;
  }

  _push(before) {
    const after = this.project.snapshot();
    if (sameSnapshot(before, after)) return; // nothing actually changed - not a step
    this._undoStack.push(before);
    if (this._undoStack.length > this.limit) this._undoStack.shift();
    this._redoStack = [];
    this.onChange();
  }

  undo() {
    if (!this.canUndo) return false;
    const before = this._undoStack.pop();
    this._redoStack.push(this.project.snapshot());
    this.project.restore(before);
    this.onChange();
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    const after = this._redoStack.pop();
    this._undoStack.push(this.project.snapshot());
    this.project.restore(after);
    this.onChange();
    return true;
  }

  /** Drop all history (e.g. after loading a new project). Does not touch project state. */
  clear() {
    this._undoStack = [];
    this._redoStack = [];
    this._pending = null;
    this.onChange();
  }
}

function sameSnapshot(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
