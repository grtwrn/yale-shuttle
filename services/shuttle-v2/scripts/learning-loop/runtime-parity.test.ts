import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { ServerEta } from '../../src/server/serverEta';
import { ROUTE_LISTS } from '../../web/src/routes';

const fixture=JSON.parse(gunzipSync(fs.readFileSync(new URL('./__fixtures__/runtime-parity-20261027.json.gz',import.meta.url))).toString());
const frame=fixture.sourceFrame,payload=JSON.parse(frame.json);
const hash=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const purple=(wire:any)=>(wire?.rows??[]).flatMap((r:any,i:number)=>{
 const bus=wire.buses[r[0]];
 return bus[0]==='321'&&bus[1]==='Purple'?[[r.slice(1),wire.distributions[i]]]:[];
}).sort((a:any,b:any)=>a[0][0]-b[0][0]||a[0][4]-b[0][4]);
function replay(arm:'linux'|'mac'){
 expect(hash(frame.json)).toBe(frame.sha256);expect(hash(frame.contextJson)).toBe(frame.contextSha256);
 const receipt=fixture.runtimes[arm],bytes=Buffer.from(receipt.data,'base64');expect(hash(bytes)).toBe(receipt.sha256);
 const engine=new ServerEta({routes:ROUTE_LISTS.map(r=>r.label)});
 expect(engine.restoreEvaluation(gunzipSync(bytes),'runtime',frame.at)).toBe(true);
 expect(engine.useEvaluationContext(JSON.parse(frame.contextJson))).toBe(true);
 const buses=payload.buses.filter((b:any)=>b.bus_name==='#321');
 return purple(engine.contribute({...payload,buses},frame.at,frame.at,true));
}
it('preserves the independently replayed Linux trajectory through the original refused frame',()=>{
 expect(replay('linux')).toEqual(purple(payload.server_eta));
});
it('cannot repair the original incompatible history by merely restoring it on a new executable',()=>{
 // This real mismatch is retained as a negative control. A new compatible
 // runtime must start its own genuine trial, preserving the refused cohort.
 const actual=replay('mac'),expected=purple(payload.server_eta);
 expect(actual).not.toEqual(expected);
 expect(actual.length).toBe(expected.length);
 let differences=0;
 for(let i=0;i<actual.length;i++)for(let j=0;j<2;j++)for(let k=0;k<actual[i][j].length;k++)if(actual[i][j][k]!==expected[i][j][k])differences++;
 expect(differences).toBe(11);
});
