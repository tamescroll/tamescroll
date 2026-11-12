import sys, numpy as np, tensorflow as tf
out = sys.argv[2]; d = sys.argv[1]
r = np.random.default_rng(7)
xs = {"blazeface": r.uniform(-1, 1, (1, 256, 256, 3)).astype(np.float32),
      "faceres": r.uniform(0, 255, (1, 224, 224, 3)).astype(np.float32)}
res = {}
for name, x in xs.items():
    it = tf.lite.Interpreter(model_path=f"{d}/{name}.tflite"); it.allocate_tensors()
    it.set_tensor(it.get_input_details()[0]["index"], x); it.invoke()
    for o in it.get_output_details():
        v = it.get_tensor(o["index"]); res[f"{name}/{o['name']}"] = v; print(name, o["name"], v.shape)
np.savez_compressed(out, **res)
