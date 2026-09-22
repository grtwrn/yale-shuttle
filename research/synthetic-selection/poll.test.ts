import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createOriginalPollDriver,startReferencePollingEffect} from '../../services/shuttle-v2/web/src/__researchSelection.generated';
import {feed,NOW} from './fixtures';
import {liveAnchorStore} from '../../services/shuttle-v2/web/src/eta';
import {registerRoutePaths} from '../../services/shuttle-v2/web/src/anchor';
import {applyModelParams} from '../../services/shuttle-v2/web/src/eta/params';

beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(NOW);});
afterEach(()=>{vi.useRealTimers();});
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function harness(reference:boolean){
  liveAnchorStore.clear();registerRoutePaths({});applyModelParams(undefined);
  const writes:any[]=[],values:any={},pending:any[]=[],headers:any[]=[];
  const setters=new Proxy({}, {get:(_target,name)=> (value:any)=>{
    values[name]=typeof value==='function'?value(values[name]??{}):value;
    writes.push([name,structuredClone(values[name])]);
  }});
  const fetch=async(url:any,init:any)=>{headers.push([url,init.headers]);return await new Promise(resolve=>pending.push({resolve,signal:init.signal}));};
  let tick:any,stop:any,driver:any;
  if(reference){
    stop=startReferencePollingEffect(setters,fetch,{hidden:false,addEventListener(){},removeEventListener(){}},
      {setInterval:(callback:any)=>{tick=callback;return 1;},clearInterval(){}});
  } else {driver=createOriginalPollDriver(setters,fetch);tick=()=>{void driver.poll();};stop=()=>driver.stop();tick();}
  return {writes,values,pending,headers,tick,stop};
}
async function sequence(reference:boolean){
  const h=harness(reference),checkpoints:any[]=[];
  const respond=async(response:any)=>{h.pending.shift().resolve(response);await settle();checkpoints.push(structuredClone(h.values));};
  await respond({ok:true,json:async()=>feed()});
  h.tick();await respond({ok:false,json:async()=>{throw Error('Must not read failed response');}});
  h.tick();await respond({ok:true,json:async()=>{throw SyntaxError('Invalid JSON');}});
  h.tick();await respond({ok:true,json:async()=>({buses:null})});
  // This advances latestApplied and stamps freshness before .filter throws.
  // The original guarded catch must not set failure flags after that point.
  h.tick();await respond({ok:true,json:async()=>({buses:[null]})});
  h.tick();await respond({ok:true,json:async()=>feed(NOW,[])});
  h.stop();return {writes:h.writes,checkpoints,headers:h.headers};
}
describe('exact original parent polling closure versus complete polling effect',()=>{
  it('preserves HTTP/JSON/schema failures and post-application exception guards',async()=>{
    const reference=await sequence(true),adapter=await sequence(false);
    expect(adapter).toEqual(reference);
    for(const i of [1,2,3])expect(reference.checkpoints[i].setBusSnapshotFailed).toBe(true);
    expect(reference.checkpoints[4].setBusSnapshotFailed).toBe(false);
    expect(reference.checkpoints[4].setBusUpdateFailed).toBe(false);
    expect(reference.checkpoints[4].setBuses).toEqual(reference.checkpoints[0].setBuses);
    expect(reference.checkpoints[5].setBuses).toEqual([]);
    expect(reference.headers.every(([url,headers]:any)=>url==='/api/buses'&&Object.keys(headers).length===0)).toBe(true);
  });
  it('drops aborted earlier responses and ignores completion after cleanup',async()=>{
    const outcomes=[];
    for(const reference of [true,false]){
      const h=harness(reference);const first=h.pending.shift();h.tick();const second=h.pending.shift();
      expect(first.signal.aborted).toBe(true);
      second.resolve({ok:true,json:async()=>feed(NOW,[])});await settle();
      first.resolve({ok:true,json:async()=>feed()});await settle();
      expect(h.values.setBuses).toEqual([]);
      const n=h.writes.length;h.tick();const last=h.pending.shift();h.stop();
      expect(last.signal.aborted).toBe(true);
      last.resolve({ok:true,json:async()=>feed()});await settle();expect(h.writes).toHaveLength(n);
      outcomes.push(h.writes);
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
  });
});
