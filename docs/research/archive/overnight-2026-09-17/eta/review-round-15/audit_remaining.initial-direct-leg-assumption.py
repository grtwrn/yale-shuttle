from pathlib import Path
import json,gzip,sqlite3,collections,statistics,hashlib
O=Path(__file__).resolve().parent;B=O.parent/'cycle-16'
db=sqlite3.connect('file:/home/gwarren/projects/yale-shuttle-watcher/release-integration-data/outcomes-complete.db?mode=ro',uri=True);db.row_factory=sqlite3.Row
meta=json.loads((B/'current-meta.json').read_text());tops={int(k):v['stops'] for k,v in meta['routeMeta'].items()}
def key(r):return (r['poll'],r['route'],r['bus'],r['targetIndex'],r['occurrence'])
def getv(i):return dict(db.execute('select * from stop_visits where id=?',(i,)).fetchone())
inv=json.loads((B/'remaining-zero-hop-inventory.json').read_text());unique={key(c['row']):c['row'] for c in inv['cases']};selected=collections.defaultdict(list)
for c in inv['cases']:selected[(c['arm'],c['row']['poll'])].append(c)
counts=collections.Counter();cases=[];directProofs=[]
for arm in ['current','canonical']:
 for line in gzip.open(B/(arm+'-wire.jsonl.gz'),'rt'):
  f=json.loads(line)
  for c in selected.get((arm,f['i']),[]):
   r=c['row'];seq=tops[r['route']];label=meta['routeMeta'][str(r['route'])]['label'];N=len(seq);track=f['tracking'][label+'|'+r['bus']]
   assert track==c['tracking'] and f['at']==r['at'];s=getv(r['sourceId']);target=getv(r['targetId']);assert s==c['latestHistoricalSource'] and target==c['scoredTarget']
   bi=next(i for i,b in enumerate(f['wire']['buses']) if b[:2]==[r['bus'],label]);rows=[w for w in f['wire']['rows'] if w[0]==bi]
   origins=set(range(N))
   for w in rows:origins&={(i-w[5])%N for i,stop in enumerate(seq) if stop==w[1]}
   assert len(origins)==1;origin=origins.pop();assert origin==r['targetIndex'];rr=sorted((w for w in rows if (origin+w[5])%N==r['targetIndex']),key=lambda w:w[5]);assert rr[r['occurrence']][2:6]==r[arm] and r[arm][3]==0
   assert db.execute('select id from stop_visits where route_id=? and bus_name=? and anchored_at<=? order by anchored_at desc,id desc limit 1',(r['route'],s['bus_name'],r['at'])).fetchone()['id']==s['id']
   pins=[dict(v) for v in db.execute('select * from stop_visits where route_id=? and bus_name=? and pinned_at=?',(r['route'],s['bus_name'],track[4]))]
   category='no-unique-pin-any-index'
   if len(pins)==1:
    p=pins[0]
    category='exact-pin-at-priced-origin' if p['stop_index']==origin else 'exact-pin-at-different-occurrence-of-same-stop' if p['stop_id']==r['targetStop'] else 'exact-pin-at-different-stop'
    if p['stop_index']==origin:
     legs=[dict(l) for l in db.execute('select * from legs where route_id=? and bus_name=? and from_index=? and departed_at=? and reached=1',(r['route'],s['bus_name'],origin,p['departed_at']))]
     matching=[l for l in legs if l['to_index']==s['stop_index'] and l['arrived_at']==(s['arrived_at'] if s['arrived_at'] is not None else s['departed_at'])]
     assert len(matching)==1
     assert p['anchored_at']<s['anchored_at']<=r['at'] and p['departed_at']<=s['anchored_at']
     directProofs.append({'arm':arm,'key':key(r),'oldTargetId':r['targetId'],'priorVisit':p,'latestSource':s,'directLeg':matching[0],'wireOrigin':origin,'trackingRestIndex':track[3],'trackingRestSince':track[4],'priorArrivalRelativeSec':(p['arrived_at']-r['at'])/1000})
   counts[arm+':'+category]+=1;counts[arm+':checked']+=1
   cases.append({'arm':arm,'key':key(r),'wireOrigin':origin,'trackingRestIndex':track[3],'category':category,'pinVisitIds':[v['id'] for v in pins],'row':r})
rawTargets=collections.defaultdict(set)
for r in unique.values():rawTargets[r['poll']].add((r['route'],r['bus']))
raw=[]
for i,line in enumerate((O.parent/'cycle-14/all-route-raw-frames.jsonl').open()):
 if i>max(rawTargets):break
 if i not in rawTargets:continue
 f=json.loads(line)
 for b in f['buses']:
  if (b['route_id'],b['bus_name'].lstrip('#')) in rawTargets[i]:raw.append({'poll':i,**{k:b.get(k) for k in ['observed_at','bus_name','route_id','last_stop_id','at_stop_id','stationary','stationary_since','at_stop_since']}})
# Descriptive sensitivity only. Keep the inclusive result and all uncertain rows;
# these aggregates do NOT certify the complementary cohort's visit identities.
strata={k:{a:[] for a in ['current','canonical']} for k in ['inclusive','uncertain-zero-hop','other-rows-not-identity-certified']};changed=[]
for line in (B/'connected-pairs.jsonl').open():
 r=json.loads(line);g='uncertain-zero-hop' if key(r) in unique else 'other-rows-not-identity-certified'
 for a in ['current','canonical']:
  v=max(0,r[a][0]);ae=abs(v-r['truthSec']);strata['inclusive'][a].append(ae);strata[g][a].append(ae)
 if key(r) in unique and r['current']!=r['canonical']:changed.append(r)
metrics={g:{a:{'n':len(v),'sumAE':sum(v),'MAE':statistics.mean(v)} for a,v in aa.items()} for g,aa in strata.items()}
for v in metrics.values():v['canonicalMinusCurrentMAE']=v['canonical']['MAE']-v['current']['MAE']
assert len(unique)==58 and len(changed)==1;assert counts['current:checked']==57 and counts['canonical:checked']==58
result={'counts':counts,'uniquePhysicalRows':len(unique),'changedUncertainRows':changed,'descriptiveSensitivity':metrics,'sameOriginPinDespiteDifferentTrackedRest':directProofs,'cases':cases,'rawContext':raw,'limits':'No exclusion, retargeting, app change or calibrated probability claim. Exploratory diagnostic requested by review. Exact-pin/different-rest cases need longitudinal provenance review before changing the builder label contract; same-stop IDs at repeated physical positions must not be conflated. Complementary rows are not fully identity certified.'}
(O/'remaining-independent-audit.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'counts':counts,'uniquePhysicalRows':len(unique),'changedUncertainRows':changed,'descriptiveSensitivity':metrics,'sameOriginDifferentRestCases':[{'arm':p['arm'],'key':p['key'],'priorVisitId':p['priorVisit']['id'],'latestSourceId':p['latestSource']['id'],'legId':p['directLeg']['id'],'priorArrivalRelativeSec':p['priorArrivalRelativeSec']} for p in directProofs]},indent=2));db.close()
