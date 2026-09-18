"""Read-only attribution of current-only release-pricing jumps on development data."""
import collections,datetime,hashlib,json,pathlib,sqlite3,statistics
from zoneinfo import ZoneInfo
D=pathlib.Path(__file__).resolve().parent; TZ=ZoneInfo('America/New_York')
def et(t):return datetime.datetime.fromtimestamp(t/1000,TZ).isoformat()
score=json.loads((D/'current-score.json').read_text());trace=json.loads((D/'jump-belief-trace.json').read_text())
states={(r['bus'],r['at']):r for r in trace['rows']};cut=trace['cutoff']
paired=collections.defaultdict(dict)
for line in (D/'integrated-pairs.jsonl').open():
 r=json.loads(line);assert r['at']<=cut
 k=(r['bus'],r['target']);old=paired[k].get(r['at'])
 if old is None or r['stopsAhead']<old['stopsAhead']:paired[k][r['at']]=r
previous={}
for k,rs in paired.items():
 vals=sorted(rs.values(),key=lambda r:r['at'])
 for a,b in zip(vals,vals[1:]):previous[k,b['at']]=a
db=sqlite3.connect('file:'+str(D.parent/'conditional-replay-data/outcomes.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
visits=[dict(r) for r in db.execute('select * from stop_visits where route_id=3 and stop_id in (11,121) and departed_at is not null')]
def source_at(bus,t):
 vv=[v for v in visits if v['bus_name']==bus and v['pinned_at'] is not None and v['pinned_at']-20000<=t<=v['departed_at']+45000]
 return [dict(id=v['id'],stop=v['stop_id'],pin=v['pinned_at'],dep=v['departed_at'],pinElapsed=(t-v['pinned_at'])/1000,afterDeparture=(t-v['departed_at'])/1000)for v in vv]
def snapshot(s):
 lead=s['belief']['lead'];ss=[x for x in s['situations'] if x['leg']==lead];mass=sum(x['mass']for x in ss)
 stand=sum(x['mass']for x in ss if x['standingAt']>=0)
 return dict(at=s['at'],atET=et(s['at']),support=s['modelSupported'],unclamped=s['unclampApplied'],pin=s.get('pin'),lap=s.get('lap'),elapsed=s.get('elapsed'),residual=s['residual'],belief=s['belief'],clampAt=s['clampAt'],leadMass=mass,pricedRestMass=stand,pricedRestShare=stand/mass if mass else None,raw={k:s['raw'].get(k)for k in ['lat','lon','stationary','at_stop_id','at_stop_since','stationary_since','last_moved_at','lap']},situations=s['situations'])
events=[]
for j in score['jumps']:
 if j['candidate']<=60 and j['baseline']<=60:continue
 assert j['at']<=cut
 bus='#'+j['bus'];after=paired[bus,j['target']][j['at']];before=previous[(bus,j['target']),j['at']]
 dt=(after['at']-before['at'])/1000
 assert 0<dt<=15
 a=snapshot(states[bus,before['at']]);b=snapshot(states[bus,after['at']])
 jj={arm:dt+after[arm]['eta']-before[arm]['eta'] if before.get(arm)and after.get(arm)else None for arm in ['baseline','clamped','current','full']}
 assert abs(jj['baseline']-j['baseline'])<1e-7 and abs(jj['current']-j['candidate'])<1e-7
 flags=[]
 if a['support']!=b['support']:flags.append('release support entry' if b['support']else 'release support exit')
 if a['pin']!=b['pin']:flags.append('cached pin changed')
 if any(a['belief'][k]!=b['belief'][k]for k in ['rested','restStop','restSince']):flags.append('rest identity/state changed')
 if a['belief']['lead']!=b['belief']['lead']:flags.append('lead leg changed')
 if a['clampAt']!=b['clampAt']:flags.append('priced lead rest changed')
 if a['unclamped']!=b['unclamped']:flags.append('ceiling bypass changed')
 shareDelta=b['pricedRestShare']-a['pricedRestShare']
 if abs(shareDelta)>.03:flags.append('rest/departure mixture share changed >3pp')
 rq=dt+b['residual']['eta']-a['residual']['eta'] if a['residual']and b['residual'] else None
 # Mutually exclusive descriptive cause categories. Mixture is observed, not
 # a causal intervention; separate before/after weights and CDF changes remain.
 category=('support boundary'if a['support']!=b['support']else
           'rest/lead state boundary'if any(x in flags for x in ['rest identity/state changed','lead leg changed','priced lead rest changed'])else
           'supported mixture change'if a['support'] and abs(shareDelta)>.03 else
           'supported smooth-state change'if a['support']else 'baseline/fallback path')
 events.append(dict(context=j,bus=bus,at=j['at'],atET=et(j['at']),dt=dt,jumps=jj,flags=flags,category=category,
                    newUpward=jj['current']>60 and jj['baseline']<=60,restShareChange=shareDelta,
                    conditionalRestAbsoluteMedianChange=rq,before=a,after=b,
                    sourceEpisodes=source_at(bus,j['at'])))
summary=[]
for target in [48,4]:
 rs=[r for r in events if r['context']['target']==target]
 for selection in ['current up60','new current up60','baseline up60']:
  ss=[r for r in rs if (r['jumps']['current']>60 if selection=='current up60'else r['newUpward']if selection=='new current up60'else r['jumps']['baseline']>60)]
  summary.append(dict(target=target,selection=selection,n=len(ss),categories=dict(collections.Counter(r['category']for r in ss)),flags=dict(collections.Counter(f for r in ss for f in r['flags'])),maxJump=max([r['jumps']['current']for r in ss],default=None)))
widths=[]
for r in score['checkpoints']:
 if (r['sourceStop'],r['target'],r['phase'],r['checkpointSec'])!=(11,48,'standing',60):continue
 s=states['#'+r['bus'],r['at']]
 def width(p):return p['high']-max(0,p['low']) if p else None
 def target(prices):return next((p for p in prices if p['stopId']==48 and p['stopsAhead']<=29),None)
 stand=target(s.get('standingOnlyPrices',[]));raw=target(s.get('rawPrices',[]));move=target(s.get('movingOnlyPrices',[]))
 if s['unclampApplied']:
  for k in ['eta','low','high']:assert abs(max(0,raw[k])-r['candidate'][k])<1e-7,(r['sourceId'],k,raw,r['candidate'])
 widths.append(dict(id=r['sourceId'],day=r['day'],bus=r['bus'],at=r['at'],supported=s['modelSupported'],unclamped=s['unclampApplied'],
                    baselineWidth=width(r['baseline']),shownWidth=width(r['candidate']),rawMixtureWidth=width(raw),
                    releaseResidualWidth=width(s['residual']),standingOnlyWidth=width(stand),movingOnlyWidth=width(move),
                    standingMass=s.get('standingMass'),movingMass=s.get('movingMass'),leadMass=(s.get('standingMass',0)+s.get('movingMass',0)),
                    currentPoint=r['candidate']['eta'],truth=r['truthSec']))
widthSummary=[]
for sel in ['all','supported','unsupported']:
 rs=[r for r in widths if sel=='all'or r['supported']==(sel=='supported')]
 widthSummary.append(dict(selection=sel,n=len(rs),**{k:statistics.mean([r[k]for r in rs if r[k]is not None])if any(r[k]is not None for r in rs)else None for k in ['baselineWidth','shownWidth','rawMixtureWidth','releaseResidualWidth','standingOnlyWidth','movingOnlyWidth','standingMass','movingMass','leadMass']},pointMAE=statistics.mean(abs(r['currentPoint']-r['truth'])for r in rs)))
stable=[r for r in events if r['jumps']['current']>60 and r['category']=='supported mixture change']
out=dict(method=__doc__,scope='First physical target occurrence on the existing exact connected source-target contexts, warm>=600sec, adjacent frames<=15sec. Both endpoint outcomes follow parent scorer. Additional target occurrence not scored. No reserved afternoon frames read.',cutoff=cut,checks=dict(beliefTrace=trace['beliefChecks'],pairedJumpArithmetic=len(events),widthPricingParity=sum(r['unclamped']for r in widths)),
         jumpSummary=summary,widthSummary=widthSummary,widthCheckpoints=widths,
         stableMixtureDiagnostics=dict(n=len(stable),maxConditionalRestAbsoluteMedianChange=max((r['conditionalRestAbsoluteMedianChange'] for r in stable),default=None),medianRestShareIncrease=statistics.median(r['restShareChange']for r in stable)if stable else None),
         events=sorted(events,key=lambda r:r['jumps']['current']-max(0,r['jumps']['baseline']),reverse=True),
         inputs={p.name:hashlib.sha256(p.read_bytes()).hexdigest()for p in [D/'integrated-meta.json',D/'current-score.json',D/'jump-belief-trace.json',pathlib.Path(__file__)]})
(D/'integrated-jump-review.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({k:out[k]for k in ['checks','jumpSummary','widthSummary','stableMixtureDiagnostics']},indent=2))
