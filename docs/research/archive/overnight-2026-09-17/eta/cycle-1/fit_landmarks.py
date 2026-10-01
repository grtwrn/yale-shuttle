"""Frozen-snapshot remaining-wait experiment; artifact-only, no runtime changes."""
import collections
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import time
import numpy as np
from scipy.optimize import minimize
from scipy.special import expit

OUT=Path(__file__).resolve().parent
ARMS=('landmark_lap_elapsed_clock','plus_ahead_snapshot','plus_ahead_follower_snapshot')
STEP=15
PENALTY=10


def design(r, residual_time):
    t=np.asarray(residual_time)+r['elapsed']
    phase=2*np.pi*((r['pinAt']/1000)%900+t)/900
    sin,cos=np.sin(phase),np.cos(phase)
    lap=(r['lap']-r['referenceLap'])/600 if r['lapSupported'] else 0
    core=np.column_stack([np.ones_like(t),np.log1p(t/60),t/600,np.maximum(t-300,0)/600,
        np.maximum(t-600,0)/600,np.full_like(t,lap),np.full_like(t,float(not r['lapSupported'])),
        sin,cos,np.full_like(t,r['elapsed']/600)])
    peer=[]
    for name in ('ahead','follower'):
        snapshot=np.array(r['snapshots'][name]['features'])
        if not r['lapSupported']:
            snapshot=np.zeros_like(snapshot)
        frozen=np.broadcast_to(snapshot,(len(t),len(snapshot)))
        peer.append(np.column_stack([frozen,frozen*sin[:,None],frozen*cos[:,None]]))
    return core,np.column_stack(peer)


def fit(X,y,w,offset,penalty):
    def obj(b):
        z=offset+X@b
        loss=np.dot(w,np.logaddexp(0,z)-y*z)+.5*np.dot(penalty,b*b)
        gradient=X.T@(w*(expit(z)-y))+penalty*b
        return float(loss),gradient
    initial=np.zeros(X.shape[1])
    if penalty[0]==0:
        p=np.dot(w,y)/sum(w)
        initial[0]=math.log(p/(1-p))
    result=minimize(obj,initial,jac=True,method='L-BFGS-B',options={'maxiter':1500,'gtol':1e-8,'ftol':1e-12})
    assert result.success,result.message
    return result.x,dict(iterations=result.nit,objective=float(result.fun),maxGradient=float(max(abs(result.jac))))


def quantiles(logits):
    # Piecewise constant hazard within each15s bin; continue final hazard.
    # Work in log-survival, never round CDF to1 or cap quantiles at1800.
    logS=np.r_[0,-np.cumsum(np.logaddexp(0,logits))]
    hazard=min(1/5,max(1/1800,(logS[-2]-logS[-1])/STEP))
    out=[]
    for p in (.1,.5,.9):
        goal=math.log1p(-p)
        i=int(np.searchsorted(-logS,-goal))
        if i>=len(logS):
            value=1800+(logS[-1]-goal)/hazard
        else:
            value=(i-1)*STEP+STEP*(goal-logS[i-1])/(logS[i]-logS[i-1])
        out.append(float(value))
    assert 0<=out[0]<=out[1]<=out[2] and all(math.isfinite(v) for v in out)
    return out


def metrics(rs,weighted=False):
    w=np.array([r['landmarkWeight'] if weighted else 1 for r in rs]);w=w/w.sum()
    err=np.array([r['q'][1]-r['truthRemaining'] for r in rs]);ae=abs(err)
    width=np.array([r['q'][2]-r['q'][0] for r in rs])
    early=np.array([r['truthRemaining']<r['q'][0] for r in rs])
    late=np.array([r['truthRemaining']>r['q'][2] for r in rs])
    wis=np.array([(.5*abs(r['q'][1]-r['truthRemaining'])+.1*(r['q'][2]-r['q'][0])+max(0,r['q'][0]-r['truthRemaining'])+max(0,r['truthRemaining']-r['q'][2]))/1.5 for r in rs])
    # Weighted quantiles are deliberately identified, no interpolation hidden.
    order=np.argsort(ae);cum=np.cumsum(w[order]);aq=lambda p:float(ae[order[min(len(order)-1,int(np.searchsorted(cum,p)))]] )
    return dict(visits=len({r['id'] for r in rs}),landmarks=len(rs),dates=len({r['day'] for r in rs}),
        mae=float(w@ae),medianAbs=aq(.5),p90Abs=aq(.9),wis80=float(w@wis),width80=float(w@width),
        earlyCount=int(sum(early)),lateCount=int(sum(late)),earlyRate=float(w@early),lateRate=float(w@late))


def main():
    start=time.monotonic()
    records=[json.loads(line) for line in (OUT/'landmarks.jsonl').read_text().splitlines()]
    plan=json.loads((OUT/'PLAN.json').read_text())
    assert plan['arms']==list(ARMS) and plan['penaltyL2']==PENALTY
    fits=[];predictions=[]
    for stop in (11,121):
        for regime in ('arrival15','completed120'):
            train=[r for r in records if r['stop']==stop and r['regime']==regime and r['split']=='train']
            development=[r for r in records if r['stop']==stop and r['regime']==regime and r['split']=='development']
            cores=[];peers=[];ys=[];ws=[]
            for r in train:
                bins=max(1,math.ceil(min(1800,r['truthRemaining'])/STEP))
                core,peer=design(r,(np.arange(bins)+.5)*STEP)
                y=np.zeros(bins)
                if r['truthRemaining']<=1800:y[-1]=1
                cores.append(core);peers.append(peer);ys.append(y);ws.append(np.full(bins,r['landmarkWeight']))
            X=np.vstack(cores);P=np.vstack(peers);y=np.concatenate(ys);w=np.concatenate(ws)
            core_coeff,diagnostic=fit(X,y,w,np.zeros(len(y)),np.r_[0,np.full(X.shape[1]-1,PENALTY)])
            eligible=[]
            for col in range(P.shape[1]):
                hits=[r for r,m in zip(train,peers) if np.any(abs(m[:,col])>1e-10)]
                if len({r['id'] for r in hits})>=5 and len({r['day'] for r in hits})>=2:
                    eligible.append(col)
            models={ARMS[0]:([],np.zeros(0))}
            fits.append(dict(stop=stop,regime=regime,arm=ARMS[0],coefficients=core_coeff.tolist(),diagnostic=diagnostic))
            half=P.shape[1]//2
            for arm,maxcol in ((ARMS[1],half),(ARMS[2],P.shape[1])):
                cols=[]
                for col in eligible:
                    if col<maxcol and not any(np.array_equal(P[:,col],P[:,prior]) for prior in cols):cols.append(col)
                coeff,diagnostic=fit(P[:,cols],y,w,X@core_coeff,np.full(len(cols),PENALTY))
                models[arm]=(cols,coeff)
                fits.append(dict(stop=stop,regime=regime,arm=arm,columns=cols,coefficients=coeff.tolist(),diagnostic=diagnostic,
                    trainVisits=len({r['id'] for r in train}),trainLandmarks=len(train),riskRows=len(y)))
            for r in development:
                core,peer=design(r,(np.arange(120)+.5)*STEP)
                for arm,(cols,coeff) in models.items():
                    q=quantiles(core@core_coeff+peer[:,cols]@coeff)
                    identity=r['identities']
                    predictions.append(dict(id=r['id'],stop=stop,day=r['day'],bus=r['bus'],regime=regime,arm=arm,
                        elapsed=r['elapsed'],forecastAt=r['forecastAt'],truthRemaining=r['truthRemaining'],
                        lapSupported=r['lapSupported'],landmarkWeight=r['landmarkWeight'],q=q,
                        followerKnown=identity['follower'] is not None,sameAsAhead=identity['sameAsAhead'],
                        aheadUsable=r['snapshots']['ahead']['usable'],followerUsable=r['snapshots']['follower']['usable']))
            print(json.dumps(dict(stop=stop,regime=regime,trainVisits=len({r['id']for r in train}),riskRows=len(y),seconds=round(time.monotonic()-start,2))),flush=True)
    # Every unsupported-lap row must have exact core fallback, not disappear.
    grouped=collections.defaultdict(dict)
    for p in predictions:grouped[p['id'],p['elapsed'],p['regime']][p['arm']]=p
    for arms in grouped.values():
        if not arms[ARMS[0]]['lapSupported']:
            assert all(p['q']==arms[ARMS[0]]['q'] for p in arms.values())
    result=dict(fits=fits,durationSec=time.monotonic()-start,scriptSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                planSha256=hashlib.sha256((OUT/'PLAN.json').read_bytes()).hexdigest(),
                notes=['Training core fixed as offset for jointly regularized peer arms; unsupported lap exact fallback.',
                       'No calibration refit performed; no hyperparameter search. Reused development only.'])
    (OUT/'fits.json').write_text(json.dumps(result,indent=2)+'\n')
    (OUT/'predictions.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in predictions))
    print('Finished',len(predictions),'forecasts',flush=True)


if __name__=='__main__':main()
