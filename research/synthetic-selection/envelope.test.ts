import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SUPPORTED_RELEASE,supportedRelease,initialStructure,runEpisode,type Receipt} from './envelope';
import {feed,NOW,scenario} from './fixtures';
const clock={now:()=>Date.now(),advance:async(ms:number)=>{await vi.advanceTimersByTimeAsync(ms);}};
const r=(id:string,at:number,body:any=feed(at)):Receipt=>({id,receivedAt:at,status:'ok',complete:true,body,bodySha256:'a'.repeat(64)});
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(NOW);(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  vi.stubGlobal('fetch',vi.fn(async(url:any)=>{if(url==='/api/weather')return {ok:false};throw Error('Forbidden network');}));});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
const args=()=>({scenario,scheduledAt:NOW,clock,releases:[{...SUPPORTED_RELEASE,knownAt:NOW-1}]});
describe('fixed episode input/version envelope',()=>{
  it('requires exact proven source and every captured asset hash',()=>{
    expect(supportedRelease(SUPPORTED_RELEASE)).toBe(true);
    expect(supportedRelease({...SUPPORTED_RELEASE,source:'other'})).toBe(false);
    expect(supportedRelease({...SUPPORTED_RELEASE,files:{...SUPPORTED_RELEASE.files,'assets/geo-BjWFh9tz.js':'bad'}})).toBe(false);
  });
  it('retains empty fleet and missing ETA as initial states',()=>{
    const empty=feed(NOW,[]);delete empty.server_eta;expect(initialStructure(empty)).toBe(true);
    expect(initialStructure({buses:[]})).toBe(false);expect(initialStructure(null)).toBe(false);
  });
  it('does not move the start beyond 30 seconds or use future release metadata',async()=>{
    expect((await runEpisode({...args(),receipts:[r('late',NOW+30_001)]})).status).toBe('missing_initial_response');
    expect((await runEpisode({...args(),releases:[{...SUPPORTED_RELEASE,knownAt:NOW+1}],receipts:[r('first',NOW)]})).status).toBe('unavailable_version');
  });
  it('rejects duplicate/noncausal envelopes before running the component',async()=>{
    await expect(runEpisode({...args(),receipts:[r('a',NOW+1),r('b',NOW)]})).rejects.toThrow('Noncausal'.toLowerCase());
    await expect(runEpisode({...args(),receipts:[r('a',NOW),r('a',NOW+1)]})).rejects.toThrow('receipt envelope');
  });
  it('keeps first invalid ETA, initial walk, original source and fixed horizon across recovery',async()=>{
    const first=feed(NOW);delete first.server_eta;
    const result=await runEpisode({...args(),profile:'B',receipts:[r('initial',NOW,first),r('valid',NOW+15_000)],
      releases:[...args().releases,{...SUPPORTED_RELEASE,source:'changed',knownAt:NOW+10_000}]});
    expect(result.status).toBe('decision_diagnostic');expect(result.unfinishedCaptureHorizon).toBe(true);
    expect(result.initialReceipt).toBe('initial');expect((result as any).release.source).toBe(SUPPORTED_RELEASE.source);
    expect(result.rows[0].orderedOptions[0].mode).toBe('walk');
    expect(result.rows.at(-1).at).toBe(NOW+45*60_000);
    expect(result.rows.at(-1).events.filter((e:any)=>e.type==='arm_attempt')).toHaveLength(0);
    expect(result.rows.at(-1).userLatLon).toEqual(scenario.destination);
  });
  it('fails source extraction closed before executing a changed component',()=>{
    const dir=mkdtempSync(join(tmpdir(),'selection-source-'));
    try {const source=readFileSync('web/src/TransitMap.tsx','utf8');const changed=join(dir,'TransitMap.tsx');writeFileSync(changed,source+'\n');
      expect(()=>execFileSync('node',['../../research/synthetic-selection/extract.mjs',changed],{stdio:'pipe'})).toThrow();
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});
