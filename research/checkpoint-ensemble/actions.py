"""Unchanged fixed physical-visit actions for interval and point-only diagnostics."""
import argparse
import collections
import json
import study as s
import run_risk as prior_risk
from report import distribution
risk=prior_risk.risk

def key(r):return tuple(r[k] for k in ('route','bus','target','visit','walkSec','responseSec','arm','policy'))
def pair_summary(records):
    index={key(r):r for r in records};groups=collections.defaultdict(list)
    for k,r in index.items():
        if r['arm']=='deployed':continue
        base=index[(*k[:-2],'deployed',k[-1])]
        groups[(r['route'],r['arm'],r['policy'],r['walkSec'],r['responseSec'])].append((base,r))
    result=[]
    for cell,pairs in sorted(groups.items()):
        scored=[(a,b) for a,b in pairs if a['status'] in ('triggered','no-timely-reminder') and b['status'] in ('triggered','no-timely-reminder')]
        triggered=[(a,b) for a,b in scored if a['status']==b['status']=='triggered']
        result.append(dict(route=cell[0],arm=cell[1],policy=cell[2],walkSec=cell[3],responseSec=cell[4],attempts=len(pairs),scoredPairs=len(scored),
            newlyMissed=sum(not a['hypotheticalMissedBoarding'] and b['hypotheticalMissedBoarding'] for a,b in scored),
            rescued=sum(a['hypotheticalMissedBoarding'] and not b['hypotheticalMissedBoarding'] for a,b in scored),
            deployed=risk.summary([a for a,b in pairs]),candidate=risk.summary([b for a,b in pairs]),
            waitDelta=distribution([b['waitAtStopSec']-a['waitAtStopSec'] for a,b in triggered]),
            leaveDelta=distribution([(b['leaveNowAt']-a['leaveNowAt'])/1000 for a,b in triggered])))
    # On matching estimator/gate populations isolate averaging from the same
    # single-K mechanism, retaining attempt/censor counts in both records.
    matched=[]
    for k,r in index.items():
        if '_ensemble' not in r['arm']:continue
        other=r['arm'].replace('_ensemble','_single');a=index[(*k[:-2],other,k[-1])]
        matched.append((a,r))
    grouped=collections.defaultdict(list)
    for a,b in matched:grouped[(b['route'],b['arm'],b['policy'],b['walkSec'],b['responseSec'])].append((a,b))
    comparisons=[]
    for cell,pairs in sorted(grouped.items()):
        scored=[(a,b) for a,b in pairs if a['status'] in ('triggered','no-timely-reminder') and b['status'] in ('triggered','no-timely-reminder')]
        triggered=[(a,b) for a,b in scored if a['status']==b['status']=='triggered']
        comparisons.append(dict(route=cell[0],arm=cell[1],policy=cell[2],walkSec=cell[3],responseSec=cell[4],attempts=len(pairs),scoredPairs=len(scored),
            newlyMissed=sum(not a['hypotheticalMissedBoarding'] and b['hypotheticalMissedBoarding'] for a,b in scored),rescued=sum(a['hypotheticalMissedBoarding'] and not b['hypotheticalMissedBoarding'] for a,b in scored),
            single=risk.summary([a for a,b in pairs]),ensemble=risk.summary([b for a,b in pairs]),waitDelta=distribution([b['waitAtStopSec']-a['waitAtStopSec'] for a,b in triggered])))
    original_groups=collections.defaultdict(list)
    for k,r in index.items():
        if '_ensemble' not in r['arm']:continue
        other='original_'+'_'.join(r['arm'].split('_')[:2]);a=index[(*k[:-2],other,k[-1])]
        original_groups[(r['route'],r['arm'],r['policy'],r['walkSec'],r['responseSec'])].append((a,r))
    originals=[]
    for cell,pairs in sorted(original_groups.items()):
        scored=[(a,b) for a,b in pairs if a['status'] in ('triggered','no-timely-reminder') and b['status'] in ('triggered','no-timely-reminder')]
        triggered=[(a,b) for a,b in scored if a['status']==b['status']=='triggered']
        originals.append(dict(route=cell[0],arm=cell[1],policy=cell[2],walkSec=cell[3],responseSec=cell[4],attempts=len(pairs),scoredPairs=len(scored),
            newlyMissed=sum(not a['hypotheticalMissedBoarding'] and b['hypotheticalMissedBoarding'] for a,b in scored),rescued=sum(a['hypotheticalMissedBoarding'] and not b['hypotheticalMissedBoarding'] for a,b in scored),
            originalSingle=risk.summary([a for a,b in pairs]),ensemble=risk.summary([b for a,b in pairs]),
            waitDelta=distribution([b['waitAtStopSec']-a['waitAtStopSec'] for a,b in triggered]),leaveDelta=distribution([(b['leaveNowAt']-a['leaveNowAt'])/1000 for a,b in triggered])))
    return dict(againstDeployed=result,againstMatchedSingle=comparisons,againstOriginalSingle=originals)

def main(policy):
    clause=prior_risk.hp.HighwayClause();result={}
    for cohort in ('all','original-cohort'):
        root=s.OUT/policy if cohort=='all' else s.OUT/policy/cohort
        reference=s.REFERENCE/policy if cohort=='all' else s.REFERENCE/policy/cohort
        old={key(r):r for r in s.stream(reference/'rider-risk/rider-risk-records.jsonl.gz') if r['arm']=='deployed'}
        for kind in ('interval','point-only'):
            directory=root if kind=='interval' else root/'point-only'
            risk.POLICIES=('point','lower','rendered_lower') if kind=='interval' else ('point',)
            risk.Connectivity=prior_risk.connectivity_factory(policy,clause,[])
            risk.run(directory,directory/'rider-risk')
            assert s.read(directory/'rider-risk/rider-risk-cohort.jsonl.gz')==s.read(reference/'rider-risk/rider-risk-cohort.jsonl.gz')
            records=s.read(directory/'rider-risk/rider-risk-records.jsonl.gz');checks=0
            for r in records:
                if r['arm']=='deployed':assert r==old[key(r)];checks+=1
            summary=json.loads((directory/'rider-risk/rider-risk-summary.json').read_text())
            result[cohort+'/'+kind]=dict(exactDeployedActions=checks,cohort=summary['cohort'],cells=summary['cells'],**pair_summary(records))
            del records
    (s.OUT/policy/'action-comparisons.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:dict(exactDeployedActions=v['exactDeployedActions'],cohort=v['cohort']) for k,v in result.items()}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--policy',required=True);main(p.parse_args().policy)
