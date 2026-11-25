"""Read-only DOM survey of the app's current page, for writing mobile-web
selectors (#76): each sizeable image with its nearest test-hook ancestors,
and the page's section headings with theirs.

  python spikes/gauntlet/probe_dom.py <port> [url]
"""
import json
import sys
import time

from emu_cdp import Tab, page

PORT = int(sys.argv[1])
tab = Tab(page(PORT, want=''))
if len(sys.argv) > 2:
    tab.cmd('Page.navigate', url=sys.argv[2])
    time.sleep(14)
    tab = Tab(page(PORT, want=''))

JS = r"""(function(){
  function hooks(e){var out=[];for(var d=0;e&&d<12;d++,e=e.parentElement){
    var a=[];['data-a-target','data-test-selector','data-testid','data-test-id','role','aria-label'].forEach(function(k){var v=e.getAttribute&&e.getAttribute(k);if(v)a.push(k+'='+String(v).slice(0,40));});
    var c=(e.className&&e.className.baseVal===undefined?String(e.className):'').split(/\s+/).filter(function(x){return x&&x.length<40;}).slice(0,3);
    out.push(e.tagName.toLowerCase()+(a.length?'['+a.join('|')+']':'')+(c.length?'.'+c.join('.'):''));}
    return out.join(' < ');}
  var imgs=[].slice.call(document.querySelectorAll('img,video')).filter(function(i){var r=i.getBoundingClientRect();return r.width>=60&&r.height>=40;}).slice(0,10).map(function(i){var r=i.getBoundingClientRect();return Math.round(r.width)+'x'+Math.round(r.height)+' f='+getComputedStyle(i).filter+' :: '+hooks(i);});
  var heads=[].slice.call(document.querySelectorAll('h1,h2,h3,[role="heading"]')).slice(0,15).map(function(h){return (h.textContent||'').trim().slice(0,50)+' :: '+hooks(h.parentElement);});
  return {url:location.href, imgs:imgs, heads:heads};})()"""
print(json.dumps(tab.eval(JS), indent=1))
