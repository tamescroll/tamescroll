"""#76 mobile-web check: open each site in the app's WebView (signed out,
read-only), then report per rules surface how many elements match and how
many are still visible, whether images are blurred, and which shared page
scripts started. Screenshots to $SCRATCH/par-<name>.png.

  python spikes/gauntlet/probe_parity.py <port> <name>=<url> [...]

Navigates by CDP, so the page wears the DEFAULT settings (CLAUDE.md: a CDP
navigation skips open_platform) -- which is what this check is for.
"""
import json
import os
import re
import subprocess
import sys
import time

from emu_cdp import Tab, page

PORT = int(sys.argv[1])
PKG = 'app.tamescroll.client'
ADB = 'Z:/Android/Sdk/platform-tools/adb.exe'
OUT = os.environ.get('SCRATCH', '.')
ROOT = os.path.join(os.path.dirname(__file__), '..', '..')

SITE_FILE = {
    'twitch': 'twitch.txt', 'linkedin': 'linkedin.txt', 'pinterest': 'pinterest.txt',
    'tiktok': 'tiktok.txt', 'reddit': 'reddit.txt', 'x': 'x.txt',
    'instagram': 'instagram.txt', 'facebook': 'facebook.txt', 'youtube': 'youtube.txt',
}


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True, timeout=120).stdout


def surfaces(site):
    out, cur = {}, None
    for line in open(os.path.join(ROOT, 'rules', SITE_FILE[site]), encoding='utf8'):
        line = line.strip()
        m = re.match(r'!surface:\s*(\S+)', line)
        if m:
            cur = m.group(1)
            out.setdefault(cur, [])
        elif cur and '##' in line and not line.startswith('!'):
            out[cur].append(line.split('##', 1)[1])
    return out


def attach():
    for _ in range(25):
        pid = adb('shell', 'pidof %s' % PKG).strip()
        if pid:
            for line in adb('shell', 'cat /proc/net/unix').splitlines():
                if 'webview_devtools_remote_' + pid in line:
                    sock = line.strip().split('@')[-1]
                    subprocess.run([ADB, 'forward', 'tcp:%d' % PORT, 'localabstract:%s' % sock], capture_output=True)
                    return
        time.sleep(2)
    raise SystemExit('no devtools socket')


def shot(name):
    png = subprocess.run([ADB, 'exec-out', 'screencap', '-p'], capture_output=True, timeout=60).stdout
    open(os.path.join(OUT, 'par-%s.png' % name), 'wb').write(png)


PROBE = r"""(function(S){
  function vis(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).display!=='none';}
  var out={url:location.href, surf:{}, imgs:0, blurred:0, scripts:{}};
  Object.keys(S).forEach(function(k){var n=0,v=0;S[k].forEach(function(q){try{document.querySelectorAll(q).forEach(function(e){n++;if(vis(e))v++;});}catch(x){}});out.surf[k]=[n,v];});
  document.querySelectorAll('img').forEach(function(i){var r=i.getBoundingClientRect();if(r.width<40||r.height<40)return;out.imgs++;var f=getComputedStyle(i).filter;var el=i;for(var d=0;d<6&&el&&(!f||f==='none');d++){el=el.parentElement;if(el)f=getComputedStyle(el).filter;}if(f&&f.indexOf('blur')>=0)out.blurred++;});
  out.scripts={nags:!!window.__tsLoginNags, discovery:!!window.__tsRedditDiscovery, status:!!window.__tsHiddenStatus, rules:!!window.__TS_RULES__};
  out.nagHidden=document.querySelectorAll('[data-ts-nag="1"]').length;
  out.dialogs=[].slice.call(document.querySelectorAll('[role="dialog"],dialog')).filter(vis).length;
  return out;})"""


def main():
    attach()
    for arg in sys.argv[2:]:
        name, url = arg.split('=', 1)
        site = name.split('-')[0]
        tab = Tab(page(PORT, want=''))
        tab.cmd('Page.navigate', url=url)
        time.sleep(14)
        tab = Tab(page(PORT, want=''))
        shot(name)
        # scroll a little, the way a reader would, then let pop-ups appear
        tab.eval('window.scrollBy(0, 900)')
        time.sleep(5)
        res = tab.eval(PROBE + '(%s)' % json.dumps(surfaces(site)))
        print(name, json.dumps(res), flush=True)
        shot(name + '-s')


main()
