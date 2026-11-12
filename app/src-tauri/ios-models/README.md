# iPhone blur models (Core ML)

`blazeface.mlpackage` (face finder) and `faceres.mlpackage` (gender and
age) are the same models as `app/gaze/models/`, converted for Core ML so
iPhone runs them on its Neural Engine or GPU (TsInfer.swift) instead of
WebGL in the page.

Regenerate (Python 3.11, TF 2.15, coremltools 9, tfjs-graph-converter):

1. `MODELS_ONLY=blazeface,faceres python spikes/native/convert.py`
   (writes `spikes/native/savedmodel/` and the TFLite files)
2. `python spikes/native/convert_coreml_ios.py spikes/native/savedmodel app/src-tauri/ios-models`
3. `python spikes/native/coreml_parity_ref.py spikes/native/out app/src-tauri/ios-models/parity-ref.npz`

CI checks the packages against `parity-ref.npz` on a Mac (`parity.py`)
before every iPhone build, and `add-to-project.py` compiles them into
the app.
