"""Prepare next clock audit from archived deployed-release full-arrival evidence.
Selection never reads cycle-1 model predictions or deltas. Does not re-score or
claim an exact refresh of current production. Original prior audit is reused.
"""
import collections
import datetime
import hashlib
import json
from pathlib import Path
import sqlite3
import statistics

ROOT=Path('/home/gwarren/projects/yale-shuttle-watcher')
OUT=Path(__file__).resolve().parent
SOURCE=ROOT/'release-integration-data/final-development-score.json'
META=ROOT/'release-integration-data/final-meta.json'
PRIOR=ROOT/'conditional-replay-data/rest-origin-review.json'
DB=ROOT/'conditional-replay-data/outcomes.db'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
plan=dict(createdAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),
    objective='Select bounded episode-clock trace cases independently of new neighbor candidates; prepare next round, no model change.',
    selection='Top five sources per regulator by mean absolute archived RELEASE-ON arrival error across saved warmed first-occurrence checkpoints and both target endpoints. Include every phase/checkpoint; no duration or model-disagreement filtering. Retain previously audited sources and reference their existing evidence instead of repeating experiments.',
    comparator='Archived final-development-score candidate field is the deployed Winchester release-ON arm (PR281 validation). It is not the old release-OFF baseline and not the new cycle-1 neighbor arm. Reuse for case selection only; a proposed change still needs current40af3c0 replay.',
    chronology='Previously inspected Sep16–17 through13:14 ET. No fresh holdout claim. Existing source/chain/warm exclusions remain visible in source counts.',
    clockContract='Saved since is the route tracker broad rest clock; pinnedAt is the stored physical pin. Their difference is not automatically error. First publication requires actual watcher receipt, never reconstructed raw-frame metadata.',
    next='Trace selected new cases through observed approach/rest/pin/movement/confirmation and connected endpoint leg IDs. Audit second occurrences separately; no time subtraction or tracker change without complete current-code replay.',
    inputs={str(p):sha(p) for p in (SOURCE,META,PRIOR,DB,Path(__file__))})
pp=OUT/'PLAN.json'
if not pp.exists():pp.write_text(json.dumps(plan,indent=2)+'\n')
else:
 old=json.loads(pp.read_text());assert all(old[k]==v for k,v in plan.items() if k!='createdAtUTC')
source=json.loads(SOURCE.read_text())
journeys=collections.defaultdict(list)
for j in source['journeys']:journeys[j['sourceId']].append(j)
rows=collections.defaultdict(list)
for r in source['checkpoints']:
    assert r['candidate'] is not None and r['warmMs']>=600000
    rows[r['sourceId']].append(r)
ranked=[]
for sid,rs in rows.items():
    error=[abs(r['candidate']['eta']-r['truthSec']) for r in rs]
    ranked.append(dict(sourceId=sid,sourceStop=rs[0]['sourceStop'],date=rs[0]['day'],bus=rs[0]['bus'],
        checkpointCount=len(rs),targets=sorted({r['target'] for r in rs}),meanAbsArrivalErrorSec=statistics.mean(error),
        maxAbsArrivalErrorSec=max(error)))
selected=[]
for stop in (11,121):selected.extend(sorted([r for r in ranked if r['sourceStop']==stop],key=lambda r:(-r['meanAbsArrivalErrorSec'],r['sourceId']))[:5])
prior=json.loads(PRIOR.read_text());known={r['visit']['id']:r for r in prior['visits']}
db=sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
for item in selected:
    sid=item['sourceId'];v=dict(db.execute('SELECT * FROM stop_visits WHERE id=?',(sid,)).fetchone())
    item['visit']={k:v[k] for k in ('id','bus_name','stop_id','anchored_at','pinned_at','departed_at','outcome','how','first_moved_at','last_at_rest_at','confirm_sec','shuffles','rest_polls')}
    item['journeys']=journeys[sid]
    item['alreadyAuditedClockOrigin']=sid in known
    item['priorAuditDecision']='reuse prior rest-origin-review; do not reclassify real pre-pin wait as error' if sid in known else None
    standing=[r for r in rows[sid] if r['phase']=='standing' and r['checkpointSec']==0]
    item['pinCheckpoints']=[dict(target=r['target'],at=r['at'],restSince=r['since'],rested=r['rested'],
        pinMinusRestOriginSec=(v['pinned_at']-r['since'])/1000 if r['since'] is not None else None,
        truth=r['truthSec'],releaseOn=r['candidate']) for r in standing]
    item['allCheckpoints']=[{k:r[k] for k in ('target','phase','checkpointSec','at','truthSec','since','rested','candidate')} for r in rows[sid]]
db.close()
report=dict(sourceCounts=source['counts'],selection=selected,allRankedSources=sorted(ranked,key=lambda r:-r['meanAbsArrivalErrorSec']),
    status='Selection/clock-summary only. No new raw or exact current-code continuous replay run. All existing outcomes retained.')
(OUT/'case-manifest.json').write_text(json.dumps(report,indent=2)+'\n')
for r in selected:print(json.dumps({k:r[k] for k in ('sourceId','sourceStop','date','bus','checkpointCount','meanAbsArrivalErrorSec','alreadyAuditedClockOrigin','pinCheckpoints')}))
