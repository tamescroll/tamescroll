#!/usr/bin/env python3
"""Make sure a bundle ID exists in the Apple developer account.

Xcode's cloud signing registers new bundle IDs while archiving, but
`tauri ios build` with an API key signs only at export, and export
refuses to register one ("Automatic signing cannot register bundle
identifier", first widget build, 2026-11-04). So CI registers the
widget's ID through the App Store Connect API first. Existing IDs are
left alone.

Usage: asc-bundle-id.py <identifier> <name>
Reads APPLE_API_KEY (key ID), APPLE_API_ISSUER and APPLE_API_KEY_PATH.
Never prints the key or the token. Standard library plus `openssl`.
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

ident, name = sys.argv[1], sys.argv[2]
key_id = os.environ["APPLE_API_KEY"]
issuer = os.environ["APPLE_API_ISSUER"]
key_path = os.environ["APPLE_API_KEY_PATH"]


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def der_to_raw(sig: bytes) -> bytes:
    """openssl gives an ECDSA signature as DER; a JWT wants r || s."""
    assert sig[0] == 0x30
    i = 2 if sig[1] < 0x80 else 2 + (sig[1] & 0x7F)
    out = b""
    for _ in range(2):
        assert sig[i] == 0x02
        n = sig[i + 1]
        out += sig[i + 2 : i + 2 + n].lstrip(b"\x00").rjust(32, b"\x00")
        i += 2 + n
    return out


def token() -> str:
    now = int(time.time())
    head = b64(json.dumps({"alg": "ES256", "kid": key_id, "typ": "JWT"}).encode())
    body = b64(json.dumps({"iss": issuer, "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"}).encode())
    signing_input = f"{head}.{body}".encode()
    der = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", key_path],
        input=signing_input, capture_output=True, check=True,
    ).stdout
    return f"{head}.{body}.{b64(der_to_raw(der))}"


def call(method: str, path: str, payload=None):
    req = urllib.request.Request(
        "https://api.appstoreconnect.apple.com" + path,
        method=method,
        data=json.dumps(payload).encode() if payload else None,
        headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path.split('?')[0]}: HTTP {e.code}: {e.read().decode()[:600]}")


q = urllib.parse.urlencode({"filter[identifier]": ident, "limit": 200})
found = [d for d in call("GET", f"/v1/bundleIds?{q}")["data"] if d["attributes"]["identifier"] == ident]
if found:
    print(f"{ident} already registered")
    sys.exit(0)

call("POST", "/v1/bundleIds", {
    "data": {"type": "bundleIds", "attributes": {"identifier": ident, "name": name, "platform": "IOS"}}
})
print(f"registered {ident} ({name})")
