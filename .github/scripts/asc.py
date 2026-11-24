"""App Store Connect API access for CI scripts: an ES256 token signed
with openssl (standard library only) and a JSON call helper. Reads
APPLE_API_KEY (key ID), APPLE_API_ISSUER and APPLE_API_KEY_PATH, and
never prints the key or the token."""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

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


class ApiError(Exception):
    def __init__(self, code: int, body: str):
        super().__init__(f"HTTP {code}: {body[:600]}")
        self.code = code


def call(method: str, path: str, payload=None, soft=False):
    """soft=True raises ApiError instead of ending the script."""
    req = urllib.request.Request(
        "https://api.appstoreconnect.apple.com" + path,
        method=method,
        data=json.dumps(payload).encode() if payload else None,
        headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            body = r.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        if soft:
            raise ApiError(e.code, e.read().decode())
        sys.exit(f"{method} {path.split('?')[0]}: HTTP {e.code}: {e.read().decode()[:600]}")


