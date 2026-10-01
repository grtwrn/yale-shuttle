from pathlib import Path
import collections, hashlib, itertools, json

out=Path(__file__).resolve().parent
arms=['core','union','history']
identity=['at','bus','target','stopsAhead','occurrence','segmentId']
audit=collections.Counter();deltas=collections.defaultdict(list)
streams=[(out/(a+'.jsonl')).open() for a in arms]
def frames(stream):
    for at,rows in itertools.groupby((json.loads(s) for s in stream),key=lambda r:r['at']):
        by_identity={}
        for row in rows:
            key=tuple(row[k] for k in identity)
            assert key not in by_identity,'Duplicate forecast identity'
            by_identity[key]=row
        yield at,by_identity
def aligned_rows():
    for frame_group in itertools.zip_longest(*(frames(s) for s in streams)):
        assert all(frame_group),'Forecast frame availability changed'
        assert len({frame[0] for frame in frame_group})==1,'Forecast frame clocks changed'
        indexed=[frame[1] for frame in frame_group]
        assert all(set(group)==set(indexed[0]) for group in indexed),'Forecast occurrence availability changed'
        for key in sorted(indexed[0]):
            yield [group[key] for group in indexed]
with (out/'pairs.jsonl').open('w') as dest:
    # ETA changes may reorder buses in the presentation list. Pair physical
    # forecast identities within each poll, never zip their display ranks.
    for rows in aligned_rows():
        assert all(all(row[k]==rows[0][k] for k in identity) for row in rows)
        assert isinstance(rows[0]['occurrence'],int)
        result={k:v for k,v in rows[0].items() if k!='forecast'}
        for arm,row in zip(arms,rows):result[arm]=row['forecast']
        dest.write(json.dumps(result,separators=(',',':'))+'\n')
        audit['pairedRows']+=1
        for comparator in ['core','union']:
            changed=result['history']!=result[comparator]
            audit[f'changed_vs_{comparator}']+=changed
            if changed:
                key=f"{comparator}:{result['target']}:occurrence{result['occurrence']}"
                deltas[key].append({k:result['history'][k]-result[comparator][k] for k in ['eta','low','high']})
for s in streams:s.close()
hashes={a:hashlib.sha256((out/(a+'-tracking.jsonl')).read_bytes()).hexdigest() for a in arms}
assert len(set(hashes.values()))==1,'Full belief tracking differs'
result={'counts':dict(audit),'fullBeliefTrackingHashes':hashes,'changes':{
    k:{'rows':len(v),'maxAbsoluteDeltaSec':{field:max(abs(x[field]) for x in v) for field in ['eta','low','high']}}
    for k,v in deltas.items()}}
(out/'pair-validation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
