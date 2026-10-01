from pathlib import Path
import json,collections
O=Path(__file__).resolve().parent;B=O.parent/'cycle-15';proof=json.loads((O/'lagged-origin-audit.json').read_text());keys={(c['score']['poll'],c['score']['route'],c['score']['bus'],c['score']['targetIndex']):c for c in proof['cases'] if c['arm']=='current'};following=[]
for line in (B/'connected-pairs.jsonl').open():
 r=json.loads(line);k=(r['poll'],r['route'],r['bus'],r['targetIndex'])
 if k in keys and r['occurrence']==1:
  case=keys[k];assert case['followingTarget']['id']!=r['targetId'];following.append({'currentOccurrence':case['score'],'followingOccurrence':r,'expectedFollowingTargetId':case['followingTarget']['id'],'wireAtTarget':case['wireAtTarget']})
result={'provedCurrentCases':len(keys),'routes':dict(collections.Counter(k[1] for k in keys)),'priorVisitCount':len({c['priorRest']['id'] for c in proof['cases']}),'followingRowsScoredOneLapTooFar':len(following),'followingRows':following}
assert result['provedCurrentCases']==11 and result['priorVisitCount']==10 and len(following)==8
(O/'lagged-following-audit.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='followingRows'},indent=2))
