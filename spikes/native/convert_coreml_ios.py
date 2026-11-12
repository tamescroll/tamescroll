import sys, os, numpy as np, coremltools as ct
src, out = sys.argv[1], sys.argv[2]
for name in ["blazeface", "faceres"]:
    m = ct.convert(os.path.join(src, name), source="tensorflow", convert_to="mlprogram",
                   minimum_deployment_target=ct.target.iOS15)
    p = os.path.join(out, name + ".mlpackage"); m.save(p)
    spec = m.get_spec()
    print(name, [(i.name, list(i.type.multiArrayType.shape)) for i in spec.description.input],
          [(o.name) for o in spec.description.output])
