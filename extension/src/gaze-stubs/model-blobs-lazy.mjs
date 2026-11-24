// The extension's stand-in for app/gaze/src/model-blobs-lazy.mjs.
//
// The app's version loads the models as a SCRIPT from the page's own
// origin, a path only the app's request interceptor answers. An
// extension never loads a script at run time, and its models are files
// in its own package (detector.js modelBase), so here there is no second
// delivery: a failed package fetch is a failed load, and the runtime
// keeps every picture covered, as it does for any model that cannot load.
export function ready() {
  return Promise.reject(new Error('no inline models in the extension'));
}

export function blob() {
  return undefined;
}
