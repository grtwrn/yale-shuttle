from pathlib import Path
import subprocess, hashlib, json
O=Path(__file__).resolve().parent
E=O.parent.parent/'eta'
R=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
path='services/shuttle-v2/web/src/TransitMap.tsx'
head=subprocess.check_output(['git','show','HEAD:'+path],cwd=R,text=True)
current=(R/path).read_text()
def block(s):
 a=s.index('    return stableOptions.map((o) => {', s.index('const options: TripOption[] | null'))
 b=s.index('\n    // eslint-disable-next-line', a)
 return s[a:b]
old=(E/'cycle-10/shell-current.generated.mts').read_text()
a=old.index('    return stableOptions.map((o) => {');b=old.index('\n };',a)
assert old[a:b]==block(head), 'current HEAD must match reviewed numerical comparator'
for name,source in [('baseline',head),('candidate',current)]:
 generated=old[:a]+block(source)+old[b:]
 if name=='candidate':
  generated="import { forecastPickupSelection, rawPickupSelection } from '"+str(R/'services/shuttle-v2/web/src/livePickupSelection.ts')+"';\n"+generated
 (O/(name+'.generated.mts')).write_text(generated)
assert block(current)==block((E/'cycle-11/TransitMap.tsx').read_text()), 'candidate projection must equal reviewed ETA block'
assert (R/'services/shuttle-v2/web/src/livePickupSelection.ts').read_bytes()==(E/'cycle-11/livePickupSelection.ts').read_bytes()
script=(E/'cycle-11/audit.mts').read_text().replace("'../cycle-10/shell-current.generated.mts'", "'./baseline.generated.mts'").replace("'./shell-candidate.generated.mts'", "'./candidate.generated.mts'")
script=script.replace("A=O+'../';", "A='"+str(E)+"/';")
(O/'audit.mts').write_text(script)
(O/'source-parity.json').write_text(json.dumps({'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=R,text=True).strip(),'baseEqualsReviewedArithmetic':True,'candidateEqualsReviewedProjection':True,'helperEqualsReviewedProjection':True,'numericalBlockSha256':hashlib.sha256(block(current).encode()).hexdigest()},indent=2)+'\n')
print('Current production numerical block and candidate reviewed ETA projection match exactly')
