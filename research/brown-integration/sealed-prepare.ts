import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ARMS} from '../brown-response/model.ts';
import {QueryCollector} from './sidecar.ts';
import {sealedContext,shiftFixture} from './sealed-fixtures.ts';
const out='research/brown-integration/results/sealed/';
const original=JSON.parse(fs.readFileSync('research/brown-integration/results/cases.json','utf8'));
const models=JSON.parse(fs.readFileSync(out+'models.json','utf8'));
const firstDevelopmentMidnight=Date.parse('2026-09-17T04:00:00Z'),collector=new QueryCollector();
const cases=original.cases.map((c:any)=>shiftFixture(c,
  models.rolling.manifest.validFrom+(c.at-firstDevelopmentMidnight)%86400000));
for(const c of cases)for(const f of c.frames)for(const arm of ARMS) {
  assert(f.body.server_eta.at>=models.rolling.manifest.validFrom&&f.body.server_eta.at<models.rolling.manifest.validUntil);
  collector.add(f.body,sealedContext(c,f,arm,original.topology,models));
}
fs.mkdirSync(out+'requests',{recursive:true});
for(const [i,request]of collector.all().entries())fs.writeFileSync(out+`requests/${i}.json`,JSON.stringify(request)+'\n');
fs.writeFileSync(out+'cases.json',JSON.stringify({topology:original.topology,cases,syntheticInputsOnly:true,
  actualSealedArtifacts:true,prospectiveBodiesRead:0,outcomesRead:0})+'\n');
