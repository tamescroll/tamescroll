#!/usr/bin/env python3
"""Put the "Tame for YouTube" App Shortcut into the iPhone app.

App Shortcuts must live in the app target itself (Xcode reads their
metadata from the app's own code, not from a linked package), and
`tauri ios init --ci` regenerates gen/apple/project.yml on every CI run,
so CI runs this after init. Run from app/src-tauri/gen/apple. Fails
loudly if the template's shape changed.
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

open(PATH, "w", newline="").write(text.replace("\n", nl))
print(f"added the App Shortcut to {app}")
