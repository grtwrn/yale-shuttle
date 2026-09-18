from pathlib import Path
import json,hashlib,subprocess,datetime
O=Path(__file__).resolve().parent;E=O.parent;plan=json.loads((O/'PLAN.json').read_text());now=datetime.datetime.now(datetime.timezone.utc).isoformat()
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==plan['base']
for args in [['git','diff','--check'],['git','diff','--exit-code'],['git','diff','--cached','--exit-code']]:subprocess.run(args,check=True)
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
score=json.loads((O/'score.json').read_text());resume=json.loads((O/'resume-comparison.json').read_text());verify=json.loads((O/'verification.json').read_text());decision=json.loads((O/'decision-summary.json').read_text());metas={a:json.loads((O/(a+'-meta.json')).read_text()) for a in ['current','canonical']};assert all(m['polls']==6000 for m in metas.values());assert all(r['exactPolls']==100 for r in resume.values())
decisionProof=json.loads((O/'decision-verification.json').read_text());assert decisionProof['counts']['pairedDecisions']==decision['pairedDecisions'];assert decisionProof['cautionField']=='journeyArrival.catchRisk'
semantic=json.loads((O/'semantic-verification.json').read_text());assert semantic['sameBackwardEventIdentities'];assert semantic['rawWireAndPhysicalOccurrenceChecks']['current:wireAndCumulativeOccurrence']==verify['scoredTruths'];assert semantic['rawWireAndPhysicalOccurrenceChecks']['canonical:wireAndCumulativeOccurrence']==verify['scoredTruths']
provenance=json.loads((O/'build-provenance.json').read_text())
for arm,h in provenance['bundles'].items():assert hashlib.sha256((O/(arm+'.mjs')).read_bytes()).hexdigest()==h
extract=json.loads((O/'shell-extraction.json').read_text());assert hashlib.sha256(Path(extract['source']).read_bytes()).hexdigest()==extract['sourceHash']
images=[p for team in ['eta','ux'] for p in (E.parent/team).rglob('*') if p.is_file() and p.suffix.lower() in ['.png','.jpg','.jpeg','.webp']];imageBytes=sum(p.stat().st_size for p in images);assert imageBytes<100*1024*1024
files=[p for p in O.rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.name not in ['artifact-hashes.json','final-integrity.json']];hashes={str(p.relative_to(O)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files};(O/'artifact-hashes.json').write_text(json.dumps(hashes,indent=2)+'\n')
result={'at':now,'head':plan['base'],'cleanCheckoutAndIndex':True,'artifactFilesHashed':len(hashes),'imagesBothTeams':len(images),'imageBytesBothTeams':imageBytes,'newScreenshots':0,'pairedPolls':score['counts']['polls'],'resumePolls':sum(r['exactPolls'] for r in resume.values()),'truthChecks':verify['scoredTruths'],'riderDecisions':decision['pairedDecisions']};(O/'final-integrity.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
