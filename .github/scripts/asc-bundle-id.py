#!/usr/bin/env python3
"""Make sure a bundle ID exists in the Apple developer account.

Xcode's cloud signing registers new bundle IDs while archiving, but
`tauri ios build` with an API key signs only at export, and export
refuses to register one ("Automatic signing cannot register bundle
identifier", first widget build, 2026-11-04). So CI registers the
widget's ID through the App Store Connect API first. Existing IDs are
left alone.

Usage: asc-bundle-id.py <identifier> <name>
"""
import sys
import urllib.parse

from asc import call

ident, name = sys.argv[1], sys.argv[2]

q = urllib.parse.urlencode({"filter[identifier]": ident, "limit": 200})
found = [d for d in call("GET", f"/v1/bundleIds?{q}")["data"] if d["attributes"]["identifier"] == ident]
if found:
    print(f"{ident} already registered")
    sys.exit(0)

call("POST", "/v1/bundleIds", {
    "data": {"type": "bundleIds", "attributes": {"identifier": ident, "name": name, "platform": "IOS"}}
})
print(f"registered {ident} ({name})")
