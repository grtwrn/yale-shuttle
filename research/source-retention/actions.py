"""Fixed physical-visit action replay for all28 protected arms per policy."""
import collections
import json
import retention as study
import run_risk as source_risk
risk=source_risk.risk

def key(r):return tuple(r[k] for k in ('route','bus','target','visit','walkSec','responseSec','arm','policy'))
def point_signature(r):
    excluded={'arm','policy','earlyBelowLow','earlyBelowLowSec','armWidthSec','armForecast','renderedAtArm','earlyBeforeRendered','earlyBeforeRenderedSec'}
    result={k:v for k,v in r.items() if k not in excluded}
    for field in ('triggerForecast','deadlineForecast'):
        if field in result:result[field]={'eta':result[field]['eta']}
    return result

def cap_pairs(records):
    index={key(r):r for r in records};groups=collections.defaultdict(list)
    for k,r in index.items():
        if not r['arm'].endswith('_cap90'):continue
        arm=r['arm'].replace('_cap90','_cap45');a=index[(*k[:-2],arm,r['policy'])]
        groups[(r['route'],r['arm'],r['policy'],r['walkSec'],r['responseSec'])].append((a,r))
    out=[]
    for k,pairs in sorted(groups.items()):
        scored=[(a,b) for a,b in pairs if a['status'] in ('triggered','no-timely-reminder') and b['status'] in ('triggered','no-timely-reminder')]
        triggered=[(a,b) for a,b in scored if a['status']==b['status']=='triggered']
        out.append(dict(route=k[0],arm=k[1],policy=k[2],walkSec=k[3],responseSec=k[4],attempted=len(pairs),scored=len(scored),
            newlyMissed=sum(not a['hypotheticalMissedBoarding'] and b['hypotheticalMissedBoarding'] for a,b in scored),
            rescued=sum(a['hypotheticalMissedBoarding'] and not b['hypotheticalMissedBoarding'] for a,b in scored),
            cap45=risk.summary([a for a,b in pairs]),cap90=risk.summary([b for a,b in pairs]),
            pairedWaitDeltaSeconds=study.shared.distribution([b['waitAtStopSec']-a['waitAtStopSec'] for a,b in triggered]),
            pairedLeaveClockDeltaSeconds=study.shared.distribution([(b['leaveNowAt']-a['leaveNowAt'])/1000 for a,b in triggered])))
    return out

def main():
    clause=source_risk.hp.HighwayClause();audit={}
    for policy in study.POLICIES:
        audit[policy]={}
        for cohort in ('all','original-cohort'):
            directory=study.OUT/policy if cohort=='all' else study.OUT/policy/cohort
            olddir=study.IN/policy if cohort=='all' else study.IN/policy/cohort
            risk.Connectivity=source_risk.connectivity_factory(policy,clause,[])
            risk.run(directory,directory/'rider-risk')
            records=study.read(directory/'rider-risk/rider-risk-records.jsonl.gz')
            old={key(r):r for r in study.read(olddir/'rider-risk/rider-risk-records.jsonl.gz')};now={key(r):r for r in records}
            assert study.read(directory/'rider-risk/rider-risk-cohort.jsonl.gz')==study.read(olddir/'rider-risk/rider-risk-cohort.jsonl.gz')
            expected={( *k[:-2],a+f'_cap{cap}',k[-1]) for k in old for a in [k[-2]] if a!='deployed' for cap in study.CAPS}|{k for k in old if k[-2]=='deployed'}
            assert now.keys()==expected
            checks=collections.Counter()
            for k,r in now.items():
                base=now[(*k[:-2],'deployed',r['policy'])]
                if r['arm']=='deployed':assert r==old[k];checks['exactDeployedActions']+=1
                elif r['arm'].endswith('_cap45'):
                    normalized=dict(r,arm=r['arm'].replace('_cap45',''))
                    assert normalized==old[key(normalized)],'45min action record changed';checks['exact45ActionRecords']+=1
                if r['arm']!='deployed':
                    if r['policy']=='point':assert point_signature(r)==point_signature(base);checks['exactPointActions']+=1
                    else:
                        if base['status']=='triggered':
                            assert r['status']=='triggered' and r['leaveNowAt']<=base['leaveNowAt'];checks['noLaterLowerActions']+=1
                        if r['status'] in ('triggered','no-timely-reminder') and base['status'] in ('triggered','no-timely-reminder'):
                            assert not(r['hypotheticalMissedBoarding'] and not base['hypotheticalMissedBoarding'])
                    if r['route'] not in (9,10):assert dict(r,arm='deployed')==base;checks['otherRouteExactDeployed']+=1
            target=[r for r in records if r['route'] in (9,10)]
            original=json.loads((directory/'rider-risk/rider-risk-summary.json').read_text())
            audit[policy][cohort]=dict(controls=checks,cohort=original['cohort'],againstDeployed=study.shared.action_pairs(target),
                cap90Against45=cap_pairs(target),cells=[r for r in original['cells'] if r['route'] in (9,10)])
            del records,old,now,target
    expected=json.loads((study.OUT/'verification.json').read_text())['sourceHashes']
    assert expected=={str(p.relative_to(study.IN)):study.sha(p) for p in study.sources()}
    (study.OUT/'action-comparisons.json').write_text(json.dumps(audit,indent=2)+'\n')
    print(json.dumps({p:{c:r['controls'] for c,r in v.items()} for p,v in audit.items()}))

if __name__=='__main__':main()
