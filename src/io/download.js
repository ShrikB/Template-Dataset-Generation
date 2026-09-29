// Shared browser-download mechanics (io/ layer — the only layer that touches
// file format / File APIs). Both src/io/exporter.js (Export button, M6) and
// src/io/projectFile.js (Save button, M7) need to turn a JSON-safe payload
// into a downloaded file — identical Blob + anchor-click plumbing either
// way, so it's factored out here instead of each one reimplementing it.
// DOM-only, not unit-tested — same convention as the rest of ui/.
//
// NFR-4: serialization is a plain JSON.stringify on the main thread. It used
// to run in a worker, but postMessage structured-clones the payload on the
// main thread first, which cost as much as the stringify it offloaded.
// Measured in Firefox on a 300-building/300-prop/40-road/10-region layout
// (a 168 KB file): stringify 1.1 ms median; the worker path blocked the main
// thread 1.5 ms (worker start + clone) and took ~20 ms end to end.

export function downloadJson(payload, filename) {
  const json = JSON.stringify(payload, null, 2);
  downloadBlob(new Blob([json], { type: 'application/json' }), filename);
}

/** Trigger a browser download of `blob` as `filename`. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}
