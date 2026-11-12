#!/usr/bin/env python3
"""Compile the blur's Core ML models into the iPhone app.

`tauri ios init --ci` regenerates gen/apple/project.yml on every CI run,
so CI runs this after init (and after ios-widget/add-to-project.py): it
adds both .mlpackages to the app target's sources, where Xcode compiles
each into a .mlmodelc inside the app. TsInfer.swift loads them by
name. Run from app/src-tauri/gen/apple. Fails loudly if the template's
shape changed, rather than building an app whose blur has no models.
"""
import re
import sys

PATH = "project.yml"
MARK = "../../ios-models"

src = open(PATH, newline="").read()
nl = "\r\n" if "\r\n" in src else "\n"
text = src.replace("\r\n", "\n")

if MARK in text:
    print("Core ML models already in project.yml")
    sys.exit(0)

m = re.search(r"^targets:\n  ([A-Za-z0-9_.-]+_iOS):\n", text, re.M)
if not m:
    sys.exit("project.yml: no `targets:` block with an _iOS app target")
app = m.group(1)

srcs = re.search(rf"^  {re.escape(app)}:\n(?:^(?:    .*|\s*)\n)*?^    sources:\n", text, re.M)
if not srcs:
    sys.exit(f"project.yml: {app} has no sources list")
# Each package as ONE file reference: listed as a folder, XcodeGen would
# walk into the package and copy its parts as loose resources.
pkgs = "".join(
    f"      - path: {MARK}/{name}.mlpackage\n        type: file\n        buildPhase: sources\n"
    for name in ("blazeface", "faceres")
)
text = text[: srcs.end()] + pkgs + text[srcs.end():]

# No generated Swift classes: TsInfer loads the models by file name.
base = re.search(rf"^  {re.escape(app)}:\n(?:^(?:    .*|\s*)\n)*?^    settings:\n      base:\n", text, re.M)
if not base:
    sys.exit(f"project.yml: {app} has no settings.base")
text = text[: base.end()] + "        COREML_CODEGEN_LANGUAGE: None\n" + text[base.end():]

open(PATH, "w", newline="").write(text.replace("\n", nl))
print(f"added the Core ML models to {app}")
