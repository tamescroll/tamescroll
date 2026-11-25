#!/usr/bin/env python3
"""Put the "Tame for <site>" App Shortcuts into the iPhone app, iPhone only.

App Shortcuts must live in the app target itself (Xcode reads their
metadata from the app's own code, not from a linked package), and
`tauri ios init --ci` regenerates gen/apple/project.yml on every CI run,
so CI runs this after init. Run from app/src-tauri/gen/apple. Fails
loudly if the template's shape changed.

It also marks the app iPhone only. Tauri's template never sets
TARGETED_DEVICE_FAMILY, so XcodeGen's default (1,2: iPhone and iPad)
reaches the app (CI proof, 2026-11-04), and an iPad build needs its own
App Store screenshots. The widget script did this until the widgets were
removed (ZV, 2026-11-24: shortcuts only).
"""
import re
import sys

PATH = "project.yml"
MARK = "../../ios-shortcuts"

src = open(PATH, newline="").read()
nl = "\r\n" if "\r\n" in src else "\n"
text = src.replace("\r\n", "\n")

if MARK in text:
    print("App Shortcut already in project.yml")
    sys.exit(0)

m = re.search(r"^targets:\n  ([A-Za-z0-9_.-]+_iOS):\n", text, re.M)
if not m:
    sys.exit("project.yml: no `targets:` block with an _iOS app target")
app = m.group(1)

srcs = re.search(rf"^  {re.escape(app)}:\n(?:^(?:    .*|\s*)\n)*?^    sources:\n", text, re.M)
if not srcs:
    sys.exit(f"project.yml: {app} has no sources list")
entry = f"      - path: {MARK}/TameShortcuts.swift\n"
text = text[: srcs.end()] + entry + text[srcs.end():]

base = re.search(rf"^  {re.escape(app)}:\n(?:^(?:    .*|\s*)\n)*?^    settings:\n      base:\n", text, re.M)
if not base:
    sys.exit(f"project.yml: {app} has no settings.base")
text = text[: base.end()] + '        TARGETED_DEVICE_FAMILY: "1"\n' + text[base.end():]

open(PATH, "w", newline="").write(text.replace("\n", nl))
print(f"added the App Shortcuts to {app}, iPhone only")
