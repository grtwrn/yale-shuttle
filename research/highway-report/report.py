"""Hosted descriptive supplement over the completed, immutable highway study.

No forecast generation, fitting, quality rules, labels, or action replay changes.
"""
import collections
import gzip
import json
from pathlib import Path
import statistics as st
import sys

HERE=Path(__file__).resolve().parent
IN=HERE/'input';OUT=HERE/'results'
sys.path.insert(0,str(HERE.parent/'useful-windows'))
import rolling as rr
import rider_risk as risk


def read(path):
    with gzip.open(path,'rt') as f:return [json.loads(line) for line in f]


def mean(values):return st.mean(values) if values else None


def distribution(values):
    values=sorted(values)
    if not values:return dict(n=0)
    def q(p):
        i=(len(values)-1)*p;a=int(i);b=min(a+1,len(values)-1)
        return values[a]+(values[b]-values[a])*(i-a)
    return dict(n=len(values),mean=mean(values),min=values[0],p25=q(.25),median=q(.5),p75=q(.75),p95=q(.95),max=values[-1])


def movements(rows,arm):
    out={}
    for field in ('eta','low','high'):
        grouped=collections.defaultdict(list)
        for r in rows:grouped[r['label']['id']].append(r['candidates'][arm][field]-r['deployed'][field])
        deltas=[v for values in grouped.values() for v in values]
        out[field]=dict(snapshotDeltas=distribution(deltas),visitMeanDeltas=distribution([mean(v) for v in grouped.values()]),
            movedLaterSnapshots=sum(v>0 for v in deltas),movedEarlierSnapshots=sum(v<0 for v in deltas),unchangedSnapshots=sum(v==0 for v in deltas))
    return out


def arm_metrics(rows,arms):
    return dict(deployed=rr.metrics(rows,'deployed'),arms={a:dict(metrics=rr.metrics(rows,a),movements=movements(rows,a)) for a in arms})


def cohort_metrics(rows):
    groups={'fullRoute':rows,
        'all14ChangedUnion':[r for r in rows if any(r['candidates'][a]!=r['deployed'] for a in rr.ARMS)],
        'frozen7ChangedUnion':[r for r in rows if any(r['candidates'][a]!=r['deployed'] for a in rr.ARMS if a.startswith('frozen'))],
        'rolling7ChangedUnion':[r for r in rows if any(r['candidates'][a]!=r['deployed'] for a in rr.ARMS if a.startswith('rolling'))]}
    return {name:dict(all=arm_metrics(rs,rr.ARMS),
        original=arm_metrics([r for r in rs if r['originalCohort']],rr.ARMS),
        additions=arm_metrics([r for r in rs if not r['originalCohort']],rr.ARMS)) for name,rs in groups.items()}


def action_pairs(records):
    indexed={(r['route'],r['bus'],r['target'],r['visit'],r['walkSec'],r['responseSec'],r['arm'],r['policy']):r for r in records}
    groups=collections.defaultdict(list)
    for key,candidate in indexed.items():
        if candidate['arm']=='deployed':continue
        # Same-policy deployed comparisons isolate model change; deployed point
        # comparisons retain the original action-study reference.
        for basepolicy in dict.fromkeys(('point',candidate['policy'])):
            baseline=indexed.get((*key[:-2],'deployed',basepolicy))
            if baseline:groups[(candidate['route'],candidate['arm'],candidate['policy'],basepolicy,candidate['walkSec'],candidate['responseSec'])].append((baseline,candidate))
    result=[]
    for key,pairs in sorted(groups.items()):
        scored=[(a,b) for a,b in pairs if a['status'] in ('triggered','no-timely-reminder') and b['status'] in ('triggered','no-timely-reminder')]
        triggered=[(a,b) for a,b in scored if a['status']==b['status']=='triggered']
        result.append(dict(route=key[0],arm=key[1],candidatePolicy=key[2],baselinePolicy=key[3],walkSec=key[4],responseSec=key[5],
            attempted=len(pairs),scored=len(scored),bothTriggered=len(triggered),
            newlyMissed=sum(not a['hypotheticalMissedBoarding'] and b['hypotheticalMissedBoarding'] for a,b in scored),
            rescued=sum(a['hypotheticalMissedBoarding'] and not b['hypotheticalMissedBoarding'] for a,b in scored),
            baselineMissed=sum(a['hypotheticalMissedBoarding'] for a,b in scored),candidateMissed=sum(b['hypotheticalMissedBoarding'] for a,b in scored),
            pairedWaitDeltaSeconds=distribution([b['waitAtStopSec']-a['waitAtStopSec'] for a,b in triggered]),
            pairedLeaveClockDeltaSeconds=distribution([(b['leaveNowAt']-a['leaveNowAt'])/1000 for a,b in triggered]),
            baseline=risk.summary([a for a,b in scored]),candidate=risk.summary([b for a,b in scored])))
    return result


def handoff_summary(record):
    return dict(record,clockJumpDistributions={field:dict(candidate=distribution([r['arrivalClockJump'][field] for r in record['records']]),
        deployed=distribution([r['deployedArrivalClockJump'][field] for r in record['records']])) for field in ('eta','low','high')})


def main():
    OUT.mkdir(exist_ok=True)
    old=json.loads((IN/'summary.json').read_text())
    verification=json.loads((IN/'verification.json').read_text())
    result=dict(sourceRun=35688081446,sourceCommit='a15928c15184e49c8ca01790f09b2b81a3e16343',
        planSha256=verification['controls']['planSha256'],note='Descriptive reporting only; all original forecasts/labels/actions unchanged. Reused dates, no promotion.',
        definitions=dict(union='Snapshots where at least one named arm differs from deployed, then every arm is evaluated on that identical union.',
            original='Previously labelled snapshots, not a disjoint set of physical visits.',additions='Newly labelled snapshots; can extend a previously labelled visit.',
            weighting='ETA metrics equal-weight physical visits, averaging snapshots within each visit. Endpoint distributions distinguish snapshot and visit weights.',
            waiting='Paired differences use only pairs where both reminders triggered; missed/no-timely cases are separately counted and have no finite waiting time.'),policies={})
    for policy in ('original22','highway25','highway50'):
        rows=read(IN/policy/'forecasts.jsonl.gz');routes={}
        for rid in ('9','10'):
            rs=[r for r in rows if str(r['route'])==rid]
            prior=old['policies'][policy][rid]
            assert rr.metrics(rs,'deployed')==prior['all']['frozen_K1']['all']['deployed']
            originalids={r['label']['id'] for r in rs if r['originalCohort']}
            addedids={r['label']['id'] for r in rs if not r['originalCohort']}
            routes[rid]=dict(name=prior['name'],generated=prior['generated'],labelled=len(rs),physicalVisits=len({r['label']['id'] for r in rs}),
                originalPhysicalVisits=len(originalids),addedSnapshotPhysicalVisits=len(addedids),entirelyNewPhysicalVisits=len(addedids-originalids),
                sharedCohorts=cohort_metrics(rs),individualChanged={a:dict(metrics=prior['all'][a]['changed'],movements=movements([r for r in rs if r['candidates'][a]!=r['deployed']],a)) for a in rr.ARMS},
                handoffs={a:handoff_summary(v) for a,v in prior['handoffs'].items()},generatedReasons=prior['generatedReasons'])
        action={}
        for cohort in ('all','original-cohort'):
            if policy=='original22' and cohort!='all':continue
            directory=IN/policy/('rider-risk' if cohort=='all' else 'original-cohort/rider-risk')
            records=[r for r in read(directory/'rider-risk-records.jsonl.gz') if r['route'] in (9,10)]
            original=json.loads((directory/'rider-risk-summary.json').read_text())
            pairs=action_pairs(records)
            expected={(r['route'],r['arm'],r['policy'],r['walkSec'],r['responseSec']):r for r in original['pairedAgainstDeployedPoint']}
            for r in pairs:
                if r['baselinePolicy']=='point':
                    e=expected[r['route'],r['arm'],r['candidatePolicy'],r['walkSec'],r['responseSec']]
                    assert (r['attempted'],r['scored'],r['newlyMissed'],r['rescued'])==(e['attemptedPairs'],e['scoredPairs'],e['newlyMissed'],e['rescued'])
            action[cohort]=dict(cohort=original['cohort'],comparisons=pairs,renderer=json.loads((directory/'rendered-parity.json').read_text()))
        result['policies'][policy]=dict(routes=routes,action=action)
    (OUT/'supplement.json').write_text(json.dumps(result,indent=2)+'\n')
    lines=['# Fixed highway study: shared-cohort supplement','',result['note'],'',
        'All 14 arms share each displayed denominator. Means weight physical visits equally. Full-route results include unchanged deployed fallbacks. The original/addition snapshot split can overlap physical visits.','']
    for policy in ('highway25','highway50'):
        for rid in ('9','10'):
            route=result['policies'][policy]['routes'][rid]
            lines += [f"## {policy}: {route['name']}",'',f"Generated {route['generated']} snapshots; labelled {route['labelled']} across {route['physicalVisits']} physical visits. Newly labelled physical visits: {route['entirelyNewPhysicalVisits']}.",'']
            for cohort in ('fullRoute','all14ChangedUnion'):
                for split in ('all','original','additions'):
                    record=route['sharedCohorts'][cohort][split];base=record['deployed']
                    lines += [f"### {cohort} / {split}",'',f"{base['snapshots']} snapshots / {base['visits']} physical visits.",'',
                        '| Arm | MAE s | Width s | Coverage | Early >60 s rate | New early >60 s visits | Source trips |', '|---|---:|---:|---:|---:|---:|---:|']
                    for arm,m in [('deployed',base)]+[(a,r['metrics']) for a,r in record['arms'].items()]:
                        if not m['visits']:continue
                        lines.append(f"| {arm} | {m['mae']:.1f} | {m['width']:.1f} | {m['coverage']:.1%} | {m['early60']:.1%} | {m['introducedSevereEarlyVisits']} | {m['sourceTrips']} |")
                    lines.append('')
    lines += ['## Read action results with their denominators','',
        'supplement.json retains all walks, responses, Ks, policies and cohorts. Same-policy deployed comparisons isolate the model change; comparisons against deployed point preserve the original action-study baseline. Paired waiting changes are conditional on both reminders triggering, with newly missed visits reported separately. No arm is selected by this report.']
    (OUT/'REPORT.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps(dict(sourceRun=35688081446,policies=list(result['policies']),descriptiveOnly=True)))


if __name__=='__main__':main()
