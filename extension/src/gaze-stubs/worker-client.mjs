// The extension's stand-in for app/gaze/src/worker-client.mjs.
//
// The app starts its inference worker from a script on the page's own
// origin. A content script cannot start one from the package, and an
// extension never loads a script at run time, so the extension runs the
// runtime's in-page path (gaze-prelude.js sets __TS_NO_WORKER). If
// anything still asks for a worker, this throws inside the runtime's own
// try, which leaves it on the in-page path.
export var WORKER_PATH = null;

export function createWorkerClient() {
  throw new Error('no inference worker in the extension');
}
