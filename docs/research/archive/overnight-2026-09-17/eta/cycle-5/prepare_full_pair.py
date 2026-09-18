from pathlib import Path
import re,subprocess,json,hashlib,datetime
O=Path(__file__).resolve().parent;R=Path.cwd();repo=R.parents[1]
files={'web/src/eta/index.ts':'baseline-index.generated.mts','web/src/arrivals.ts':'baseline-arrivals.generated.mts','src/server/serverEta.ts':'baseline-server.generated.mts'}
hashes={}
for rel,name in files.items():
 original=R/rel;s=subprocess.check_output(['git','show','HEAD:services/shuttle-v2/'+rel],text=True);hashes[rel]=hashlib.sha256(s.encode()).hexdigest()
 def resolve(m):
  spec=m[2]
  if not spec.startswith('.'):return m[0]
  p=(original.parent/spec).resolve()
  if p.suffix=='.js':p=p.with_suffix('.ts')
  elif not p.suffix:p=p.with_suffix('.ts') if p.with_suffix('.ts').exists() else p/'index.ts'
  dest=O/files[str(p.relative_to(R))] if str(p.relative_to(R)) in files else p
  return m[1]+str(dest)+m[3]
 s=re.sub(r'''(from\s+["'])([^"']+)(["'])''',resolve,s)
 (O/name).write_text(s)
s=Path('/home/gwarren/projects/yale-shuttle-watcher/release-integration-data/production-replay.mts').read_text()
s=s.replace("const outDir='/home/gwarren/projects/yale-shuttle-watcher/release-integration-data';",f"const outDir='{O}';\nconst {{computeUpcomingArrivals:baselineArrivals}}=await import('{O}/baseline-arrivals.generated.mts');\nconst {{ServerEta:BaselineServerEta}}=await import('{O}/baseline-server.generated.mts');")
s=s.replace('class FocusEngine {','class FocusEngine {\n constructor(public arm:string){}')
s=s.replace('const arrivals=computeUpcomingArrivals(',"const arrivals=(this.arm==='baseline'?baselineArrivals:computeUpcomingArrivals)(")
s=s.replace("new ServerEta({routes:['Red']})","new (this.arm==='baseline'?BaselineServerEta:ServerEta)({routes:['Red']})")
s=s.replace('new FocusEngine()]','new FocusEngine(a)]')
s=s.replace("setReleaseModelEnabled(arm==='candidate')","setReleaseModelEnabled(true)")
s=s.replace("candidate.dwells['3']['11'].release=fit;","candidate.dwells['3']['11'].release=fit;\n  base.dwells['3']['11'].release=fit;")
s=s.replace("process.env.REPLAY_NAME??'integrated'","process.env.REPLAY_NAME??'full'")
s=s.replace("note:'Unrounded", "note:'BOTH arms use current production release ON. Baseline copied mechanically from current HEAD with import paths rewritten; candidate native checkout. Historical afternoon already used. Unrounded")
(O/'full_pair.mts').write_text(s)
p=dict(createdAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),baselineHead=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),baselineSources=hashes,source='Adapted existing continuous paired FocusEngine; current release ON and same causal fit refresh in BOTH arms.',purpose='Preserve prior audited development and reused afternoon regressions and compare full endpoint forecasts, both occurrences, tracking belief arrays and availability.',inputHashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [Path('/home/gwarren/projects/yale-shuttle-watcher/release-integration-data/raw-complete-frames.jsonl'),Path('/home/gwarren/projects/yale-shuttle-watcher/release-integration-data/runtime-fits-development.json')]})
(O/'FULL_PAIR_PLAN.json').write_text(json.dumps(p,indent=2)+'\n')
