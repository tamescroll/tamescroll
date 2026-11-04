#!/usr/bin/env python3
"""Add the home-screen widget extension to the generated Xcode project.

`tauri ios init --ci` writes gen/apple/project.yml from Tauri's template
on every CI run, and that template has no place for an app extension. So
CI runs this after init: it appends a widget target to project.yml, makes
the app embed it, and the workflow then runs `xcodegen generate`.

Run from app/src-tauri/gen/apple. Fails loudly if the template's shape
changed, rather than building an app that silently has no widget.
"""
import re
import sys

PATH = "project.yml"
NAME = "TameScrollWidget"

src = open(PATH, newline="").read()
nl = "\r\n" if "\r\n" in src else "\n"
text = src.replace("\r\n", "\n")

if f"  {NAME}:" in text:
    print("widget target already in project.yml")
    sys.exit(0)

# The app target is the one Tauri names <app>_iOS.
m = re.search(r"^targets:\n  ([A-Za-z0-9_.-]+_iOS):\n", text, re.M)
if not m:
    sys.exit("project.yml: no `targets:` block with an _iOS app target")
app = m.group(1)

# Appending works only while `targets:` is the last top-level key.
after = text[m.end():]
if re.search(r"^[A-Za-z]", after, re.M):
    sys.exit("project.yml: a top-level key follows `targets:`; update add-to-project.py")

# The app embeds the extension (XcodeGen embeds app-extensions by default).
dep = re.search(rf"^  {re.escape(app)}:\n(?:^(?:    .*|\s*)\n)*?^    dependencies:\n", text, re.M)
if not dep:
    sys.exit(f"project.yml: {app} has no dependencies list")
text = text[: dep.end()] + f"      - target: {NAME}\n" + text[dep.end():]

# The extension's version must equal the app's or App Store Connect
# refuses the upload. Tauri writes the app's CFBundleVersion (with the
# build number) into <app>/Info.plist just before it archives, so the
# extension copies both versions from there at build time.
copy_versions = (
    'set -e; APP_PLIST="$SRCROOT/' + app + '/Info.plist"; '
    'W="$SRCROOT/' + NAME + '/Info.plist"; '
    'for k in CFBundleVersion CFBundleShortVersionString; do '
    'v=$(/usr/libexec/PlistBuddy -c "Print :$k" "$APP_PLIST"); '
    '/usr/libexec/PlistBuddy -c "Set :$k $v" "$W"; done'
)

text = text.rstrip("\n") + "\n" + f"""  {NAME}:
    type: app-extension
    platform: iOS
    deploymentTarget: "15.0"
    sources:
      - path: ../../ios-widget
        excludes:
          - "*.py"
    info:
      path: {NAME}/Info.plist
      properties:
        CFBundleDisplayName: Tame Scroll
        CFBundleShortVersionString: "0"
        CFBundleVersion: "0"
        NSExtension:
          NSExtensionPointIdentifier: com.apple.widgetkit-extension
    settings:
      groups: [app]
      base:
        PRODUCT_NAME: {NAME}
        PRODUCT_BUNDLE_IDENTIFIER: app.tamescroll.client.widgets
        TARGETED_DEVICE_FAMILY: "1"
        SWIFT_VERSION: "5.0"
        CODE_SIGN_STYLE: Automatic
        SKIP_INSTALL: true
        LD_RUNPATH_SEARCH_PATHS: $(inherited) @executable_path/Frameworks @executable_path/../../Frameworks
    dependencies:
      - sdk: WidgetKit.framework
      - sdk: SwiftUI.framework
    preBuildScripts:
      - name: Same version as the app
        basedOnDependencyAnalysis: false
        script: '{copy_versions}'
"""

open(PATH, "w", newline="").write(text.replace("\n", nl))
print(f"added {NAME} to project.yml, embedded in {app}")
