from pathlib import Path
import json,hashlib,subprocess,datetime
O=Path(__file__).resolve().parent;T=O.parent
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
entry=json.loads((O/'entry.json').read_text());plan=json.loads((O/'PLAN.json').read_text());head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();assert head==entry['head']==plan['base']
assert subprocess.check_output(['git','status','--porcelain'],text=True)==entry['status']==''
subprocess.run(['git','diff','--check'],check=True);subprocess.run(['git','diff','--cached','--exit-code'],check=True)
for group in ['priorFiles','reviewFiles']:
 for name,digest in entry[group].items():assert h(Path(name))==digest,(group,name)
for name,digest in plan['inputHashes'].items():assert h(Path(name))==digest,name
for n in ['current-wire.jsonl.gz','canonical-wire.jsonl.gz','current-rider-outcomes.jsonl','canonical-rider-outcomes.jsonl','rider-outcome-summary.json','decision-verification.json','resume-comparison.json']:
 assert (O/n).resolve()==(T/'cycle-15'/n).resolve()
for n in ['alignment-verification.json','verification.json','semantic-verification.json','label-comparison.json','remaining-zero-hop-inventory.json','RESULTS.md','REVIEW_REQUEST.md','RESUME.md']:
 assert (O/n).is_file(),n
s=json.loads((O/'score.json').read_text());v=json.loads((O/'verification.json').read_text());a=json.loads((O/'alignment-verification.json').read_text());assert s['counts']['scored']==v['scoredTruths']==183123;assert len(a['reviewCurrentCases'])==22 and a['counts']['reviewFollowingCases']==8
assert not any(p.suffix.lower() in ['.png','.jpg','.jpeg','.webp'] for p in O.rglob('*') if p.is_file())
images=[p for team in ['eta','ux'] for p in (T.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']];total=sum(p.stat().st_size for p in images);assert total<100*1024*1024
hashes={str(p.relative_to(O)):h(p) for p in O.rglob('*') if p.is_file() and p.name not in ['artifact-hashes.json','final-integrity.json','finish.log'] and '__pycache__' not in p.parts}
(O/'artifact-hashes.json').write_text(json.dumps(hashes,indent=2)+'\n')
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'head':head,'cleanCheckoutAndIndex':True,'priorCycle15FilesPreserved':len(entry['priorFiles']),'priorReview14FilesPreserved':len(entry['reviewFiles']),'frozenInputHashesVerified':len(plan['inputHashes']),'artifactFilesHashed':len(hashes),'newScreenshots':0,'combinedScreenshotFiles':len(images),'combinedScreenshotBytes':total,'correctedStructuralTruthRecords':v['scoredTruths'],'priorCurrentCasesAcceptedPerArm':11,'priorFollowingCasesAccepted':8,'limitations':'Builder verification of research artifacts only. Independent corrected-label review remains required; no application or release claim.'}
(O/'final-integrity.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
