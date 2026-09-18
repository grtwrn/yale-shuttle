from pathlib import Path
from collections import Counter
import gzip, json, hashlib, math

O = Path(__file__).resolve().parent
B = O.parent / 'cycle-13'
read = lambda p: json.loads(p.read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
before = read(O/'builder-before-hashes.json')
assert all(sha(Path(p)) == digest for p, digest in before.items())
names = ['current-warm', 'current-cold', 'canonical-warm', 'canonical-cold']
data = {}
for name in names:
    p = O/'cache'/(name+'.json.gz')
    assert sha(p) == sha(B/'cache'/p.name), p
    data[name] = json.loads(gzip.decompress(p.read_bytes()))
assert data['canonical-warm'] == data['canonical-cold']

def wire_rows(frame):
    w = frame['wire']
    result = {}
    for row, quantiles in zip(w['rows'], w['distributions'], strict=True):
        bus = w['buses'][row[0]]
        # Route-qualified stable vehicle plus actual relative occurrence.
        key = (bus[0], bus[1], row[1], row[5])
        assert key not in result
        assert len(quantiles) == 50 and all(math.isfinite(v) for v in quantiles)
        result[key] = (row[1:], quantiles)
    return result

comparisons = []
for a,b in [('current-warm','current-cold'),('canonical-warm','canonical-cold'),('current-warm','canonical-warm')]:
    counts = Counter(); maxima = Counter(); occurrences = Counter(); negative = []
    for x,y in zip(data[a],data[b],strict=True):
        assert x['at'] == y['at'] and x['buses'] == y['buses']
        xx,yy = wire_rows(x),wire_rows(y)
        assert xx.keys() == yy.keys()
        for key,(r,q) in xx.items():
            s,t = yy[key]
            occ = sorted(k[3] for k in xx if k[:3] == key[:3]).index(key[3])
            assert occ in [0,1]
            occurrences[occ] += 1
            counts['rows'] += 1; counts['changedRows'] += r != s; counts['changedQuantiles'] += q != t
            for name,index in [('eta',1),('low',2),('high',3)]:
                delta = s[index] - r[index]
                maxima[name] = max(maxima[name], abs(delta))
                if delta: counts[name + ('Increase' if delta>0 else 'Decrease')] += 1
            maxima['quantile'] = max(maxima['quantile'],max(abs(v-u) for u,v in zip(q,t,strict=True)))
            if r[2] < 0: negative.append((x['at'],key,r[2])); assert r[2] == s[2]
        bx,by = dict(x['beliefs']),dict(y['beliefs'])
        assert bx.keys() == by.keys()
        for key, belief in bx.items():
            assert len(belief['p']) == len(by[key]['p'])
            assert abs(sum(belief['p'])-1) < 1e-10
    assert counts['rows'] == 10592 and dict(occurrences) == {0:6786,1:3806}
    assert len(negative) == 8
    comparisons.append(dict(a=a,b=b,counts=counts,maxima=maxima,occurrences=occurrences))
assert [c['counts']['changedRows'] for c in comparisons] == [1817,0,1373]
assert [c['counts']['changedQuantiles'] for c in comparisons] == [7044,0,4834]
same = []
for name in ['sanitized-receipts.jsonl','receipt-audit.json','case-evidence.json','coverage-gaps.json','verification.json']:
    assert sha(O/name) == sha(B/name),name
    same.append(name)
report = dict(builderFilesPreserved=len(before),byteIdenticalReplayOutputs=4,byteIdenticalReceiptOutputs=same,
    comparisons=comparisons,scope='Both occurrences, independent physical-key joins; no outcome accuracy assertion.')
(O/'independent-comparison.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
