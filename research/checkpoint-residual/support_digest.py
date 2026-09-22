"""Hosted descriptive reduction of immutable Stage A ledgers, without replay."""
import collections
import json
from pathlib import Path
from support import stream,sha

HERE=Path(__file__).resolve().parent
def reason(row):
    count=row['possibleJourneys']<12;dates=len(row['possibleSourceDates'])<3
    return 'both' if count and dates else 'journeys only' if count else 'dates only' if dates else 'not ruled out'
def main():
    directory=HERE/'results';summary=json.loads((directory/'support-summary.json').read_text())
    inputs=['query-ceilings.jsonl.gz','query-group-ceilings.jsonl.gz','all-fixed-stratum-ceilings.jsonl.gz','potential-residual-membership.jsonl.gz','folds.json','support-summary.json']
    hashes={p:sha(directory/p) for p in inputs}
    grouped=collections.defaultdict(lambda:dict(cells=0,reasons=collections.Counter(),possibleJourneyCounts=collections.Counter(),possibleSourceDateCounts=collections.Counter()))
    route_reasons=collections.defaultdict(collections.Counter)
    for r in stream(directory/'query-ceilings.jsonl.gz'):
        k=(r['route'],r['mode'],r['arm'],r['bankDate']);g=grouped[k];g['cells']+=1
        why=reason(r);g['reasons'][why]+=1;g['possibleJourneyCounts'][r['possibleJourneys']]+=1;g['possibleSourceDateCounts'][len(r['possibleSourceDates'])]+=1
        route_reasons[r['route']][why]+=1
        assert why!='not ruled out','Existing Stage A conclusion differs'
    potential=collections.defaultdict(lambda:dict(snapshots=0,forecastKeys=set(),sources=set(),journeys=set(),dates=collections.defaultdict(set),midnight=set()))
    for r in stream(directory/'potential-residual-membership.jsonl.gz'):
        g=potential[r['route']];g['snapshots']+=1;g['forecastKeys'].add((r['forecastAt'],r['targetIndex'],r['sourceId']))
        g['sources'].add(r['sourceId']);g['journeys'].add(r['journey']);g['dates'][r['sourceDate']].add(r['sourceId'])
        if r['sourceDate']!=r['forecastDate']:g['midnight'].add((r['sourceId'],r['sourceDate'],r['forecastDate']))
    possible=[r for r in stream(directory/'all-fixed-stratum-ceilings.jsonl.gz') if reason(r)=='not ruled out']
    folds=json.loads((directory/'folds.json').read_text());route_summary={}
    for rid,r in summary['routes'].items():
        rid=int(rid);g=potential[rid]
        first={}
        for day,f in sorted(folds['maps'].items()):
            for w in f['waits'][str(rid)]:first.setdefault(w,day)
        route_summary[rid]=dict(name=r['routeName'],allKeys=r['allSampledKeys'],evaluationKeys=r['evaluationKeys'],
                               calibrationKeys=r['calibrationKeys'],queryReasons=dict(route_reasons[rid]),
                               compatibleArmSnapshots=g['snapshots'],uniqueForecastSourceTargetKeys=len(g['forecastKeys']),
                               distinctFarthestSourceIds=len(g['sources']),possibleSourceFamilyIds=len(g['journeys']),
                               sourceDateDistinctSources={d:len(ids) for d,ids in sorted(g['dates'].items())},
                               midnightSourceTransitions=len(g['midnight']),midnightSourceDatePairs=sorted({(s,f) for _,s,f in g['midnight']}),
                               firstFoldQualifiedWaitDates=first,noQualifiedEvaluationWait=r['noQualifiedEvaluationWait'],
                               queryGroups=r['wholeQueryGroups'],queryArms=r['queryArms'])
    assert len(possible)==100
    assert hashes=={p:sha(directory/p) for p in inputs}
    report=dict(stage='A descriptive artifact reduction only',sourceRun=35754796957,inputHashesBeforeAndAfter=hashes,
                queryTargetCells=summary['queryCeilingCells'],queryGroups=summary['wholeQueryGroups'],allQueriedCellsNecessarilyUnavailable=True,
                hypotheticalNotRuledOutCells=possible,routes=route_summary,
                byModeArmBank=[dict(route=k[0],mode=k[1],arm=k[2],bankDate=k[3],**g) for k,g in sorted(grouped.items())],
                caveats=['No fitted means, target outcome admission, physical target labels, residual quantiles or interval/action scores.',
                         'Calibration and evaluation forecast date columns overlap; rolling may causally use prior evaluation dates after embargo.',
                         'Arm snapshots include identical primary/extended prewait projections; these copies never add support.',
                         'Possible source-family IDs are pre-outcome units; finalized distinct physical target/traversal counts remain unknown.',
                         'The100 hypothetical cells not ruled out are not reached by these evaluation strata; no future-date availability claim.'])
    (directory/'support-digest.json').write_text(json.dumps(report,indent=2)+'\n')
    lines=['# Residual calibration: necessary-support result','',
           'Every actual query cell is unavailable before fitting: 22,244 target cells across 1,484 whole-group queries. The minimum remains 12 effective journeys and three material dates; a raw necessary ceiling already fails.', '',
           '| Route | Evaluation keys | Journey count only | Date count only | Both | Distinct farthest sources, all compatible fold rows |',
           '|---|---:|---:|---:|---:|---:|']
    for rid,r in sorted(route_summary.items()):
        c=r['queryReasons'];lines.append(f"| {r['name']} | {r['evaluationKeys']} | {c.get('journeys only',0)} | {c.get('dates only',0)} | {c.get('both',0)} | {r['distinctFarthestSourceIds']} |")
    lines.extend(['','Reason columns count exact query target strata, not independent riders. Source counts pool dates/masks for context and are not usable calibration support. Blue Weekend and Grocery Ham have no qualified evaluation wait. All other fixed groups are ruled out.',
                  '',f"There are {len(possible)} hypothetical target cells that are not ruled out before further gates; none matches the actual evaluation bank/day-type/mask combination. This is not a claim that all future calibration is impossible.",
                  '',*report['caveats'],''])
    (directory/'DIGEST.md').write_text('\n'.join(lines))
    print(json.dumps(dict(queryTargetCells=report['queryTargetCells'],queryGroups=report['queryGroups'],hypotheticalNotRuledOut=len(possible),inputHashesUnchanged=True)))

if __name__=='__main__':main()
