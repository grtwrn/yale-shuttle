"""Unchanged action replay, exact deployed decisions, protected-point controls."""
import collections
import json
from pathlib import Path
import sys
import study

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'highway-windows'))
import run_risk as source_risk
risk=source_risk.risk
IN,OUT=study.IN,study.OUT


def key(r):
    return tuple(r[k] for k in ('route','bus','target','visit','walkSec','responseSec','arm','policy'))


def point_signature(r):
    # Windows are deliberately changed, so window diagnostic fields are not
    # point-action controls. Status, decision/boarding clocks, misses, waiting,
    # censor reasons, arming and causal source fields must remain exact.
    excluded={'arm','policy','earlyBelowLow','earlyBelowLowSec','armWidthSec','armForecast','renderedAtArm','earlyBeforeRendered','earlyBeforeRenderedSec'}
    result={k:v for k,v in r.items() if k not in excluded}
    for field in ('triggerForecast','deadlineForecast'):
        if field in result:result[field]={'eta':result[field]['eta']}
    return result


def compare_raw(records,source):
    original={key(r):r for r in source};groups=collections.defaultdict(list)
    for r in records:
        if r['route'] not in (9,10) or r['arm']=='deployed':continue
        a=original[key(r)];groups[(r['route'],r['arm'],r['policy'],r['walkSec'],r['responseSec'])].append((a,r))
    out=[]
    for k,pairs in sorted(groups.items()):
        scored=[(a,b) for a,b in pairs if a['status'] in ('triggered','no-timely-reminder') and b['status'] in ('triggered','no-timely-reminder')]
        triggered=[(a,b) for a,b in scored if a['status']==b['status']=='triggered']
        out.append(dict(route=k[0],arm=k[1],policy=k[2],walkSec=k[3],responseSec=k[4],attempted=len(pairs),scored=len(scored),
            newlyMissed=sum(not a['hypotheticalMissedBoarding'] and b['hypotheticalMissedBoarding'] for a,b in scored),
            rescued=sum(a['hypotheticalMissedBoarding'] and not b['hypotheticalMissedBoarding'] for a,b in scored),
            raw=risk.summary([a for a,b in scored]),protected=risk.summary([b for a,b in scored]),
            pairedWaitDeltaSeconds=study.shared.distribution([b['waitAtStopSec']-a['waitAtStopSec'] for a,b in triggered])))
    return out


def main():
    clause=source_risk.hp.HighwayClause();audit={}
    for policy in study.POLICIES:
        audit[policy]={}
        for cohort in ('all','original-cohort'):
            directory=OUT/policy if cohort=='all' else OUT/policy/cohort
            original_dir=IN/policy if cohort=='all' else IN/policy/cohort
            instances=[];risk.Connectivity=source_risk.connectivity_factory(policy,clause,instances)
            risk.run(directory,directory/'rider-risk')
            records=study.ev.read(directory/'rider-risk/rider-risk-records.jsonl.gz')
            source=study.ev.read(original_dir/'rider-risk/rider-risk-records.jsonl.gz')
            now={key(r):r for r in records};old={key(r):r for r in source}
            assert now.keys()==old.keys(), 'action arming or record availability changed'
            assert study.ev.read(directory/'rider-risk/rider-risk-cohort.jsonl.gz')==study.ev.read(original_dir/'rider-risk/rider-risk-cohort.jsonl.gz')
            checks=collections.Counter()
            for k,r in now.items():
                baseline=now[(*k[:-2],'deployed',r['policy'])]
                if r['arm']=='deployed':
                    assert r==old[k], 'deployed action record changed';checks['exactDeployedRecords']+=1
                elif r['policy']=='point':
                    assert point_signature(r)==point_signature(baseline), 'protected point decision changed';checks['exactPointDecisions']+=1
                else:
                    if baseline['status']=='triggered':
                        assert r['status']=='triggered' and r['leaveNowAt']<=baseline['leaveNowAt'], 'lower action became later or censored'
                        checks['noLaterLowerDecisions']+=1
                    if r['status'] in ('triggered','no-timely-reminder') and baseline['status'] in ('triggered','no-timely-reminder'):
                        assert not (r['hypotheticalMissedBoarding'] and not baseline['hypotheticalMissedBoarding'])
                if r['route'] not in (9,10) and r['arm']!='deployed':
                    normalized=dict(r,arm='deployed');assert normalized==baseline
                    checks['otherRouteExactDeployedActions']+=1
            target=[r for r in records if r['route'] in (9,10)]
            audit[policy][cohort]=dict(controls=checks,actionSummary=json.loads((directory/'rider-risk/rider-risk-summary.json').read_text())['cohort'],
                againstDeployed=study.shared.action_pairs(target),againstRaw=compare_raw(target,source))
            del records,source,now,old
    verification=json.loads((OUT/'verification.json').read_text())
    assert verification['sourceFileHashes']=={str(p.relative_to(IN)):study.sha(p) for p in study.files()}
    (OUT/'action-comparisons.json').write_text(json.dumps(audit,indent=2)+'\n')
    print(json.dumps({p:{c:r['controls'] for c,r in v.items()} for p,v in audit.items()}))


if __name__=='__main__':main()
