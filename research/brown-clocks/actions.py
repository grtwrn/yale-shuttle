"""Matched action risks, including all-eight common status support."""
import collections
import json
import statistics as st
from study import HERE, OUT, WINDOW, ARMS, LEADS, CELLS, read, module, split

risk = module('clock_rider_risk', HERE.parent / 'useful-windows/rider_risk.py')
KEYS = ('route', 'bus', 'target', 'visit', 'walkSec', 'responseSec', 'policy')
DECISIONS = ('status', 'reason', 'at', 'latestLeaveAt', 'leaveNowAt', 'forecastAt', 'reachStopAt',
             'hypotheticalMissedBoarding', 'lateToArrival', 'lateToArrivalSec', 'waitAtStopSec')


def key(r):
    return tuple(r[k] for k in KEYS)


def score_pairs(pairs):
    scored = [(a,b) for a,b in pairs if a['status'] in ('triggered', 'no-timely-reminder')
              and b['status'] in ('triggered', 'no-timely-reminder')]
    triggered = [(a,b) for a,b in scored if a['status'] == b['status'] == 'triggered']
    return dict(attempted=len(pairs), pairedScored=len(scored), bothTriggered=len(triggered),
        newlyMissed=sum(not a['hypotheticalMissedBoarding'] and b['hypotheticalMissedBoarding'] for a,b in scored),
        rescued=sum(a['hypotheticalMissedBoarding'] and not b['hypotheticalMissedBoarding'] for a,b in scored),
        laterReminders=sum(b['leaveNowAt'] > a['leaveNowAt'] for a,b in triggered),
        earlierReminders=sum(b['leaveNowAt'] < a['leaveNowAt'] for a,b in triggered),
        meanAddedWaitSec=risk.mean([b['waitAtStopSec']-a['waitAtStopSec'] for a,b in triggered]),
        maxAddedWaitSec=max((b['waitAtStopSec']-a['waitAtStopSec'] for a,b in triggered), default=None),
        referenceStatuses=dict(collections.Counter(a['status'] for a,b in pairs)),
        candidateStatuses=dict(collections.Counter(b['status'] for a,b in pairs)))


def main():
    records = read(OUT / 'rider-risk/rider-risk-records.jsonl.gz')
    indexed = {(r['arm'],key(r)):r for r in records}
    assert len(indexed) == len(records)
    old = [r for r in read(WINDOW / 'rider-risk/rider-risk-records.jsonl.gz')
           if r['route'] == 19 and r['arm'] in ('deployed', *LEADS)]
    for r in old:
        arm = r['arm'] if r['arm'] == 'deployed' else r['arm']+'_h45_f15'
        assert dict(indexed[arm,key(r)],arm=r['arm']) == r, 'Prior deployed/control action changed'
    point_checks=0
    for r in records:
        if r['arm']=='deployed' or r['policy']!='point':continue
        d=indexed['deployed',key(r)]
        assert {k:r.get(k) for k in DECISIONS} == {k:d.get(k) for k in DECISIONS}
        point_checks+=1
    base = [r for r in records if r['arm']=='deployed']
    groups = collections.defaultdict(list)
    for r in base:groups[r['policy'],r['walkSec'],r['responseSec']].append(r)
    summaries,contrasts=[],[]
    for (policy,walk,response), rows in sorted(groups.items()):
        common=[r for r in rows if all(indexed[a,key(r)]['status'] in ('triggered','no-timely-reminder') for a in ('deployed',*ARMS))]
        for arm in ARMS:
            summaries.append(dict(arm=arm,policy=policy,walkSec=walk,responseSec=response,
                pair=score_pairs([(d,indexed[arm,key(d)]) for d in rows]),
                allEightCommon=score_pairs([(d,indexed[arm,key(d)]) for d in common])))
        for lead in LEADS:
            for a,b in (('h45_f15','h90_f15'),('h45_f45','h90_f45'),('h45_f15','h45_f45'),('h90_f15','h90_f45')):
                aa,bb=lead+'_'+a,lead+'_'+b
                contrasts.append(dict(reference=aa,candidate=bb,policy=policy,walkSec=walk,responseSec=response,
                    sameAllEightCommon=score_pairs([(indexed[aa,key(d)],indexed[bb,key(d)]) for d in common])))
    result=dict(originalDeployedAndLeadActionIdentity=len(old),pointDecisionChecks=point_checks,
        pointDecisionMismatches=0,pairedSamePolicy=summaries,factorContrasts=contrasts,
        note='Same physical visits and deployed arming. Small common support and censoring; no actual rider-miss claim.')
    (OUT/'action-audit.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(dict(originalActionIdentity=len(old),pointDecisionChecks=point_checks)))


if __name__=='__main__':main()
