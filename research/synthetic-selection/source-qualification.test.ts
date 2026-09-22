import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {ACTIVE_PROOF,ACTIVE_QUALIFICATION} from './source';
import {BASELINE_SOURCE,CURRENT_SOURCE,qualification,sourceProof,assertLoadedSource} from './source-versions.mjs';
import {SUPPORTED_RELEASE,supportedRelease} from './envelope';
import {worthwhileOverviewOption,topVisibleOptions,type TripOption} from '../../services/shuttle-v2/web/src/planner';
import {PLACE_ICONS,suggIcon} from '../../services/shuttle-v2/web/src/format';
import {LANDMARKS} from '../../services/shuttle-v2/src/server/landmarks';
import {mountSelection} from './adapter';
import {feed,NOW,board,alight} from './fixtures';

const current=ACTIVE_QUALIFICATION.source===CURRENT_SOURCE;
const other=sourceProof(current?BASELINE_SOURCE:CURRENT_SOURCE);
const identity=(p:any)=>({source:p.source,webTree:p.webTree,files:Object.fromEntries(Object.entries(p.files).map(([k,v]:any)=>[k,v.sha256]))});
const shuttle=(walk:number):TripOption=>({mode:'shuttle',routeLabel:'Green',color:'#000',boardStopId:board,alightStopId:alight,
  walkToSec:300,walkFromSec:walk-300,directWalkSec:1800,rideSec:60,plannedRideSec:60,waitSec:0,totalSec:walk+60,busName:'301'});
const walk:TripOption={...shuttle(1800),mode:'walk',routeLabel:'Walk',totalSec:1800};

describe('explicit source-specific release qualification',()=>{
  it('defaults to the immutable original source and rejects unlisted versions',()=>{
    expect(qualification(BASELINE_SOURCE).webTree).toBe('39e7e9738975f45dfb5c443cc99961a39e9aa4ef');
    for(const source of ['other','e7784c03b8c7','b00823130aa5e4fcf795b24c44ab7d1859953ca6'])expect(()=>qualification(source)).toThrow('Unsupported');
    expect(()=>execFileSync('node',['../../research/synthetic-selection/extract.mjs'],{env:{...process.env,SELECTION_SOURCE:'unknown'},stdio:'pipe'})).toThrow();
  });
  it('cannot apply another qualified version to the loaded component',()=>{
    expect(supportedRelease(SUPPORTED_RELEASE)).toBe(true);
    expect(supportedRelease(identity(other))).toBe(false);
    expect(()=>assertLoadedSource(other,ACTIVE_QUALIFICATION)).toThrow('Loaded frontend');
    expect(()=>execFileSync('node',['../../research/synthetic-selection/extract.mjs'],{env:{...process.env,SELECTION_SOURCE:other.source},stdio:'pipe'})).toThrow();
  });
  it('rejects missing, additional and mismatched bundle members',()=>{
    const changed=structuredClone(SUPPORTED_RELEASE);delete changed.files['index.html'];
    expect(supportedRelease(changed)).toBe(false);
    expect(supportedRelease({...SUPPORTED_RELEASE,files:{...SUPPORTED_RELEASE.files,'extra.js':'0'.repeat(64)}})).toBe(false);
    expect(supportedRelease({...SUPPORTED_RELEASE,webTree:other.webTree})).toBe(false);
  });
  it('pins icon and aliases without introducing a geocoder into coordinate scenarios',()=>{
    const landmark=LANDMARKS.find(x=>x.label==='MakeHaven');
    if(current){
      expect(landmark).toMatchObject({lat:41.3050228,lon:-72.92366,aliases:['make haven','770 chapel'],poi:'hackerspace'});
      expect(PLACE_ICONS.hackerspace).toBe('🛠️');
      expect(suggIcon({display_name:'MakeHaven',lat:41.3050228,lon:-72.92366,type:'hackerspace',class:'yale'})).toBe('🛠️');
    }else{expect(landmark).toBeUndefined();expect(PLACE_ICONS.hackerspace).toBeUndefined();}
  });
});

describe('actual version-specific walking filter exports',()=>{
  it.each([900,901,1080,1200,1201])('checks exact half and two-thirds boundaries: %s seconds',seconds=>{
    const option=shuttle(seconds),all=[option,walk],before=JSON.stringify(all);
    const expected=current?seconds<=900:seconds<=1200;
    expect(worthwhileOverviewOption(option)).toBe(expected);
    expect(topVisibleOptions(all,'Green')).toEqual(expected?all:[walk]);
    expect(topVisibleOptions([{...option,totalSec:1,busEtaSec:1},walk],'Green').some(o=>o.mode==='shuttle')).toBe(expected);
    expect(JSON.stringify(all)).toBe(before);
  });
});

let session:any;
const clock={now:()=>Date.now(),advance:async(ms:number)=>{await vi.advanceTimersByTimeAsync(ms);}};
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(NOW);(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  vi.stubGlobal('fetch',vi.fn(async(url:any)=>{if(url==='/api/weather')return {ok:false};throw Error('Forbidden external request');}));});
afterEach(async()=>{if(session)await session.close();session=null;expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();vi.unstubAllGlobals();});
it('compares actual component visibility for a fixed short leg surrounded by sixty percent walking',async()=>{
  // Geometry fixed in advance: static stop 100 -> static stop 105, with
  // origin/destination 0.75 leg lengths beyond each endpoint. No ETA fitting.
  const initial=feed(NOW,[{name:'301',pickup:900,arrival:930,ride:30}]);
  const a=initial.stop_coords[board],b=initial.stop_coords[105];
  const point=(t:number)=>({lat:a.lat+(b.lat-a.lat)*t,lon:a.lon+(b.lon-a.lon)*t});
  initial.stop_coords[alight]={...b};
  const scenario={origin:point(-.75),destination:point(1.75)},streams=[];
  for(const reference of [true,false]){
    vi.setSystemTime(NOW);session=await mountSelection({reference,scenario,payload:initial,clock,profile:'A'});
    const rows=[];
    for(const offset of [0,15000,30000]){
      if(offset){await session.advanceTo(NOW+offset);const next=structuredClone(initial);next.server_eta.at=NOW+offset;next.server_eta.servedAt=NOW+offset;await session.receive(next);}
      const s=session.state(),option=s.options.find((o:any)=>o.mode==='shuttle');
      expect(option).toBeDefined();
      const direct=s.options.find((o:any)=>o.mode==='walk').totalSec;
      expect((option.walkToSec+option.walkFromSec)/direct).toBeGreaterThan(.5);
      expect((option.walkToSec+option.walkFromSec)/direct).toBeLessThan(2/3);
      expect(s.stableOptions.some((o:any)=>o.mode==='shuttle')).toBe(true);
      expect(s.visibleOptions.some((o:any)=>o.mode==='shuttle')).toBe(!current);
      rows.push(session.snapshot());
    }
    streams.push(rows);await session.close();session=null;
  }
  expect(streams[1]).toEqual(streams[0]);
  writeFileSync('../../research/synthetic-selection/results/source-boundary-parity.json',JSON.stringify({source:ACTIVE_PROOF.source,reference:streams[0],adapter:streams[1]},null,2));
});
