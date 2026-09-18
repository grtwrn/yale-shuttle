from pathlib import Path
import json,statistics
O=Path(__file__).resolve().parent
records=list(map(json.loads,(O/'label-changes.jsonl').open()));new=[r['corrected'] for r in records if r['change']=='newly-resolved'];ret=[r for r in records if r['change']=='retargeted']
summary={'newlyResolved':len(new),'truthRangeSec':[min(r['truthSec'] for r in new),max(r['truthSec'] for r in new)],'pointErrors':{a:{'mean':statistics.mean(abs(max(0,r[a][0])-r['truthSec']) for r in new),'max':max(abs(max(0,r[a][0])-r['truthSec']) for r in new)} for a in ['current','canonical']},'newlyResolvedMostInaccurate':sorted(new,key=lambda r:abs(max(0,r['current'][0])-r['truthSec']),reverse=True)[:5],'allEightFollowingCorrections':[{'poll':r['key'][0],'route':r['key'][1],'bus':r['key'][2],'oldTarget':r['previous']['targetId'],'correctTarget':r['corrected']['targetId'],'oldTruth':r['previous']['truthSec'],'correctTruth':r['corrected']['truthSec'],'current':r['corrected']['current'],'canonical':r['corrected']['canonical']} for r in ret]}
(O/'resolved-case-audit.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps({k:v for k,v in summary.items() if k!='newlyResolvedMostInaccurate'},indent=2))
