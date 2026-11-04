#!/usr/bin/env python3
"""Give the newest TestFlight build to every tester group.

New uploads reach internal testers on their own, but an external group
(the public link) only gets a build that is added to it and has passed
Apple's beta review. ZV wants external testers always on the latest
build (2026-11-03), so after each upload CI:

  1. waits for Apple to finish processing the build,
  2. adds it to every external group that does not have it,
  3. submits it for beta review if it was never submitted.

`--status` only prints what Apple has, changing nothing.

Usage: testflight-testers.py <bundle id> [--status] [--wait-minutes N]
"""
import sys
import time
import urllib.parse

from asc import ApiError, call

bundle = sys.argv[1]
status_only = "--status" in sys.argv
wait = int(sys.argv[sys.argv.index("--wait-minutes") + 1]) if "--wait-minutes" in sys.argv else 30

apps = call("GET", "/v1/apps?" + urllib.parse.urlencode({"filter[bundleId]": bundle}))["data"]
apps = [a for a in apps if a["attributes"]["bundleId"] == bundle]
if not apps:
    sys.exit(f"no app with bundle ID {bundle}")
app = apps[0]["id"]


def builds():
    q = urllib.parse.urlencode({"filter[app]": app, "sort": "-uploadedDate", "limit": 5})
    return call("GET", f"/v1/builds?{q}")["data"]


def beta_state(build_id):
    d = call("GET", f"/v1/builds/{build_id}/buildBetaDetail")["data"]["attributes"]
    return d.get("internalBuildState"), d.get("externalBuildState")


groups = call("GET", f"/v1/apps/{app}/betaGroups?limit=50")["data"]
print("groups:")
for g in groups:
    a = g["attributes"]
    kind = "internal" if a.get("isInternalGroup") else "external"
    link = " (public link)" if a.get("publicLinkEnabled") else ""
    have = [b["attributes"]["version"] for b in call("GET", f"/v1/betaGroups/{g['id']}/builds?limit=5")["data"]]
    print(f"  {a['name']}: {kind}{link}; builds {', '.join(have) or 'none'}")

print("newest builds:")
for b in builds():
    a = b["attributes"]
    i, e = beta_state(b["id"])
    print(f"  {a['version']}: {a['processingState']}, uploaded {a['uploadedDate']}, internal {i}, external {e}")

if status_only:
    sys.exit(0)

deadline = time.time() + wait * 60
while True:
    newest = builds()[0]
    state = newest["attributes"]["processingState"]
    if state == "VALID":
        break
    if state in ("FAILED", "INVALID"):
        sys.exit(f"build {newest['attributes']['version']} is {state} at Apple")
    if time.time() > deadline:
        sys.exit(f"build {newest['attributes']['version']} still {state} after {wait} min; run again later")
    print(f"build {newest['attributes']['version']} is {state}; waiting")
    time.sleep(60)

bid, version = newest["id"], newest["attributes"]["version"]
for g in groups:
    if g["attributes"].get("isInternalGroup"):
        continue
    have = [b["id"] for b in call("GET", f"/v1/betaGroups/{g['id']}/builds?limit=50")["data"]]
    if bid in have:
        print(f"{g['attributes']['name']} already has {version}")
        continue
    call("POST", f"/v1/betaGroups/{g['id']}/relationships/builds", {"data": [{"type": "builds", "id": bid}]})
    print(f"added {version} to {g['attributes']['name']}")

_, external = beta_state(bid)
if external in ("READY_FOR_BETA_SUBMISSION", "MISSING_EXPORT_COMPLIANCE", None):
    try:
        call("POST", "/v1/betaAppReviewSubmissions", {"data": {
            "type": "betaAppReviewSubmissions",
            "relationships": {"build": {"data": {"type": "builds", "id": bid}}},
        }}, soft=True)
        print(f"submitted {version} for beta review")
    except ApiError as e:
        sys.exit(f"could not submit {version} for beta review: {e}")
else:
    print(f"{version} beta review state: {external}")
