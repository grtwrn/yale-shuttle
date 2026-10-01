from pathlib import Path
import json,hashlib,subprocess
root=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17'); art=root.parent/'overnight-2026-09-17'/'ux'; out=art/'review-ux09-map'
base='98e535b99649e74ca599d2e33bcfdc46df83d30d'; prev='da51fcb0af70f554ef0b141aa07d4a390f3c7de0'
for f in ['web/src/CrashRecovery.tsx','web/src/main.tsx','scripts/crash-recovery-check.mjs']:
 p='services/shuttle-v2/'+f
 assert subprocess.check_output(['git','show',prev+':'+p],cwd=root)==(root/p).read_bytes(),p
current=(root/'services/shuttle-v2/web/src/TransitMap.tsx').read_text()
old=subprocess.check_output(['git','show',base+':services/shuttle-v2/web/src/TransitMap.tsx'],cwd=root,text=True)
for comment in ['    // Filters rebuild this map and changing tabs removes it. As on trip maps,\n    // disable CSS zoom: map.stop() does not cancel its delayed completion.\n','    // Done can remove the map during a zoom. Keep zoom immediate, as on trip\n    // maps, so a delayed CSS transition cannot run after teardown.\n']:
 assert comment in current; current=current.replace(comment,'')
line='const map = L.map(ref.current, { zoomControl: true, scrollWheelZoom: true, zoomAnimation: false });'
assert current.count(line)==2
current=current.replace(line,'const map = L.map(ref.current, { zoomControl: true, scrollWheelZoom: true });')
assert current==old
checked={}
for p in (art/'ux-09'/'baseline-dist').rglob('*.js.map'):
 data=json.loads(p.read_text())
 for src,content in zip(data['sources'],data['sourcesContent']):
  if src.endswith('/web/src/TransitMap.tsx') or src.endswith('/web/src/main.tsx'):
   file='services/shuttle-v2/web/src/'+src.split('/')[-1]
   assert content==subprocess.check_output(['git','show',base+':'+file],cwd=root,text=True),file
   checked[file]=hashlib.sha256(content.encode()).hexdigest()
assert len(checked)==2
result={'priorRecoveryByteIdentical':True,'mapOnlyTwoOptionsComments':True,'frozenBaselineSourceVerified':checked}
(out/'scope-audit.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
