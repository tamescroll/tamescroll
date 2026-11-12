#!/usr/bin/env python3
"""Print the useful part of an Apple .ips crash report: why it stopped
and the crashed thread's frames with symbols. Usage: ips-summary.py FILE"""
import json
import sys

text = open(sys.argv[1]).read()
head, _, body = text.partition("\n")
r = json.loads(body)
for k in ("exception", "termination", "asi", "lastExceptionBacktrace", "crashInfo"):
    if k in r:
        print(k, json.dumps(r[k])[:1500])
images = r.get("usedImages", [])
for t in r.get("threads", []):
    if not t.get("triggered"):
        continue
    print("crashed thread:", t.get("name", ""), t.get("queue", ""))
    for f in t.get("frames", [])[:25]:
        img = images[f["imageIndex"]].get("name", "?") if f.get("imageIndex", -1) < len(images) else "?"
        print(f"  {img}  {f.get('symbol', '?')}  +{f.get('symbolLocation', 0)}  {f.get('sourceFile', '')}:{f.get('sourceLine', '')}")
