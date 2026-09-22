import assert from 'node:assert/strict';
import {ProgressLedger} from './progress.ts';
const routes=new Map([[1,{stops:Array.from({length:12},(_,i)=>100+i)}],
                      [2,{stops:Array.from({length:12},(_,i)=>200+i)}]]);
const pin=(index:number,at:number,provider=7,route=1)=>({stopIndex:index,stopId:route*100+index,
  anchorBusId:provider,anchoredAt:at,pinnedAt:at,arrivedAt:at,closestAt:at});
const event=(p:any,departedAt:number,provider=7,route=1)=>({kind:'visit',busName:'A',busId:provider,
  routeId:route,...p,departedAt,outcome:'stopped',how:'far'});
const fresh=()=>{const x=new ProgressLedger(routes);x.reset('A',0,1);return x;};
let tests=0;
const test=(name:string,fn:()=>void)=>{fn();tests++;console.log('ok '+name);};

test('observed source stays attached to its earlier absolute occurrence',()=>{
 const x=fresh(),p=pin(0,10);x.observe('A',1,7,0,'hold',10,p);
 x.observe('A',1,7,1,'drive',20,null);
 const proof=x.proof(event(p,15),20);assert.equal(proof.supported,true);
 if(proof.supported){assert.equal(proof.progress,0);assert.equal(proof.observedAt,10);assert.equal(proof.knownAt,20);}
});
test('unresolved intermediate phases still expose a full lap',()=>{
 const x=fresh(),first=pin(0,10);x.observe('A',1,7,0,'hold',10,first);
 const a=x.proof(event(first,10),10);assert.ok(a.supported);
 for(let i=1;i<12;i++)x.observe('A',1,7,i,'drive',10+i*10,null);
 const second=pin(0,130);x.observe('A',1,7,0,'hold',130,second);
 const b=x.proof(event(second,130),130);assert.ok(b.supported);
 assert.equal(b.occurrenceEpoch,a.occurrenceEpoch);assert.equal(b.progress-a.progress,12);
});
test('explicit reset excludes delayed emissions from a prior identity epoch',()=>{
 const x=fresh(),p=pin(0,10);x.observe('A',1,7,0,'hold',10,p);
 x.reset('A',20,2);x.observe('A',1,7,0,'hold',20,p);
 assert.equal(x.proof(event(p,15),20).supported,false);
 const next=pin(0,25);x.observe('A',1,7,0,'hold',25,next);
 const good=x.proof(event(next,25),25);assert.ok(good.supported);assert.equal(good.identityEpoch,2);
});
test('provider A to B to A cannot restore the first pin',()=>{
 const x=fresh(),p=pin(0,10);x.observe('A',1,7,0,'hold',10,p);
 x.observe('A',1,8,0,'drive',20,null);x.observe('A',1,7,0,'drive',30,null);
 assert.equal(x.proof(event(p,15),30).supported,false);
});
test('ambiguous hop starts a fresh occurrence epoch rather than forcing a wrap',()=>{
 const x=fresh(),p=pin(0,10);x.observe('A',1,7,0,'hold',10,p);
 const before=x.proof(event(p,10),10);assert.ok(before.supported);
 const q=pin(6,20);x.observe('A',1,7,6,'hold',20,q);
 const after=x.proof(event(q,20),20);assert.ok(after.supported);
 assert.notEqual(after.occurrenceEpoch,before.occurrenceEpoch);assert.equal(after.progress,0);
 assert.equal(x.proof(event(p,10),20).supported,false);
});
test('gap or unknown phase cannot preserve old progress',()=>{
 for(const mode of ['gap','unknown']){
  const x=fresh(),p=pin(0,10);x.observe('A',1,7,0,'hold',10,p);
  const at=mode==='gap'?60011:20;
  x.observe('A',1,7,mode==='gap'?0:-1,'drive',at,null);
  x.observe('A',1,7,0,'drive',at,null);
  assert.equal(x.proof(event(p,10),at).supported,false);
 }
});
test('passing pin uses exact observed closest time when no rest occurred',()=>{
 const x=fresh(),p={...pin(1,10),arrivedAt:null,closestAt:12};
 x.observe('A',1,7,1,'pass',15,p);
 const result=x.proof({...event(p,12),arrivedAt:12,outcome:'passed'},20);
 assert.ok(result.supported);assert.equal(result.arrivalReference,'closest');
 assert.equal(x.proof({...event(p,13),arrivedAt:13,outcome:'passed'},20).supported,false);
});
test('unseen same-poll emission cannot manufacture an active pin',()=>{
 const x=fresh(),p=pin(0,10);x.observe('A',1,7,0,'drive',10,null);
 assert.equal(x.proof(event(p,10),10).supported,false);
 x.observe('A',1,7,0,'hold',10,event(p,10));
 assert.equal(x.proof(event(p,10),10).supported,false);
});
test('mismatched active occurrence or anchor provider stays unproven',()=>{
 for(const p of [pin(1,10),pin(0,10,8)]){
  const x=fresh();x.observe('A',1,7,0,'hold',10,p);
  assert.equal(x.proof(event(p,10),10).supported,false);
 }
});
test('repeated pin signature at different absolute positions is ambiguous',()=>{
 const x=fresh(),p=pin(0,10);x.observe('A',1,7,0,'hold',10,p);
 for(let i=1;i<12;i++)x.observe('A',1,7,i,'drive',10+i*10,null);
 x.observe('A',1,7,0,'hold',130,p);
 const proof=x.proof(event(p,130),130);assert.equal(proof.supported,false);
 if(!proof.supported)assert.equal(proof.reason,'ambiguous repeated active pin occurrence');
});
test('duplicate pre/post observation is idempotent and never advances an index twice',()=>{
 const x=fresh(),p=pin(0,10);x.observe('A',1,7,0,'hold',10,p);
 x.observe('A',1,7,0,'hold',10,p);x.observe('A',1,7,0,'hold',20,p);
 assert.equal(x.records.length,1);const proof=x.proof(event(p,20),20);
 assert.ok(proof.supported);assert.equal(proof.progress,0);assert.equal(proof.observedAt,10);
});
test('future evidence is not backdated to an earlier emission',()=>{
 const x=fresh(),p=pin(0,10);x.observe('A',1,7,0,'hold',10,p);
 x.observe('A',1,7,1,'drive',30,null);
 assert.equal(x.proof(event(p,10),20).supported,false);
 assert.throws(()=>x.observe('A',1,7,1,'drive',20,null),/backwards/);
});
test('physical time, missing identity and gap-close errors reject',()=>{
 const x=fresh(),p=pin(0,10);x.observe('A',1,7,0,'hold',10,p);
 for(const e of [{...event(p,20),busId:null,anchorBusId:null},
  {...event(p,20),arrivedAt:21},{...event(p,20),pinnedAt:null},
  {...event(p,20),how:'gap'},{...event(p,20),departedAt:31}]){
   assert.equal(x.proof(e,30).supported,false);
 }
});
test('deleting future observations preserves every earlier proof and ledger prefix',()=>{
 const replay=(end:number)=>{
  const x=fresh(),results:any[]=[];
  for(let i=0;i<end;i++){
   const at=10+i*10,p=pin(i%12,at);x.observe('A',1,7,i%12,'hold',at,p);
   results.push(x.proof(event(p,at),at));
  }return {results,records:x.records};
 };
 const full=replay(20),prefix=replay(7);
 assert.deepEqual(prefix.results,full.results.slice(0,7));
 assert.deepEqual(prefix.records,full.records.filter(r=>r.observedAt<=70));
});
console.log(JSON.stringify({progressFixtures:tests,localExecution:false}));
