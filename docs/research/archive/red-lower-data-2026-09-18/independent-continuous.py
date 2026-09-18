"""Fixed-policy diagnostics from saved forecasts; no fitting or replay rerun.

Each completed Winchester->Division journey counts once. Score the smallest
forecast occurrence at each poll from the observed source pin until the target
arrival. A margin m means reaching the stop at forecast low minus m seconds.
This is an oracle retrospective policy diagnostic, not a rider simulation.
"""
import argparse, collections, itertools, json, pathlib, sqlite3

HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parent

def analyze(label, folder, dbpath):
    score=json.loads((folder/'score.json').read_text())
    db=sqlite3.connect('file:'+str(dbpath)+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
    route_length=len(json.loads(db.execute('SELECT stops_json FROM routes WHERE id=3').fetchone()[0]))
    journeys=[j for j in score['journeys'] if j['sourceStop']==11 and j['target']==48]
    assert len({j['targetVisitId'] for j in journeys})==len(journeys)
    by_bus=collections.defaultdict(list);records={}
    for j in journeys:
        target=dict(db.execute('SELECT * FROM stop_visits WHERE id=?',(j['targetVisitId'],)).fetchone())
        key=j['journeyId'];by_bus[j['bus']].append(j)
        records[key]={**j,'targetDepartedAt':target['departed_at'],'targetOutcome':target['outcome'],
                      'targetHoldSec':target['stand_sec'],'frames':0,'changedFrames':0,'maxRaiseSec':0,
                      'baseline':{},'candidate':{},'changedOnly':{'baseline':{},'candidate':{}}}
    def consume(r,j):
        out=records[j['journeyId']];at=r['at'];out['frames']+=1
        changed=r['candidate']['low']>r['baseline']['low']+1e-7
        out['changedFrames']+=changed
        out['maxRaiseSec']=max(out['maxRaiseSec'],r['candidate']['low']-r['baseline']['low'])
        for arm in ['baseline','candidate']:
            planned=at+max(0,r[arm]['low'])*1000
            values={'arrivalExcessSec':(planned-j['targetArrivedAt'])/1000,
                    'departureExcessSec':None if out['targetDepartedAt'] is None else (planned-out['targetDepartedAt'])/1000}
            for metric,value in values.items():
                if value is None:continue
                evidence={'value':value,'at':at,'stopsAhead':r['stopsAhead'],'low':r[arm]['low'],
                          'baselineLow':r['baseline']['low'],'candidateLow':r['candidate']['low'],'changed':changed}
                if metric not in out[arm] or value>out[arm][metric]['value']:out[arm][metric]=evidence
                if changed and (metric not in out['changedOnly'][arm] or value>out['changedOnly'][arm][metric]['value']):
                    out['changedOnly'][arm][metric]=evidence
    next_lap_only=[]
    with (folder/'pairs.jsonl').open() as stream:
        for at,rawframe in itertools.groupby((json.loads(line) for line in stream),key=lambda x:x['at']):
            frame={}
            for r in rawframe:
                if r['target']!=48 or r.get('warmMs',0)<600000:continue
                bus=r['bus'].lstrip('#')
                if bus not in frame or r['stopsAhead']<frame[bus]['stopsAhead']:frame[bus]=r
            for bus,r in frame.items():
                matches=[j for j in by_bus[bus] if j['pinnedAt']<=at<j['targetArrivedAt']]
                assert len(matches)<=1,'Ambiguous physical target identity'
                if matches:
                    # Replay omits zero-hop/at-stop forecasts. When only a full
                    # lap remains in the saved file, it is not this arrival,
                    # even if the detector arrival clock trails by one poll.
                    if r['stopsAhead']>=route_length:
                        next_lap_only.append({'journeyId':matches[0]['journeyId'],'at':at,'stopsAhead':r['stopsAhead'],
                                              'changed':r['candidate']['low']!=r['baseline']['low']})
                        continue
                    consume(r,matches[0])
    db.close();values=list(records.values());summary=[]
    for scope in ['all','changedOnly']:
        for day in ['all']+sorted({v['day'] for v in values}):
            for outcome in ['all','stopped']:
                rows=[v for v in values if v['frames'] and (day=='all' or v['day']==day) and (outcome=='all' or v['targetOutcome']=='stopped')]
                arms={}
                for arm in ['baseline','candidate']:
                    scored=[(v,v[arm] if scope=='all' else v[scope][arm]) for v in rows]
                    arms[arm]={}
                    for metric in ['arrivalExcessSec','departureExcessSec']:
                        eligible=[(v,m[metric]['value']) for v,m in scored if metric in m]
                        arms[arm][metric]={'eligibleVisits':len(eligible),'unknownOrUnscored':len(rows)-len(eligible),
                            'missesByMarginSec':{str(m):sum(x>m for _,x in eligible) for m in [0,15,30]},
                            'worstSec':max((x for _,x in eligible),default=None)}
                summary.append({'scope':scope,'day':day,'outcome':outcome,'visits':len(rows),**arms})
    return {'label':label,'summary':summary,'journeys':values,'excludedNextLapOnlyRows':next_lap_only,
            'unknownTargetDepartureVisits':[v['journeyId'] for v in values if v['targetDepartedAt'] is None]}

parser=argparse.ArgumentParser();parser.add_argument('--targeted',action='store_true');args=parser.parse_args()
old_folder=HERE/'targeted' if args.targeted else HERE
today_folder=HERE/'targeted-today' if args.targeted else HERE/'today'
out={'method':__doc__,'candidate':'targeted first Division' if args.targeted else 'broad lower removal','data':[
    analyze('Sep16–17 reused',old_folder,ROOT/'release-integration-data/outcomes-complete.db'),
    analyze('Sep18 morning',today_folder,HERE/'outcomes-today.db')]}
(HERE/('independent-targeted-continuous.json' if args.targeted else 'independent-continuous.json')).write_text(json.dumps(out,indent=2)+'\n')
for d in out['data']:
    print(d['label'])
    for s in d['summary']:
        if s['day']=='all':print(json.dumps(s))
    print('Changed or overall newly bad departure cases:')
    for j in d['journeys']:
        m=j['changedOnly']['candidate'].get('departureExcessSec')
        if m and m['value']>0:print(j['sourceId'],j['targetVisitId'],j['day'],j['targetOutcome'],json.dumps(m))
