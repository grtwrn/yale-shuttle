"""Frozen causal bunching regimes, conditional landmark remaining-time screen."""
from pathlib import Path
import bisect, collections, datetime, hashlib, importlib.util, json, math, sqlite3, statistics
from zoneinfo import ZoneInfo
import numpy as np
from scipy.optimize import minimize
from scipy.special import expit

OUT=Path(__file__).resolve().parent;ROOT=OUT.parent
PLAN=json.loads((OUT/'PLAN.json').read_text())
ARMS=PLAN['arms'];CUT=1789358400000;AGES=PLAN['landmarks'];TZ=ZoneInfo('America/New_York')
OLD=ROOT/'red-rest-history-2026-09-18/own-history'
helper=ROOT/'red-early-covariates-2026-09-18/union-survival/screen.py'
spec=importlib.util.spec_from_file_location('survival_helpers',helper);util=importlib.util.module_from_spec(spec);spec.loader.exec_module(util)
SPACE_FIELDS=['ahead_known','log_forward','ahead_age','behind_known','log_backward','behind_age','same_peer','co_anchor']
GATE_FIELDS=['close_leader','close_follower','co_anchor','distinct_close_balance','same_peer_close','gate_ahead_age','gate_behind_age']


def day(t):return datetime.datetime.fromtimestamp(t/1000,TZ).date().isoformat()


def load():
    for f,h in PLAN['inputs'].items():assert hashlib.sha256(Path(f).read_bytes()).hexdigest()==h,f
    episodes={r['id']:r for name in ['cohort.json','extension-cohort.json'] for r in json.loads((OLD/name).read_text())}
    assert len(episodes)==290 and sum(e['split']=='train' for e in episodes.values())==160
    db=sqlite3.connect('file:'+str(ROOT/'release-integration-data/outcomes-complete.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
    seq=json.loads(db.execute('select stops_json from routes where id=3').fetchone()[0])
    visits={v['id']:dict(v) for v in db.execute('select * from stop_visits')}
    legs=[dict(v) for v in db.execute('select * from legs where route_id=3 and reached=1 and hops=1 and arrived_at+120000 < ?',(CUT,))]
    db.close()
    for cap in [ROOT/'red-early-covariates-2026-09-18/recordings-followup.json',ROOT/'red-rest-history-2026-09-18/recordings.json']:
        for v in json.loads(cap.read_text())['stop_visits']:
            if v['id'] in visits:assert v['anchored_at']==visits[v['id']]['anchored_at']
            visits[v['id']]=v
    edge=collections.defaultdict(list)
    for l in legs:
        if l['from_stop_id'] in seq and l['to_stop_id']==seq[(seq.index(l['from_stop_id'])+1)%len(seq)] and l['leg_sec']>=0:
            edge[l['from_stop_id']].append(l['leg_sec'])
    assert all(edge[s] for s in seq)
    costs=[statistics.median(edge[s]) for s in seq]
    assert all(c>0 for c in costs)
    extractor=Extractor(list(visits.values()),seq,costs)
    records=[]
    for e in episodes.values():
        ages=[age for age in AGES if age<e['y']]
        for age in ages:
            r=dict(id=e['id'],bus=e['bus'],day=e['day'],pinAt=e['a'],forecastAt=e['a']+age*1000,
                elapsed=age,truthRemaining=e['y']-age,holdSec=e['y'],split=e['split'],lap=e['lap'],
                lapSupported=e['lapSupported'],weight=1/len(ages),ownUnionDeparture=e['ownUnionDeparture'])
            r['snapshots']={str(delay):extractor.snapshot(r,delay) for delay in [15,120]}
            records.append(r)
    train=[e for e in episodes.values() if e['split']=='train']
    reference=statistics.median(e['lap'] for e in train if e['lap'] is not None and 900<e['lap']<7200)
    tables=dict(sequence=seq,edgeCosts=costs,edgeSupport={s:len(edge[s]) for s in seq},totalTravelProxy=sum(costs))
    return episodes,records,reference,tables,extractor


class Extractor:
    def __init__(self,visits,seq,costs):
        self.seq=seq;self.origin=seq.index(11);self.n=len(seq);self.costs=costs
        self.anchors=collections.defaultdict(list)
        for v in visits:
            self.anchors[v['bus_name']].append({k:v[k] for k in ['id','bus_name','route_id','stop_id','stop_index','anchored_at']})
        for vs in self.anchors.values():vs.sort(key=lambda v:(v['anchored_at'],v['id']))
        self.times={b:[v['anchored_at'] for v in vs] for b,vs in self.anchors.items()}
        self.temporalChecks=0

    def distance(self,start,end):
        return sum(self.costs[(start+i)%self.n] for i in range((end-start)%self.n))

    def snapshot(self,r,delay):
        at=r['forecastAt'];peers=[];reject=collections.Counter()
        for bus,vs in self.anchors.items():
            if bus==r['bus']:continue
            i=bisect.bisect_right(self.times[bus],at-delay*1000)
            if not i:continue
            v=vs[i-1]
            assert v['anchored_at']+delay*1000<=at
            assert i==len(vs) or vs[i]['anchored_at']+delay*1000>at
            self.temporalChecks+=1
            tied=[w for w in vs[max(0,bisect.bisect_left(self.times[bus],v['anchored_at'])):i]]
            if len({(w['route_id'],w['stop_index']) for w in tied})>1:reject['ambiguous_latest_assignment']+=1;continue
            if v['route_id']!=3:reject['other_route']+=1;continue
            age=(at-v['anchored_at'])/1000
            if day(v['anchored_at'])!=r['day'] or age>300:reject['stale_other_day']+=1;continue
            si=v['stop_index']
            if si is None or not 0<=si<self.n or self.seq[si]!=v['stop_id']:reject['invalid_occurrence']+=1;continue
            gap=(si-self.origin)%self.n
            peers.append(dict(v,knownAt=v['anchored_at']+delay*1000,age=age,gap=gap,
                forward=self.distance(self.origin,si),backward=self.distance(si,self.origin)))
        colocated=[p for p in peers if p['gap']==0]
        ordered=[p for p in peers if p['gap']>0]
        def choose(side):
            if colocated:return None,'co_anchor_unknown_order'
            if not ordered:return None,'no_fresh_ordered_peer'
            value=min(p[side] for p in ordered);w=[p for p in ordered if p[side]==value]
            return (w[0],'known') if len(w)==1 else (None,'equal_gap_tie')
        ahead,ar=choose('forward');behind,br=choose('backward')
        same=bool(ahead and behind and ahead['bus_name']==behind['bus_name'])
        ca=bool(ahead and ahead['forward']<=180);cb=bool(behind and behind['backward']<=180)
        balance=(behind['backward']-ahead['forward'])/(behind['backward']+ahead['forward']) if ahead and behind and not same else 0
        space=[float(ahead is not None),math.log1p(ahead['forward']/180) if ahead else 0,ahead['age']/300 if ahead else 0,
            float(behind is not None),math.log1p(behind['backward']/180) if behind else 0,behind['age']/300 if behind else 0,
            float(same),float(bool(colocated))]
        return dict(ahead=ahead,behind=behind,aheadReason=ar,behindReason=br,coAnchors=colocated,
            samePeer=same,closeLeader=ca,closeFollower=cb,distinctClose=bool(ahead and behind and not same and(ca or cb)),
            balance=balance,spaceFeatures=space,freshOtherBuses=len(peers),rejected=dict(reject))


def core_design(r,residual,reference):
    residual=np.asarray(residual,dtype=float);t=residual+r['elapsed']
    angle=2*np.pi*(math.floor(r['pinAt']/1000)%900+t)/900
    lap=(r['lap']-reference)/600 if r['lapSupported'] else 0
    return np.column_stack([np.ones_like(t),np.log1p(t/60),t/600,np.maximum(t-300,0)/600,
        np.maximum(t-600,0)/600,np.full_like(t,lap),np.full_like(t,float(not r['lapSupported'])),
        np.sin(angle),np.cos(angle),np.full_like(t,r['elapsed']/600)])


def support(rows,fn,names):
    out=[]
    for j,name in enumerate(names):
        rs=[r for r in rows if abs(fn(r)[j])>1e-12]
        visits=len({r['id'] for r in rs});dates=len({r['day'] for r in rs})
        out.append(dict(name=name,visits=visits,dates=dates,origins=len(rs),supported=visits>=20 and dates>=3))
    return out


def gate_features(snapshot,regime_support):
    raw=[float(snapshot['closeLeader']),float(snapshot['closeFollower']),float(bool(snapshot['coAnchors']))]
    active=any(x and regime_support[j]['supported'] for j,x in enumerate(raw))
    if not active:return [0.]*7,False
    return [*raw,snapshot['balance'] if snapshot['distinctClose'] else 0,
        float(snapshot['samePeer'] and(snapshot['closeLeader'] or snapshot['closeFollower'])),
        snapshot['ahead']['age']/300 if snapshot['ahead'] else 0,
        snapshot['behind']['age']/300 if snapshot['behind'] else 0],True


def fit_model(X,y,offset,penalty):
    def objective(b):
        z=offset+X@b
        return float(np.logaddexp(0,z).sum()-y@z+.5*np.dot(penalty,b*b)),X.T@(expit(z)-y)+penalty*b
    initial=np.zeros(X.shape[1])
    if len(initial) and penalty[0]==0:initial[0]=math.log(y.mean()/(1-y.mean()))
    result=minimize(objective,initial,jac=True,method='L-BFGS-B',options={'maxiter':2000,'gtol':1e-8,'ftol':1e-12})
    assert result.success,result.message
    return result.x,dict(iterations=result.nit,objective=float(result.fun),maxGradient=float(max(abs(result.jac))))


def predict(r,snapshot,reference,fits,supports):
    core=core_design(r,(np.arange(120)+.5)*15,reference)@np.array(fits[ARMS[0]]['coefficients'])
    gate,active=gate_features(snapshot,supports['regimes'])
    extras={ARMS[1]:snapshot['spaceFeatures'],ARMS[2]:gate}
    out={}
    for arm in ARMS:
        logits=core.copy()
        if arm!=ARMS[0]:
            m=fits[arm];logits+=np.array(extras[arm])[m['columns']]@np.array(m['coefficients'])
        logs=np.r_[0,-np.cumsum(np.logaddexp(0,logits))]
        tail=min(1/5,max(1/1800,(logs[-2]-logs[-1])/15))
        d=(np.arange(121)*15,logs,tail);q,p=util.remaining(d,0)
        out[arm]=dict(q=q,p120=p)
    if not active:assert out[ARMS[2]]==out[ARMS[0]]
    return out,active


def groups(rows):
    out={'all':rows,'lap_supported':[r for r in rows if r['lapSupported']],
        'lap_unsupported':[r for r in rows if not r['lapSupported']],
        'close_leader':[r for r in rows if r['snapshot']['closeLeader']],
        'close_follower':[r for r in rows if r['snapshot']['closeFollower']],
        'co_anchor':[r for r in rows if r['snapshot']['coAnchors']],
        'same_peer':[r for r in rows if r['snapshot']['samePeer']],
        'distinct_close':[r for r in rows if r['snapshot']['distinctClose']],
        'supported_gate':[r for r in rows if r['gateActive']],
        'no_gate':[r for r in rows if not r['gateActive']],
        'no_ordered_peer':[r for r in rows if not r['snapshot']['ahead'] and not r['snapshot']['behind']]}
    for name,fn in [('median_le3',lambda x:x<=180),('median_3to8',lambda x:180<x<=480),('median_gt8',lambda x:x>480)]:
        rr=[r for r in rows if fn(r['predictions'][ARMS[0]]['q'][3])];out[name]=rr
        for group in ['close_leader','close_follower','co_anchor','supported_gate']:
            ids={(r['id'],r['elapsed']) for r in out[group]};out[group+'_'+name]=[r for r in rr if (r['id'],r['elapsed']) in ids]
    for age in AGES:out['elapsed_'+str(age)]=[r for r in rows if r['elapsed']==age]
    return out


def score(records,arms=ARMS):
    result=[]
    for delay in [15,120]:
        rr=[r for r in records if r['delay']==delay and r['split']=='development']
        periods={'Sep14_17':[r for r in rr if r['day']<'2026-09-18'],'Sep18':[r for r in rr if r['day']=='2026-09-18']}
        periods.update({d:[r for r in rr if r['day']==d] for d in sorted({r['day'] for r in rr})})
        for period,rs in periods.items():
            for group,ss in groups(rs).items():
                if not ss:continue
                for weighting in ['checkpoint','visit']:
                    metrics={arm:util.metrics(ss,arm,weighting) for arm in arms}
                    for arm,m in metrics.items():
                        m['earlyVisits']=len({r['id'] for r in ss if r['truthRemaining']<r['predictions'][arm]['q'][1]})
                        m['lateVisits']=len({r['id'] for r in ss if r['truthRemaining']>r['predictions'][arm]['q'][5]})
                    result.append(dict(delay=delay,period=period,group=group,weighting=weighting,arms=metrics))
    return result


def main():
    episodes,records,reference,tables,extractor=load()
    train=[r for r in records if r['split']=='train']
    regimes=support(train,lambda r:[float(r['snapshots']['15']['closeLeader']),float(r['snapshots']['15']['closeFollower']),float(bool(r['snapshots']['15']['coAnchors']))],GATE_FIELDS[:3])
    spaces=support(train,lambda r:r['snapshots']['15']['spaceFeatures'],SPACE_FIELDS)
    gates=support(train,lambda r:gate_features(r['snapshots']['15'],regimes)[0],GATE_FIELDS)
    supports=dict(regimes=regimes,spacing=spaces,gate=gates)
    xx,ys,space,gate=[],[],[],[]
    for r in train:
        bins=max(1,math.ceil(min(1800,r['truthRemaining'])/15))
        xx.append(core_design(r,(np.arange(bins)+.5)*15,reference))
        y=np.zeros(bins)
        if r['truthRemaining']<=1800:y[-1]=1
        ys.append(y)
        space.append(np.broadcast_to(r['snapshots']['15']['spaceFeatures'],(bins,len(SPACE_FIELDS))))
        gf,_=gate_features(r['snapshots']['15'],regimes);gate.append(np.broadcast_to(gf,(bins,len(GATE_FIELDS))))
    X,y=np.vstack(xx),np.concatenate(ys)
    beta,diag=fit_model(X,y,np.zeros(len(y)),np.r_[0,np.full(X.shape[1]-1,4.)])
    fits={ARMS[0]:dict(coefficients=beta.tolist(),diagnostic=diag)}
    for arm,raw,ss in [(ARMS[1],np.vstack(space),spaces),(ARMS[2],np.vstack(gate),gates)]:
        cols=[j for j,v in enumerate(ss) if v['supported']]
        if cols:beta2,diag=fit_model(raw[:,cols],y,X@beta,np.full(len(cols),10.))
        else:beta2=np.zeros(0);diag=dict(reason='No supported feature; exact core fallback')
        fits[arm]=dict(columns=cols,coefficients=beta2.tolist(),diagnostic=diag)
    payload=dict(createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),fits=fits,supports=supports,
        referenceLap=reference,tables=tables,trainingVisits=160,trainingOrigins=len(train),trainingRiskRows=len(y),
        sourceSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),planSha256=hashlib.sha256((OUT/'PLAN.json').read_bytes()).hexdigest())
    # Freeze fits/support before scoring existing evaluation or any fresh capture.
    (OUT/'fits.json').write_text(json.dumps(payload,indent=2)+'\n')
    predictions=[]
    for r in records:
        for delay in [15,120]:
            snap=r['snapshots'][str(delay)];p,active=predict(r,snap,reference,fits,supports)
            output={k:v for k,v in r.items() if k!='snapshots'}
            output.update(delay=delay,snapshot=snap,predictions=p,gateActive=active)
            predictions.append(output)
    results=score(predictions)
    audit=dict(totalVisits=len(episodes),origins=len(records),trainingVisits=160,trainingOrigins=len(train),
        temporalLatestChecks=extractor.temporalChecks,cohortCounts=dict(collections.Counter(e['day'] for e in episodes.values())),
        availability={delay:dict(origins=len([r for r in predictions if r['delay']==delay]),orderedOrigins=sum(bool(r['snapshot']['ahead'] or r['snapshot']['behind']) for r in predictions if r['delay']==delay),
            gateOrigins=sum(r['gateActive'] for r in predictions if r['delay']==delay),coAnchorOrigins=sum(bool(r['snapshot']['coAnchors']) for r in predictions if r['delay']==delay)) for delay in [15,120]},
        identityChanges=sum((r['snapshots']['15']['ahead'] or {}).get('bus_name')!=(r['snapshots']['120']['ahead'] or {}).get('bus_name') or
            (r['snapshots']['15']['behind'] or {}).get('bus_name')!=(r['snapshots']['120']['behind'] or {}).get('bus_name') for r in records))
    (OUT/'predictions.jsonl').write_text(''.join(json.dumps(r,separators=(',',':'))+'\n' for r in predictions))
    (OUT/'scores.json').write_text(json.dumps(results,indent=2)+'\n')
    (OUT/'extraction-audit.json').write_text(json.dumps(audit,indent=2)+'\n')
    print(json.dumps(payload,indent=2));print(json.dumps(audit,indent=2))
    for r in results:
        if r['period'] in ['Sep14_17','Sep18'] and r['group'] in ['all','supported_gate','close_leader','close_follower','co_anchor'] and r['weighting']=='checkpoint':
            print(json.dumps({**r,'arms':{a:{k:v[k] for k in ['visits','landmarks','mae','wis80','width80','earlyCount','lateCount']} for a,v in r['arms'].items()}}))


if __name__=='__main__':main()
