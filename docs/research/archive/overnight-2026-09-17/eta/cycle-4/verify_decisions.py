import collections,gzip,hashlib,json,math
from pathlib import Path
O=Path(__file__).resolve().parent
plan=json.loads((O/'PLAN.json').read_text())
for p,h in plan['hashes'].items():assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h,p
frames=list(map(json.loads,gzip.open(O/'fleet-wire.jsonl.gz','rt')))
wirecount=0;distcount=0;zeros=0
for f in frames:
 w=f['server_eta'];assert w['at']==w['servedAt']==f['at'];assert len(w['distributions'])==len(w['rows'])
 identity=set()
 for row,d in zip(w['rows'],w['distributions']):
  key=(row[0],row[1],row[5]);assert key not in identity;identity.add(key)
  assert len(row)==9 and all(math.isfinite(v) for v in row)
  assert len(d)==50 and all(math.isfinite(v) and v>=0 for v in d) and d==sorted(d)
  assert 0<=row[0]<len(w['buses']) and row[5]>=0 and row[3]<=row[4]
  wirecount+=1;distcount+=1;zeros+=row[5]==0 and row[2]>0
rows=[json.loads(l) for l in (O/'decisions.jsonl').read_text().splitlines()]
by=collections.defaultdict(list)
for r in rows:by[r['session']].append(r)
assert len(by)==40 and len(rows)==4688
changes=0;pending=0
for sid,rs in by.items():
 assert all(a['at']<b['at'] for a,b in zip(rs,rs[1:]))
 assert len({json.dumps(r['stable'],sort_keys=True) for r in rs})==1
 assert sum(r['reset'] for r in rs)==1
 for a,b in zip(rs,rs[1:]):
  if a['order']['order']!=b['order']['order']:
   changes+=1
   assert b['order']['tiers']!=a['order']['tiers'] or (a['order'].get('pending') and b['at']-a['order']['pending']['since']>=30000)
 pending+=sum(bool(r['order'].get('pending')) for r in rs)
summary=json.loads((O/'decision-summary.json').read_text());assert changes==summary['totals']['orderChanges']==48
outcome=json.loads((O/'outcome-audit.json').read_text());assert len(outcome['scores'])+sum(outcome['missing'].values())==len(rows)
assert sum(outcome['missingDestinationCauses'].values())==summary['totals']['journeyMissing']
pooling=json.loads((O/'pooling-audit.json').read_text());assert zeros==pooling['counts']['positiveEtaZeroHopRows']==101
aliases=[a for a in pooling['aliasTransitions'] if a['row'][5]==0 and a['row'][2]>0]
assert len(aliases)==6 and all(abs(a['roundedDifferenceSec'])<1 for a in aliases)
browser=json.loads((O/'browser-parity.json').read_text());assert browser['checks']==156 and not browser['errors']
meta=dict(inputHashes=len(plan['hashes']),frames=len(frames),wireRows=wirecount,orderedDistributions=distcount,sessions=len(by),decisions=len(rows),rankChanges=changes,allRankChangesRespectPersistence=True,positiveZeroHopRows=zeros,fullLapZeroHopAliasChecks=len(aliases),connectedRows=len(outcome['scores']),unmatchedRows=sum(outcome['missing'].values()),browserChecks=browser['checks'])
(O/'verification.json').write_text(json.dumps(meta,indent=2)+'\n');print(json.dumps(meta,indent=2))
