#!/usr/bin/env python3
"""Check the Core ML models against Android's TFLite models (macOS only).

parity-ref.npz holds the f32 TFLite outputs (the engine Android ships)
for two fixed inputs, made by spikes/native/coreml_parity_ref.py. This
regenerates the same inputs, runs the .mlpackages, matches outputs by
size (as the page does) and fails if any drifts too far. Also prints how
long each prediction takes on this Mac, for a rough sense of speed.

Usage: parity.py <dir with the .mlpackages and parity-ref.npz>
"""
import sys
import time

import coremltools as ct
import numpy as np

d = sys.argv[1]
ref = np.load(f"{d}/parity-ref.npz")
r = np.random.default_rng(7)
xs = {
    "blazeface": ("input", r.uniform(-1, 1, (1, 256, 256, 3)).astype(np.float32)),
    "faceres": ("input_1", r.uniform(0, 255, (1, 224, 224, 3)).astype(np.float32)),
}
bad = []
for name, (inp, x) in xs.items():
    want = sorted((ref[k] for k in ref.files if k.startswith(name + "/")), key=lambda a: a.size)
    for units in (ct.ComputeUnit.CPU_ONLY, ct.ComputeUnit.ALL):
        m = ct.models.MLModel(f"{d}/{name}.mlpackage", compute_units=units)
        got = m.predict({inp: x})
        t0 = time.time()
        for _ in range(10):
            got = m.predict({inp: x})
        ms = (time.time() - t0) * 100
        got = sorted((np.asarray(v, dtype=np.float32) for v in got.values()), key=lambda a: a.size)
        for w, g in zip(want, got):
            w, g = w.ravel(), g.ravel()
            cos = float(np.dot(w, g) / (np.linalg.norm(w) * np.linalg.norm(g) + 1e-12))
            mx = float(np.max(np.abs(w - g)))
            scale = float(np.max(np.abs(w))) or 1.0
            print(f"{name} {units.name:8s} n={w.size:5d} cosine={cos:.6f} maxabs={mx:.5f} (of {scale:.3f})")
            if w.size != g.size or cos < 0.995 or mx > 0.05 * scale:
                bad.append(f"{name} n={w.size} {units.name}")
        print(f"{name} {units.name}: {ms:.1f} ms per prediction")
if bad:
    sys.exit("Core ML drifted from TFLite: " + ", ".join(bad))
print("parity ok")
