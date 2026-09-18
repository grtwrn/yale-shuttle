import json
before=json.load(open('/tmp/wait-label-before-result.json'))
after=json.load(open('/tmp/wait-label-local-result.json'))
def seconds(r):
    m,s=map(int,r['text'].split('Waiting ')[1].split('\n')[0].split(':'))
    return m*60+s
old=[seconds(r) for r in before['results'] if 'width' not in r]
assert any(b<a for a,b in zip(old,old[1:])),old
new=[seconds(r) for r in after['results'] if 'width' not in r]
assert len(new)==25,len(new)
assert all(b>=a for a,b in zip(new,new[1:])),new
assert new[-1]>new[0],new
layouts=[r for r in after['results'] if 'width' in r]
assert len(layouts)==6,len(layouts)
for r in layouts:
    assert not r['collisions'],r
    box,bounds=r['rect'],r['map']
    assert box['left']>=bounds['left'] and box['right']<=bounds['right'],r
    assert box['top']>=bounds['top'] and box['bottom']<=bounds['bottom'],r
    assert r['text'].startswith('Pink · Waiting '),r
    assert len(r['text'].splitlines())==2,r
assert not after['errors'],after['errors']
print(json.dumps({'baselineBackwardSteps':[(a,b) for a,b in zip(old,old[1:]) if b<a], 'fixedClockSamples':new,'phoneLayoutsChecked':len(layouts),'collisions':0,'pageErrors':after['errors']}))
