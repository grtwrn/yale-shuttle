"""Frozen bounded experiment, reusing completed extraction and baselines."""
import collections
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time
import numpy as np
from role_state import History,load_events,features

OUT=Path(__file__).resolve().parent
OLD=OUT.parent/'cycle-1'
ROOT=Path('/home/gwarren/projects/yale-shuttle-watcher')
spec=importlib.util.spec_from_file_location('audited_landmarks',OLD/'fit_landmarks.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
ARMS=('landmark_lap_elapsed_clock','plus_two_history_phase','plus_recursive_role')
CONTRACTS=('confirmed120','confirmed240')

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()

def extract():
    plan=json.loads((OUT/'PLAN.json').read_text())
    for p,h in {**plan['inputs'],**plan['currentComparatorHashes']}.items():assert sha(Path(p))==h,p
    records=[json.loads(l) for l in (OLD/'landmarks.jsonl').read_text().splitlines() if json.loads(l)['regime']=='arrival15']
    primary_deps,primary_anchors=load_events(ROOT/'conditional-replay-data/outcomes.db')
    thresholds,pairs=History(primary_deps,primary_anchors).thresholds()
    out=[];audit=[];checks=0
    for contract,delay in zip(CONTRACTS,(0,120000)):
        deps=[dict(e,known=e['known']+delay) for e in primary_deps]
        h=History(deps,primary_anchors);cache={}
        for r in records:
            if r['id'] not in cache:
                s=h.snapshot(r,thresholds);cache[r['id']]=s
                # Remove all primitive events unknown at pin; state must agree.
                at=r['pinAt']
                censored=History([e for e in deps if e['known']<=at],[e for e in primary_anchors if e['known']<=at])
                assert censored.snapshot(r,thresholds)==s
                assert r['id'] not in s['ids'] and all(t<=at for t in s['knownTimes'])
                checks+=1
            out.append(dict(r,regime=contract,role=cache[r['id']]))
        for stop in (11,121):
            for split in ('train','calibration','development'):
                rs=[r for r in out if r['regime']==contract and r['stop']==stop and r['split']==split and r['elapsed']==0]
                audit.append(dict(stop=stop,contract=contract,split=split,visits=len(rs),reasons=dict(collections.Counter(r['role']['reason'] for r in rs)),historyCounts=dict(collections.Counter(r['role']['count'] for r in rs)),supportedThreePlus=sum(r['role']['supported'] and r['role']['count']>=3 for r in rs)))
    (OUT/'role-landmarks.jsonl').write_text(''.join(json.dumps(r,separators=(',',':'))+'\n' for r in out))
    (OUT/'extraction.json').write_text(json.dumps(dict(thresholdsSec=thresholds,trainingThresholdPairs=pairs,temporalChecks=checks,groups=audit,rows=len(out)),indent=2)+'\n')
    print(json.dumps(dict(thresholds=thresholds,temporalChecks=checks,rows=len(out),groups=audit),indent=2))

def core(r,t):return base.design(r,t)[0]

def fit():
    start=time.monotonic()
    records=[json.loads(l) for l in (OUT/'role-landmarks.jsonl').read_text().splitlines()]
    saved=json.loads((OLD/'fits.json').read_text())['fits']
    old_preds={(r['id'],r['elapsed']):r for r in (json.loads(l) for l in (OLD/'predictions.jsonl').read_text().splitlines()) if r['regime']=='arrival15' and r['arm']==ARMS[0]}
    fits=[];predictions=[];parity=0;fallback=0
    for stop in (11,121):
        coeff=np.array(next(f['coefficients'] for f in saved if f['stop']==stop and f['regime']=='arrival15' and f['arm']==ARMS[0]))
        for contract in CONTRACTS:
            train=[r for r in records if r['stop']==stop and r['regime']==contract and r['split']=='train']
            test=[r for r in records if r['stop']==stop and r['regime']==contract and r['split']=='development']
            X=[];ys=[];ws=[];added={'two':[],'recursive':[]}
            for r in train:
                bins=max(1,int(np.ceil(min(1800,r['truthRemaining'])/15)))
                t=(np.arange(bins)+.5)*15;y=np.zeros(bins)
                if r['truthRemaining']<=1800:y[-1]=1
                X.append(core(r,t));ys.append(y);ws.append(np.full(bins,r['landmarkWeight']))
                for name in added:added[name].append(features(r,t,name))
            X=np.vstack(X);y=np.concatenate(ys);w=np.concatenate(ws)
            models={}
            for name in added:
                supported=[r for r in train if r['role']['supported']]
                assert len({r['id'] for r in supported})>=5 and len({r['day'] for r in supported})>=2
                b,diagnostic=base.fit(np.vstack(added[name]),y,w,X@coeff,np.full(3,10))
                models[name]=b
                fits.append(dict(stop=stop,contract=contract,history=name,coefficients=b.tolist(),coreCoefficients=coeff.tolist(),diagnostic=diagnostic,trainVisits=len({r['id'] for r in train}),supportedVisits=len({r['id'] for r in supported}),riskRows=len(y)))
            for r in test:
                t=(np.arange(120)+.5)*15;offset=core(r,t)@coeff
                bq=base.quantiles(offset)
                assert bq==old_preds[r['id'],r['elapsed']]['q'];parity+=1
                for arm,name in zip(ARMS,(None,'two','recursive')):
                    q=bq if name is None else base.quantiles(offset+features(r,t,name)@models[name])
                    if not r['role']['supported']:
                        assert q==bq;fallback+=1
                    predictions.append(dict(id=r['id'],stop=stop,bus=r['bus'],day=r['day'],regime=contract,arm=arm,elapsed=r['elapsed'],forecastAt=r['forecastAt'],truthRemaining=r['truthRemaining'],q=q,landmarkWeight=r['landmarkWeight'],lapSupported=r['lapSupported'],roleSupported=r['role']['supported'],historyCount=r['role']['count'],roleReason=r['role']['reason'],sameAsAhead=r['identities']['sameAsAhead']))
    (OUT/'fits.json').write_text(json.dumps(dict(fits=fits,seconds=time.monotonic()-start,coreParityChecks=parity,exactFallbackChecks=fallback,scriptSha256=sha(Path(__file__)),stateScriptSha256=sha(OUT/'role_state.py'),planSha256=sha(OUT/'PLAN.json')),indent=2)+'\n')
    (OUT/'predictions.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in predictions))
    print(json.dumps(dict(seconds=time.monotonic()-start,fits=len(fits),predictions=len(predictions),coreParity=parity,fallback=fallback)))

if __name__=='__main__':
    {'extract':extract,'fit':fit}[sys.argv[1]]()
