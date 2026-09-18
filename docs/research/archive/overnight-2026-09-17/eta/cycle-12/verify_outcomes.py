"""Independent ID/time/metric checks, without importing the outcome matcher."""
from pathlib import Path
import collections, hashlib, json, math, sqlite3, statistics, subprocess
O=Path(__file__).resolve().parent
P=O.parent
load=lambda p:json.loads(p.read_text())
rows=load(O/'alternative-outcomes.json');summary=load(O/'alternative-summary.json')
cases=[c for c in load(P/'cycle-6/missing-cases.json') if c['causal']['pickupRows'][0]['hops']==29]
assert {(c['session'],c['at']) for c in cases}=={(r['session'],r['at']) for r in rows}
assert len(rows)==38
dbpath=P.parents[1]/'conditional-replay-data/outcomes.db'
assert hashlib.sha256(dbpath.read_bytes()).hexdigest()==summary['databaseSHA256']
# Compare to an inherited independently reviewed database digest, not just this run.
prior=load(P/'cycle-2/trace-outcomes.json')
assert prior['databaseSHA256']==summary['databaseSHA256']
db=sqlite3.connect('file:'+str(dbpath)+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
visits={v['id']:dict(v) for v in db.execute('select * from stop_visits where route_id=3')}
legs={l['id']:dict(l) for l in db.execute('select * from legs where route_id=3')}
seq=json.loads(db.execute('select stops_json from routes where id=3').fetchone()[0]);N=len(seq)
db.close();uses=0
def verify_chain(start_id,end_id,leg_ids):
    global uses
    start=visits[start_id];end=visits[end_id];index=start['stop_index'];dep=start['departed_at'];total_hops=0
    for lid in leg_ids:
        l=legs[lid];uses+=1
        assert l['bus_name']==start['bus_name']==end['bus_name']
        assert l['from_index']==index and l['departed_at']==dep and l['reached']==1
        assert l['from_stop_id']==seq[index] and l['to_stop_id']==seq[l['to_index']]
        assert (l['to_index']-index)%N==l['hops'] and l['arrived_at']>dep
        candidates=[v for v in visits.values() if v['bus_name']==start['bus_name'] and v['stop_index']==l['to_index']
                    and v['arrived_at']==l['arrived_at'] and v['how']!='gap']
        assert len(candidates)==1
        v=candidates[0];index=v['stop_index'];dep=v['departed_at'];total_hops+=l['hops']
    assert v['id']==end['id']
    return total_hops

scored=[r for r in rows if 'errorSec' in r['alternative']]
for r in scored:
    a=r['alternative'];source=visits[a['sourceVisitId']];target=visits[a['targetVisitId']]
    assert source['departed_at']>=r['at'] and source['outcome'] in ['stopped','passed'] and source['how']!='gap'
    assert source['bus_name'].lstrip('#')==a['bus']!=r['focal']['bus']
    assert target['stop_id']==r['target']
    verify_chain(a['predecessorVisitId'],source['id'],a['predecessorLegIds'])
    hops=verify_chain(source['id'],target['id'],a['legIds'])
    assert hops==a['destinationHops']-a['boardHops']
    assert abs(a['errorSec']-(a['totalSec']-a['actualConnectedSec']))<1e-9
    assert abs(a['actualArrivalDifferenceFromFocalSec']-(a['actualConnectedSec']-r['focal']['actualConnectedSec']))<1e-9
    assert source['id']==min((v for v in visits.values() if v['bus_name']==source['bus_name'] and v['stop_id']==source['stop_id']
                       and v['anchored_at']>=visits[a['predecessorVisitId']]['anchored_at']
                       and (v['departed_at'] is None or v['departed_at']>=r['at'])),key=lambda v:(v['anchored_at'],v['id']))['id']
    second=next(x for x in r['occurrences'] if x['kind']=='destination-2')
    if second['visitId']:
        assert verify_chain(source['id'],second['visitId'],second['connectedLegIds'])==N+hops
        assert second['hops']==N+a['destinationHops']
ae=[abs(r['alternative']['errorSec']) for r in scored]
assert len(scored)==32 and len(rows)-len(scored)==6
assert math.isclose(statistics.mean(ae),summary['overall']['maeSec'])
assert sorted(ae)[math.ceil(.9*len(ae))-1]==summary['overall']['p90AbsSec']
before=[r for r in scored if r['focal']['availableByRecordedDeparture']]
assert len(before)==18 and all(r['alternative']['actualArrivalDifferenceFromFocalSec']>0 for r in before)
assert all(r['alternative']['actualConnectedSec']>r['directWalkSec'] for r in scored)
assert sum(r['focal']['availableByRecordedDeparture'] for r in rows)==24
assert len({r['sourceId'] for r in before})==3
occurrences={}
for kind in ['pickup-1','destination-1','pickup-2','destination-2']:
    xs=[x for r in rows for x in r['occurrences'] if x['kind']==kind]
    assert len(xs)==38
    pairs=[x for x in xs if x['forecastAvailable'] and x['actualSec'] is not None]
    errors=[x['predictedSec']-x['actualSec'] for x in pairs]
    occurrences[kind]=dict(total=38,forecasts=sum(x['forecastAvailable'] for x in xs),connectedOutcomes=sum(x['visitId'] is not None for x in xs),
        paired=len(pairs),maeSec=statistics.mean(abs(e) for e in errors) if errors else None)
# Preserve earlier evidence exactly; no replacement outcome or exclusions.
for name,want in load(O/'PLAN.json')['inputHashes'].items():assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==want
old=load(P/'cycle-6/paired-outcomes.json');assert len(old)==1400
assert max(r['absErrorIncreaseSec'] for r in old)==442.82701916224846
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17')
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()==load(O/'PLAN.json')['head']
assert subprocess.check_output(['git','status','--porcelain'],cwd=repo,text=True)==''
report=dict(preservedCases=38,exactHistoricalLegUses=uses,scored=32,unknown=6,originalOutcomesPreserved=1400,
    priorRegressionSec=442.82701916224846,occurrences=occurrences,
    beforeFocalDeparture=dict(decisions=18,sourceVisits=3,meanDelaySec=statistics.mean(r['alternative']['actualArrivalDifferenceFromFocalSec'] for r in before),
       minDelaySec=min(r['alternative']['actualArrivalDifferenceFromFocalSec'] for r in before),
       maxDelaySec=max(r['alternative']['actualArrivalDifferenceFromFocalSec'] for r in before)),
    checkoutClean=True)
(O/'verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
