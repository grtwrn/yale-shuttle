"""Fixed-forecast reconstruction cohorts only. No ETA error or candidate scoring."""
import bisect
import collections
import gzip
import json
from pathlib import Path
import sys

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'canonical-windows'))
import study

OUT=HERE/'results'
def read(path):
    with gzip.open(path,'rt') as f:return [json.loads(line) for line in f if line.strip()]
def write(name,rows):
    with gzip.open(OUT/(name+'.jsonl.gz'),'wt') as f:
        for r in rows:f.write(json.dumps(r,separators=(',',':'))+'\n')

study.configure()
base=read(OUT/'baseline-visits.jsonl.gz')
new=read(OUT/'protected-visits.jsonl.gz')
raw=read(study.ev.IN/'raw_positions.jsonl.gz')
quality=study.rr.TrainingQuality(raw)
old_out=study.Outcomes(base,quality);new_out=study.Outcomes(new,quality)
expected={study.key(r):r['label'] for r in read(study.OUT/'forecasts.jsonl.gz')}
rows=read(study.OUT/'unscored.jsonl.gz')
summary={};differences=[];all_labels=[]
def semantic(label):return None if label is None else {k:v for k,v in label.items() if k!='id'}
for r in rows:
    a,ar=old_out.label(r);b,br=new_out.label(r)
    assert a==expected.get(study.key(r)), 'Original canonical label changed'
    rid=r['route'];s=summary.setdefault(rid,dict(generated=0,baselineAccepted=0,protectedAccepted=0,
        baselineReasons=collections.Counter(),protectedReasons=collections.Counter(),transitions=collections.Counter(),
        statuses=collections.Counter(),newlyAcceptedEarlierPhysicalPickup=0))
    status='added' if a is None and b is not None else 'removed' if a is not None and b is None else (
        'relabelled' if a and b and semantic(a)!=semantic(b) else 'same_accepted' if a else 'same_excluded')
    # Keep earlier baseline physical passes visible; suppressing a marker is
    # not evidence that no boarding opportunity existed there.
    key=(r['bus'],rid,r['target']);old_physical=old_out.physical.get(key,[])
    pos=bisect.bisect_right(old_out.times.get(key,[]),r['at'])
    first=old_physical[pos] if pos<len(old_physical) else None
    earlier=bool(b and first and first['arrived_at']<b['arrival'])
    s['generated']+=1;s['baselineAccepted']+=a is not None;s['protectedAccepted']+=b is not None
    s['baselineReasons'][ar or 'accepted']+=1;s['protectedReasons'][br or 'accepted']+=1
    s['transitions'][str(ar or 'accepted')+' -> '+str(br or 'accepted')]+=1;s['statuses'][status]+=1
    s['newlyAcceptedEarlierPhysicalPickup']+=status=='added' and earlier
    row=dict(at=r['at'],bus=r['bus'],route=rid,target=r['target'],targetIndex=r['targetIndex'],
        loggedAnchorIndex=r['anchorIndex'],status=status,baseline=a,protected=b,
        baselineReason=ar,protectedReason=br,earlierBaselinePhysicalPickup=first if earlier else None)
    all_labels.append(row)
    if status in ('added','removed','relabelled') or ar!=br:differences.append(row)
write('label-comparison',all_labels);write('label-differences',differences)
report=dict(baselineLabelsIdentical=len(rows),qualityRuleMps=22,fixedForecasts=True,
    candidateScoresComputed=False,waitsAndCandidatesUnchanged=True,routes=summary,
    note='Reused development dates. Changes describe reconstruction sensitivity, not ETA improvement. Earlier physical passes remain explicit.')
(OUT/'cohort-summary.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='routes'}))
