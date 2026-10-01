"""Retrospective paired decisions; preserve unscorable changed identities."""
import collections, hashlib, json, math, statistics
from pathlib import Path
O=Path(__file__).resolve().parent;B=O.parent/'cycle-5/traversal-guard'
load=lambda p:json.loads(p.read_text())
cases=load(O/'missing-cases.json');case_by={(r['session'],r['at']):r for r in cases}
arms={a:{(r['session'],r['at']):r for r in map(json.loads,(O/f'{a}-decisions.jsonl').open())} for a in ['baseline','ordered','fallthrough']}
assert all(set(a)==set(arms['baseline']) for a in arms.values())
labels={(r['session'],r['at']):r for r in load(B/'outcome-audit.json')['scores']}
quant=lambda xs,q: sorted(xs)[min(len(xs)-1,math.ceil(q*len(xs))-1)] if xs else None
def metrics(rows,arm):
    errors=[r[arm]['errorSec'] for r in rows]; ae=[abs(e) for e in errors]
    full=[r for r in rows if r[arm]['journeyAvailable']]
    return dict(n=len(rows),sources=len({r['sourceId'] for r in rows}),mae=statistics.mean(ae) if ae else None,
        medianAbsError=statistics.median(ae) if ae else None,p90AbsError=quant(ae,.9),maxAbsError=max(ae,default=None),
        meanSignedError=statistics.mean(errors) if errors else None,journeyAvailable=len(full),
        earlyMiss=sum(r[arm]['earlyMiss'] for r in full),lateMiss=sum(r[arm]['lateMiss'] for r in full),
        meanWidthSec=statistics.mean(r[arm]['widthSec'] for r in full) if full else None)
pairs=[];fallthrough_unscorable=collections.Counter();fallthrough_changed=[]
for k,r in arms['baseline'].items():
    a=arms['ordered'][k]
    o0,o1=r['option'],a['option']
    if a['changed']:
        c=case_by[k];assert c['causal']['pickupRows'][0]['hops']==1 and not c['retrospective']['afterRecordedDeparture']
        assert o1['busName']==o0['busName'] and o1['walkToSec']==0
        assert o1['journeyArrival']['busName']==o0['busName']
        for field in ['busEtaSec','busLowSec','busHighSec','busDistribution','boardStopId','alightStopId','plannedRideSec','waitSec']:
            assert o1.get(field)==o0.get(field),field
        jt=next(t for t in a['trace'] if t['kind']=='journey')
        assert jt['board']['stopsAhead']==1 and jt['destination']['stopsAhead']==c['retrospective']['routeHops']+1
        assert k in labels and labels[k]['targetVisit']==c['retrospective']['targetVisit']
    if k in labels:
        label=labels[k]; truth=label['actualConnectedSec'];rec=dict(session=k[0],at=k[1],sourceId=label['sourceId'],targetVisit=label['targetVisit'],bus=label['bus'],actualConnectedSec=truth,changed=a['changed'])
        for arm in ['baseline','ordered']:
            o=arms[arm][k]['option'];j=o.get('journeyArrival'); rec[arm]=dict(totalSec=o['totalSec'],errorSec=o['totalSec']-truth,journeyAvailable=bool(j),
              widthSec=(j['highMs']-j['lowMs'])/1000 if j else None,earlyMiss=bool(j and truth<(j['lowMs']-k[1])/1000),lateMiss=bool(j and truth>(j['highMs']-k[1])/1000))
        rec['absErrorIncreaseSec']=abs(rec['ordered']['errorSec'])-abs(rec['baseline']['errorSec']);pairs.append(rec)
    ft=arms['fallthrough'][k]
    if ft['changed']:
        assert k in case_by
        t=next(t for t in ft['trace'] if t['kind']=='journey');board=t.get('board');c=case_by[k]
        if c['retrospective']['afterRecordedDeparture']:reason='current source already departed; no current boarding outcome'
        elif not board:reason='no modeled board'
        elif board['busName']!=c['bus']:reason='different bus; do not reuse focal outcome'
        elif board['stopsAhead']!=1:reason='different pickup occurrence; do not reuse current-source outcome'
        else:reason='same current approach, independently connected'
        fallthrough_unscorable[reason]+=1
        fallthrough_changed.append(dict(session=k[0],at=k[1],reason=reason,beforeBus=o0['busName'],afterBus=ft['option']['busName'],
            beforeTotalSec=o0['totalSec'],afterTotalSec=ft['option']['totalSec'],board=board))
changed=[r for r in pairs if r['changed']];assert len(changed)==30
assert len(pairs)==len(labels)==1400
assert all(r['baseline']==r['ordered'] for r in pairs if not r['changed'])
stability={}
for arm,values in arms.items():
    sessions=collections.defaultdict(list)
    for r in values.values():sessions[r['session']].append(r)
    jumps=[];churn=0
    for sid,rs in sessions.items():
        rs.sort(key=lambda r:r['at'])
        for a,b in zip(rs,rs[1:]):
            jump=(b['at']-a['at'])/1000+b['option']['totalSec']-a['option']['totalSec']
            if abs(jump)>60:jumps.append(dict(session=sid,at=b['at'],jumpSec=jump))
            churn+=a['order']['order'][0]!=b['order']['order'][0]
    stability[arm]=dict(absoluteArrivalJumpsOver60=len(jumps),up=sum(j['jumpSec']>0 for j in jumps),down=sum(j['jumpSec']<0 for j in jumps),
        maxMagnitudeSec=max(abs(j['jumpSec']) for j in jumps),topChoiceChurn=churn,jumps=jumps)
result=dict(pairedAll={a:metrics(pairs,a) for a in ['baseline','ordered']},pairedChanged={a:metrics(changed,a) for a in ['baseline','ordered']},
    bySource={str(s):{a:metrics([r for r in changed if r['sourceId']==s],a) for a in ['baseline','ordered']} for s in sorted({r['sourceId'] for r in changed})},
    largestRegressions=sorted(changed,key=lambda r:r['absErrorIncreaseSec'],reverse=True)[:5],fallthroughAttribution=dict(fallthrough_unscorable),
    stability=stability,limits='Exploratory shell arithmetic only. Errors are predicted minus observed destination arrival: negative means shuttle later than prediction. No baseline full distribution on restored rows, so changed-case width/tails are descriptive only, not paired coverage or proper-score improvements. Walking modeled; selected two-date history, not fresh holdout.')
(O/'paired-outcomes.json').write_text(json.dumps(pairs,indent=2)+'\n')
(O/'fallthrough-changes.json').write_text(json.dumps(fallthrough_changed,indent=2)+'\n')
(O/'counterfactual-scores.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({**{k:v for k,v in result.items() if k not in ['largestRegressions','bySource','stability']},'stability':{a:{k:v for k,v in s.items() if k!='jumps'} for a,s in stability.items()}},indent=2))
