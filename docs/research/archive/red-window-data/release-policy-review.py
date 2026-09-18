"""Read-only phase/slot review. Descriptive per-bus/day phases never enter predictors.
Slot centers use same-day, previously known departures only. Coefficients/center
corrections fit before Sep10; residual CDF Sep10-11; retrospective Sep14-17 tests.
"""
import bisect,collections,datetime,hashlib,json,math,pathlib,sqlite3,statistics
from zoneinfo import ZoneInfo
import numpy as np
D=pathlib.Path(__file__).resolve().parent;P=D/'operating-pattern-screen.json';x=json.loads(P.read_text());rows=x['featureRows'];TZ=ZoneInfo('America/New_York')
clock=lambda t:datetime.datetime.fromtimestamp(t/1000,TZ)
cut=lambda s:datetime.datetime.fromisoformat(s).replace(tzinfo=TZ).timestamp()*1000
F,T=cut('2026-09-10'),cut('2026-09-14');H=3600000
conn=sqlite3.connect('file:'+str(D.parent/'conditional-replay-data/outcomes.db')+'?mode=ro',uri=True);conn.row_factory=sqlite3.Row
hist={k:collections.defaultdict(list)for k in ['modern','legacy']}
for v in conn.execute("SELECT * FROM stop_visits WHERE route_id=3 AND stop_id IN(11,121) AND departed_at IS NOT NULL AND how!='gap' AND outcome IN('stopped','passed') ORDER BY departed_at"):
 if v['closest_m'] is None or v['closest_m']>75 or v['departed_at']<v['anchored_at']:continue
 # Available by query only after known confirmation evidence plus120s grace.
 known=max(v['departed_at'],(v['first_moved_at']or v['departed_at'])+(v['confirm_sec']or 0)*1000)
 hist['modern'][(v['bus_name'],v['stop_id'])].append(dict(id=v['id'],d=v['departed_at'],ready=known+120000,how=v['how'],outcome=v['outcome']))
for v in conn.execute('SELECT id,bus_name,stop_id,departed_at FROM arrivals WHERE route_id=3 AND stop_id IN(11,121) AND departed_at IS NOT NULL ORDER BY departed_at'):
 hist['legacy'][(v['bus_name'],v['stop_id'])].append(dict(id=v['id'],d=v['departed_at'],ready=v['departed_at']+120000))
conn.close()
models={z['stop']:z for z in x['results']}
for r in rows:
 for kind in ['modern','legacy']:
  hs=[p for p in hist[kind][(r['bus'],r['stop'])]if p['ready']<=r['a'] and clock(p['d']).date().isoformat()==r['day']]
  os=[p for p in hist[kind][(r['bus'],121 if r['stop']==11 else 11)]if p['ready']<=r['a'] and clock(p['d']).date().isoformat()==r['day']]
  previous=hs[-1]if hs else None;ref=models[r['stop']]['referenceLap']
  support=previous is not None and any(previous['d']<p['d']<r['a']for p in os) and .65*ref<=(r['a']-previous['d'])/1000<=1.65*ref
  r[kind+'History']=hs;r[kind+'OtherHistory']=os;r[kind+'Available']=support
  r[kind+'Previous']=previous
 for name in ['modern','legacy']:
  r[name+'Slot']=(r[name+'Previous']['d']+H-r['a'])/1000 if r[name+'Available']else None
 r['modernPhase2Slot']=None
 # Both prior departures need an intervening opposite-regulator observation;
 # use a fixed30-90min prior-record spacing guard, not any current outcome.
 hs=r['modernHistory'];os=r['modernOtherHistory']
 if r['modernAvailable'] and len(hs)>=2:
  p,q=hs[-2:]
  if 1800000<=q['d']-p['d']<=5400000 and any(p['d']<o['d']<q['d']for o in os):
   angles=[2*math.pi*o['d']/H for o in [p,q]]
   z=sum(complex(math.cos(a),math.sin(a))for a in angles)/2
   if abs(z)>.2:
    phase=(math.atan2(z.imag,z.real)%(2*math.pi))*H/(2*math.pi)
    nearest=phase+round((q['d']+H-phase)/H)*H
    r['modernPhase2Slot']=(nearest-r['a'])/1000
    r['modernPhase2Ids']=[p['id'],q['id']]
 r['modernPhase2Available']=r['modernPhase2Slot']is not None

def rawlap(r):
 m=models[r['stop']];ref=m['referenceLap'];co=m['arms']['lap']['coefficients']
 tr=[q['y']for q in rows if q['stop']==r['stop'] and q['ready']<F]
 return max(0,co[0]+co[1]*(r['lap']-ref)/600)if r['lap']is not None and .65*ref<=r['lap']<=1.65*ref else statistics.median(tr)
def metric(rs):
 if not rs:return {'n':0}
 e=np.array([r['point']-r['truth']for r in rs]);w=np.array([r['high']-r['low']for r in rs])
 wis=[(.5*abs(r['point']-r['truth'])+.1*(r['high']-r['low'])+max(0,r['low']-r['truth'])+max(0,r['truth']-r['high']))/1.5 for r in rs]
 return dict(n=len(rs),days=len({r['day']for r in rs}),MAE=float(np.abs(e).mean()),medianAbs=float(np.median(np.abs(e))),p90Abs=float(np.quantile(np.abs(e),.9)),WIS=statistics.mean(wis),width=float(w.mean()),early=sum(r['truth']<r['low']for r in rs),late=sum(r['truth']>r['high']for r in rs),over120=int(sum(e>120)),under120=int(sum(e< -120)),centerMAE=statistics.mean(abs(r['center']-r['truth'])for r in rs))
results=[]
for stop in [11,121]:
 cell=[r for r in rows if r['stop']==stop];tr=[r for r in cell if r['ready']<F];ca=[r for r in cell if r['a']>=F and r['ready']<T];te=[r for r in cell if r['a']>=T]
 corrections={name:statistics.median(r['y']-r[name+'Slot']for r in tr if r[name+'Available'])for name in ['modern','legacy','modernPhase2']}
 arms={}
 for arm in ['lap','modern','legacy','modernPhase2']:
  def center(r):return max(0,r[arm+'Slot']+corrections[arm])if arm!='lap' and r[arm+'Available']else rawlap(r)
  residuals=[r['y']-center(r)for r in ca];qs=np.quantile(residuals,[.1,.5,.9]);pred=[]
  for r in te:
   m=center(r);lo,pt,hi=[max(0,float(m+q))for q in qs]
   pred.append(dict(id=r['id'],day=r['day'],bus=r['bus'],truth=r['y'],center=m,point=pt,low=lo,high=hi,supported=r[arm+'Available']if arm!='lap'else r['lap']is not None and .65*models[stop]['referenceLap']<=r['lap']<=1.65*models[stop]['referenceLap']))
  groups={'all':te,'modern_legacy_common':[r for r in te if r['modernAvailable']and r['legacyAvailable']],'all_three_common':[r for r in te if all(r[name+'Available']for name in ['modern','legacy','modernPhase2'])]}
  scores={name:metric([p for p in pred if p['id']in{r['id']for r in rs}])for name,rs in groups.items()}
  arms[arm]=dict(trainCenterCorrectionSec=corrections.get(arm),calibrationResidualQuantiles=qs.tolist(),calibrationResiduals=residuals,scores=scores,byDate={day:metric([p for p in pred if p['day']==day])for day in sorted({r['day']for r in te})},predictions=pred)
 # Verify this comparator exactly reproduces parent's saved baseline.
 original={r['id']:r for r in models[stop]['arms']['lap']['predictions']}
 for r in arms['lap']['predictions']:
  assert all(abs(r[k]-original[r['id']][k])<1e-8 for k in ['point','low','high'])
 results.append(dict(stop=stop,trainN=len(tr),calibrationN=len(ca),testN=len(te),referenceLapSec=models[stop]['referenceLap'],support={name:{part:sum(r[name+'Available']for r in rs)for part,rs in [('train',tr),('calibration',ca),('test',te)]}for name in ['modern','legacy','modernPhase2']},arms=arms,matchedPreviousModernMinusLegacySec=[dict(id=r['id'],delta=(r['modernPrevious']['d']-r['legacyPrevious']['d'])/1000,modernId=r['modernPrevious']['id'],legacyId=r['legacyPrevious']['id'])for r in te if r['modernAvailable']and r['legacyAvailable']]))
# Descriptive aliases: no per-day fitted phase enters any prediction above.
phasegroups=collections.defaultdict(list)
for r in rows:phasegroups[(r['stop'],r['day'],r['bus'])].append(r)
phases=[]
for key,rs in sorted(phasegroups.items()):
 if len(rs)<3:continue
 dep=sorted(r['d']for r in rs);desc={}
 for period in [15,60]:
  angles=[2*math.pi*d/(period*60000)for d in dep];z=sum(complex(math.cos(a),math.sin(a))for a in angles)/len(angles);R=abs(z)
  desc[str(period)]=dict(R=R,phaseMinutes=(math.atan2(z.imag,z.real)%(2*math.pi))*period/(2*math.pi),circularSpreadSec=period*60/(2*math.pi)*math.sqrt(-2*math.log(max(1e-15,min(1,R)))))
 gaps=[(b-a)/60000 for a,b in zip(dep,dep[1:])]
 phases.append(dict(stop=key[0],day=key[1],bus=key[2],n=len(rs),phase=desc,consecutiveGapMinutes=gaps,medianGapMinutes=statistics.median(gaps)))
phaseSummary=[]
for stop in[11,121]:
 ps=[p for p in phases if p['stop']==stop];g=[v for p in ps for v in p['consecutiveGapMinutes']]
 phaseSummary.append(dict(stop=stop,busDays=len(ps),observations=sum(p['n']for p in ps),medianBusDayR60=statistics.median(p['phase']['60']['R']for p in ps),medianBusDayR15=statistics.median(p['phase']['15']['R']for p in ps),medianSpread60Sec=statistics.median(p['phase']['60']['circularSpreadSec']for p in ps),medianSpread15Sec=statistics.median(p['phase']['15']['circularSpreadSec']for p in ps),gaps=len(g),medianGapMinutes=statistics.median(g),gap55to65=sum(55<=v<=65 for v in g),gap50to70=sum(50<=v<=70 for v in g),gapAbove90=sum(v>90 for v in g)))
# Only keep explicit selected history IDs and timestamps, not full repeated history arrays.
features=[]
for r in rows:
 rr={k:v for k,v in r.items()if not k.endswith('History') and k not in ['ownIds','fleetIds','otherIds']};features.append(rr)
report=dict(method=__doc__,inputSha256=hashlib.sha256(P.read_bytes()).hexdigest(),choices=dict(hourPeriodSec=3600,priorClockAvailability='Modern confirmation evidence plus120sec; legacy departed_at plus120sec because receipt metadata unavailable. Both require same-day opposite regulator between own prior departure and query.',support='Current previous-departure age inside0.65–1.65 times preSep10 legacy median lap, independent of current outcome; prior2 modern departures30–90min apart with opposite regulator between them.',center='Per-arm, per-stop median observed-minus-slot on supported training visits only; nonnegative center; missing feature fallback to exact parent lap comparator. Separate complete calibration residual CDF recenters the final median and bounds.',phase2='Circular mean of prior2 modern departures modulo60min, projected to nearest hourly slot around latest departure+3600sec. No future within-day phase used.',cohort='Same535 complete stopped targets as parent screen; excludes proven truncated duration65237, but its valid departure endpoint may still be used as historical evidence.'),phaseSummary=phaseSummary,busDayPhases=phases,results=results,featureRows=features)
(D/'release-policy-review.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'phaseSummary':phaseSummary,'results':[dict(stop=z['stop'],support=z['support'],arms={name:dict(correction=a['trainCenterCorrectionSec'],cal=a['calibrationResidualQuantiles'],scores=a['scores'],byDate=a['byDate'])for name,a in z['arms'].items()})for z in results]},indent=2))
