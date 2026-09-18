"""Check saved fitting likelihood/support against training only; do not refit."""
import collections
import json
import math
from pathlib import Path
import numpy as np
from scipy.special import expit

P=Path(__file__).resolve().parent.parent/'cycle-1'
rows=[json.loads(s) for s in (P/'landmarks.jsonl').read_text().splitlines()]
saved=json.loads((P/'fits.json').read_text())['fits']
fits={(f['stop'],f['regime'],f['arm']):f for f in saved}
results=[]

def matrix(r,n):
    t=np.arange(n,dtype=float)*15+7.5+r['elapsed']
    theta=(r['pinAt']/1000 % 900+t)*2*math.pi/900
    sin,cos=np.sin(theta),np.cos(theta)
    lap=(r['lap']-r['referenceLap'])/600 if r['lapSupported'] else 0
    core=np.stack([np.ones(n),np.log1p(t/60),t/600,np.maximum(t-300,0)/600,
        np.maximum(t-600,0)/600,np.full(n,lap),np.full(n,float(not r['lapSupported'])),
        sin,cos,np.full(n,r['elapsed']/600)],axis=1)
    ps=[]
    for side in ('ahead','follower'):
        vector=np.array(r['snapshots'][side]['features'])
        if not r['lapSupported']:vector=np.zeros_like(vector)
        ps += [np.outer(np.ones(n),vector),np.outer(sin,vector),np.outer(cos,vector)]
    return core,np.concatenate(ps,axis=1)

for stop in (11,121):
    for regime in ('arrival15','completed120'):
        train=[r for r in rows if r['stop']==stop and r['regime']==regime and r['split']=='train']
        assert all(r['outcomeReady']<1789012800000 for r in train)
        core,peer,labels,weight=[],[],[],[]
        supported=collections.defaultdict(lambda:{'visits':set(),'dates':set()})
        censored=0
        for r in train:
            n=max(1,math.ceil(min(1800,r['truthRemaining'])/15))
            x,p=matrix(r,n)
            y=np.zeros(n)
            if r['truthRemaining']<=1800:y[-1]=1
            else:censored+=1
            core.append(x);peer.append(p);labels.append(y);weight.append(np.full(n,r['landmarkWeight']))
            for column in np.flatnonzero(np.any(np.abs(p)>1e-10,axis=0)):
                supported[int(column)]['visits'].add(r['id']);supported[int(column)]['dates'].add(r['day'])
        X=np.concatenate(core);Pmat=np.concatenate(peer);y=np.concatenate(labels);w=np.concatenate(weight)
        eligible=sorted(c for c,hits in supported.items() if len(hits['visits'])>=5 and len(hits['dates'])>=2)
        corefit=fits[stop,regime,'landmark_lap_elapsed_clock']
        corecoef=np.array(corefit['coefficients'])
        for arm in ('landmark_lap_elapsed_clock','plus_ahead_snapshot','plus_ahead_follower_snapshot'):
            fit=fits[stop,regime,arm]
            if arm=='landmark_lap_elapsed_clock':
                design=X;coef=corecoef;offset=np.zeros(len(y));penalty=np.r_[0,np.full(X.shape[1]-1,10)]
            else:
                maxcol=Pmat.shape[1]//2 if arm=='plus_ahead_snapshot' else Pmat.shape[1]
                selected=[]
                for col in eligible:
                    if col<maxcol and not any(np.array_equal(Pmat[:,col],Pmat[:,prior]) for prior in selected):selected.append(col)
                assert selected==fit['columns']
                assert fit['trainVisits']==len({r['id'] for r in train}) and fit['riskRows']==len(y)
                design=Pmat[:,selected];coef=np.array(fit['coefficients']);offset=X@corecoef;penalty=np.full(len(coef),10)
            z=offset+design@coef
            objective=float(w@(np.logaddexp(0,z)-y*z)+.5*np.sum(penalty*coef*coef))
            gradient=design.T@(w*(expit(z)-y))+penalty*coef
            assert abs(objective-fit['diagnostic']['objective'])<1e-7
            assert max(abs(gradient))<.001
            results.append(dict(stop=stop,regime=regime,arm=arm,riskRows=len(y),rightCensoredLandmarks=censored,
                                maxGradient=float(max(abs(gradient))),objective=objective))
out=Path(__file__).resolve().parent/'fit-contract-check.json'
out.write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(dict(modelsChecked=len(results),maxGradient=max(r['maxGradient'] for r in results),
                     allTrainingOnlySupportAndObjectivesMatch=True,rightCensoredLandmarks=sum(r['rightCensoredLandmarks'] for r in results if r['arm']=='landmark_lap_elapsed_clock')),indent=2))
