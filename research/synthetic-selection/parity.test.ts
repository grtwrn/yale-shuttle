import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {writeFileSync} from 'node:fs';
import {mountSelection} from './adapter';
import {feed,NOW,scenario,board,alight} from './fixtures';
import {commuteSec,topVisibleOptions} from '../../services/shuttle-v2/web/src/planner';
import {haversineMeters} from '../../services/shuttle-v2/web/src/geo';
import {walkSecFromMeters} from '../../services/shuttle-v2/web/src/walk';
import {boundary} from './boundary';

let session:any;
const records:any[]=[];
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(NOW);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  // Full TripPlanner weather effect is retained but its external request ends
  // at this synthetic sink. Any other request is an implementation gap.
  vi.stubGlobal('fetch',vi.fn(async(url:any)=>{if(url==='/api/weather')return {ok:false};throw Error(`Forbidden request: ${url}`);}));
});
afterEach(async()=>{if(session)await session.close();session=null;vi.useRealTimers();vi.unstubAllGlobals();
  writeFileSync('../../research/synthetic-selection/results/transcripts.json',JSON.stringify(records,null,2));});
const clock={now:()=>Date.now(),advance:async(ms:number)=>{await vi.advanceTimersByTimeAsync(ms);}};
const option=(s:any,label='Red')=>s.options.find((o:any)=>o.routeLabel===label);
async function parity(name:string, initial:any, events:(s:any,capture:(label:string)=>void)=>Promise<void>,profile:'A'|'B'='A',geometry=scenario){
  const streams:any[][]=[];
  for(const reference of [true,false]){
    vi.clearAllTimers();vi.setSystemTime(NOW);
    session=await mountSelection({reference,scenario:geometry,payload:initial,clock,profile});
    const rows:any[]=[];
    const capture=(label:string)=>rows.push({label,at:Date.now(),...session.snapshot()});
    capture('initial');await events(session,capture);streams.push(rows);
    await session.close();session=null;
  }
  expect(streams[1]).toEqual(streams[0]);
  records.push({name,reference:streams[0],adapter:streams[1]});
  return streams[1];
}
describe('exact TripPlanner hook extraction versus complete original component',()=>{
  it('plans from all routes and preserves the original plan across live polls',async()=>{
    const rows=await parity('complete options',feed(NOW,[{name:'301'},{name:'101',label:'Blue Day',ride:330},{name:'201',label:'Orange Day',ride:360}]),async(s,c)=>{
      expect(s.state().stableOptions.filter((o:any)=>o.mode==='shuttle')).toHaveLength(3);
      const planned=s.state().stableOptions;
      await s.advanceTo(NOW+15_000);await s.receive(feed(NOW+15_000,[{name:'302',pickup:650}]));
      expect(s.state().stableOptions).toBe(planned);
      expect(option(s.state()).boardStopId).toBe(board);expect(option(s.state()).alightStopId).toBe(alight);
      expect(s.state().stableOptions.find((o:any)=>o.routeLabel==='Red').busName).toBe('301');
      expect(option(s.state()).busName).toBe('302');c('new bus, original plan');
      const origin=s.state().fromLL;
      await s.locate({...origin,lat:origin.lat-.001});
      expect(s.state().stableOptions).toBe(planned);expect(option(s.state()).walkToSec).toBeLessThan(planned[0].walkToSec);c('walking changes remaining leg');
    });
    expect(rows[0].visibleOptions.length).toBeGreaterThanOrEqual(3);
  });
  it('replans a shuttle-less plan only when roster/freshness changes',async()=>{
    await parity('automatic roster refresh',feed(NOW,[]),async(s,c)=>{
      expect(s.state().stableOptions.map((o:any)=>o.mode)).toEqual(['walk']);
      await s.advanceTo(NOW+15_000);await s.receive(feed(NOW+15_000,[]));expect(s.state().refreshKey).toBe(0);c('same empty roster');
      await s.advanceTo(NOW+30_000);await s.receive(feed(NOW+30_000));
      expect(s.state().refreshKey).toBe(1);expect(option(s.state())).toBeDefined();c('appeared and replanned');
      await s.advanceTo(NOW+31_000);expect(s.state().refreshKey).toBe(1);c('ordinary wall tick');
    });
  });
  it.each(['different-bus','same-bus-later-visit'])('keeps countdown and boarding identities: %s',async(relation)=>{
    await parity(relation,feed(NOW,[{name:'301',pickup:300}]),async(s,c)=>{
      await s.advanceTo(NOW+15_000);
      await s.receive(feed(NOW+15_000,relation==='different-bus'?[{name:'301',pickup:100},{name:'302',pickup:700}]:[{name:'301',pickup:100,later:800}]));
      const o=option(s.state());expect(o.livePickupSelection.relation).toBe(relation);
      expect(o.livePickupSelection.countdown.busName).toBe('301');
      expect(o.livePickupSelection.boarding.busName).toBe(relation==='different-bus'?'302':'301');
      expect(o.livePickupSelection.boarding.etaSec).toBeGreaterThan(600);c('separate occurrence identities');
    });
  });
  it('preserves raw-current at-stop override and short-walk arm suppression',async()=>{
    await parity('raw current and no arm',feed(NOW,[{name:'301',pickup:0,low:0,high:0,raw:true}]),async(s,c)=>{
      expect(option(s.state()).livePickupSelection.relation).toBe('raw-current');
      expect(option(s.state()).walkToSec).toBe(0);expect(s.state().reminder).toBeNull();
      await s.advanceTo(NOW+20_000);c('still at actual origin');
      expect(s.snapshot().movement).toBeNull();expect(s.state().userLatLon).toEqual(s.state().fromLL);
      expect(s.snapshot().events.filter((e:any)=>e.type==='would_signal')).toHaveLength(0);
    },'B',{origin:{...feed().stop_coords[board],lat:feed().stop_coords[board].lat+.0002},destination:scenario.destination});
  });
  it('heads-up records state without walking; leave-now starts one walk only',async()=>{
    const rows=await parity('heads up then leave',feed(),async(s,c)=>{
      expect(s.snapshot().events.filter((e:any)=>e.type==='would_signal').map((e:any)=>e.kind)).toEqual(['heads_up']);
      expect(s.snapshot().movement).toBeNull();expect(s.state().userLatLon).toEqual(s.state().fromLL);
      await s.advanceTo(NOW+15_000);await s.receive(feed(NOW+15_000,[{name:'301',pickup:350,low:239,high:700}]));
      await s.advanceTo(NOW+16_000);c('leave decision');
      expect(s.snapshot().events.filter((e:any)=>e.type==='would_signal').map((e:any)=>e.kind)).toEqual(['heads_up','leave_now']);
      expect(s.state().reminder).toBeNull();expect(s.snapshot().movement.kind).toBe('to_board');
      await s.advanceTo(NOW+30_000);await s.receive(feed(NOW+30_000,[{name:'302',pickup:100,low:1}]));c('no second arm or leave');
      expect(s.snapshot().events.filter((e:any)=>e.type==='arm_attempt')).toHaveLength(1);
      expect(s.snapshot().events.filter((e:any)=>e.type==='start_walking')).toHaveLength(1);
      expect(s.state().userLatLon.lat).toBeLessThan(s.state().fromLL.lat);
    },'B');
    expect(rows.at(-1).fired).toEqual({headsUp:true,leaveNow:true});
  });
  it.each(['failure','missing','invalid','old','vanished'])('permanently disarms after %s and does not rearm on recovery',async(kind)=>{
    await parity(`disarm ${kind}`,feed(NOW,[{name:'301',pickup:900,low:780}]),async(s,c)=>{
      expect(s.state().reminder?.routeLabel).toBe('Red');
      await s.advanceTo(NOW+10_000);
      if(kind==='failure')await s.fail();
      else {const f=feed(NOW+10_000,kind==='vanished'?[]:undefined,kind==='old'?45_000:0);
        if(kind==='missing')delete f.server_eta;if(kind==='invalid')f.server_eta.rows[0][2]=-1;await s.receive(f);}
      await s.advanceTo(NOW+11_000);expect(s.state().reminder).toBeNull();c('permanent disarm');
      await s.advanceTo(NOW+15_000);await s.receive(feed(NOW+15_000,[{name:'301',pickup:350,low:239}]));
      await s.advanceTo(NOW+17_000);expect(s.state().reminder).toBeNull();expect(s.snapshot().movement).toBeNull();c('valid again, no rearm');
      expect(s.snapshot().events.filter((e:any)=>e.type==='arm_attempt')).toHaveLength(1);
      expect(s.snapshot().events.filter((e:any)=>e.type==='would_signal')).toHaveLength(0);
    },'B');
  });
  it('expires the actual server clock between polls without refreshing plan every second',async()=>{
    await parity('clock expiry',feed(NOW,[{name:'301',pickup:900,low:780}],10_000),async(s,c)=>{
      const plan=s.state().stableOptions, options=s.state().options;
      await s.advanceTo(NOW+34_000);expect(s.state().options).toBe(options);c('same memo aged source');
      await s.advanceTo(NOW+35_000);expect(s.state().options).not.toBe(options);
      expect(s.state().stableOptions).toBe(plan);expect(option(s.state()).etaUnavailable).toBe(true);
      expect(s.state().reminder).toBeNull();c('expired on parent wall second');
    },'B');
  });
  it('keeps ranking pending for 30 seconds of applicable recomputations',async()=>{
    const initial=[{name:'301',pickup:600,arrival:900,ride:300},{name:'101',label:'Blue Day',pickup:600,arrival:930,ride:330},{name:'201',label:'Orange Day',pickup:600,arrival:960,ride:360}];
    await parity('ranking hold',feed(NOW,initial),async(s,c)=>{
      expect(s.state().orderedOptions[0].routeLabel).toBe('Red');
      const changed=[{...initial[0],arrival:1500},{...initial[1],arrival:800},{...initial[2],arrival:1500}];
      await s.advanceTo(NOW+15_000);await s.receive(feed(NOW+15_000,changed));
      expect(s.state().rank.pending.since).toBe(NOW+15_000);expect(s.state().desiredOrder[0]).toBe('Blue Day');
      expect(s.state().orderedOptions[0].routeLabel).toBe('Red');c('pending');
      await s.advanceTo(NOW+30_000);await s.receive(feed(NOW+30_000,changed));expect(s.state().orderedOptions[0].routeLabel).toBe('Red');c('15 seconds held');
      await s.advanceTo(NOW+44_000);expect(s.state().orderedOptions[0].routeLabel).toBe('Red');
      await s.advanceTo(NOW+45_000);await s.receive(feed(NOW+45_000,changed));
      expect(s.state().orderedOptions[0].routeLabel).toBe('Blue Day');expect(s.state().rank.pending).toBeUndefined();c('30 seconds accepted');
    });
  });
  it('retains kept-third hysteresis under actual live-location changes',async()=>{
    const f=feed(NOW,[{name:'301',pickup:1200,arrival:1500,ride:300},{name:'101',label:'Blue Day',pickup:1200,arrival:1530,ride:330},{name:'201',label:'Orange Day',pickup:1200,arrival:1800,ride:500,board:105}]);
    const a=f.stop_coords[100],b=f.stop_coords[105];
    const interpolate=(fraction:number)=>({lat:a.lat+(b.lat-a.lat)*fraction,lon:a.lon+(b.lon-a.lon)*fraction});
    await parity('kept third visibility',f,async(s,c)=>{
      expect(s.state().third).toBe('Orange Day');
      // Move toward the common Red/Blue pickup: Orange's remaining walk grows.
      await s.locate(interpolate(.28));
      const sh=s.state().orderedOptions.filter((o:any)=>o.mode==='shuttle');
      const gap=commuteSec(sh[2])-commuteSec(sh[1]);
      expect(gap).toBeGreaterThan(300);expect(gap).toBeLessThan(480);
      expect(topVisibleOptions(s.state().orderedOptions,null).some((o:any)=>o.routeLabel==='Orange Day')).toBe(false);
      expect(s.state().visibleOptions.some((o:any)=>o.routeLabel==='Orange Day')).toBe(true);c('inside retain-only band');
      await s.locate(interpolate(0));expect(s.state().third).toBeNull();c('outside keep band');
      await s.locate(interpolate(.28));expect(s.state().third).toBeNull();c('no reappearance inside retain-only band');
      await s.locate(interpolate(.5));expect(s.state().third).toBe('Orange Day');c('appears inside entry band');
      await s.locate(interpolate(.28));expect(s.state().third).toBe('Orange Day');
      await s.testOnlySetDestination({...scenario.destination,lat:scenario.destination.lat+.000001});
      expect(s.state().third).toBeNull();expect(s.state().rank.pending).toBeUndefined();c('destination reset forgets retained third');
    },'A',{origin:interpolate(.5),destination:scenario.destination});
  });
  it('walk profile uses the real frozen origin and never fabricates a ride',async()=>{
    await parity('walk-only choice',feed(NOW,[]),async(s,c)=>{
      const duration=walkSecFromMeters(haversineMeters(scenario.origin,scenario.destination))*1000;
      await s.advanceTo(NOW+30_000);c('walking');
      expect(s.snapshot().movement.kind).toBe('direct');
      expect(s.state().userLatLon.lat).toBeCloseTo(scenario.origin.lat+(scenario.destination.lat-scenario.origin.lat)*30_000/duration,12);
      await s.receive(feed(NOW+30_000));expect(s.snapshot().events.filter((e:any)=>e.type==='arm_attempt')).toHaveLength(0);c('new fleet cannot replace initial walk');
    },'B');
  });
  it('keeps failed response distinct from a successful empty fleet',async()=>{
    await parity('transport failure state',feed(),async(s,c)=>{
      const before=s.state().busRoster;
      await s.advanceTo(NOW+5000);await s.fail();expect(s.state().busRoster).toBe(before);expect(s.snapshot().feed.busSnapshotFailed).toBe(true);c('failed retained roster');
      await s.receive(feed(NOW+5000,[]));expect(s.state().busRoster).not.toBe(before);expect(s.snapshot().feed.busSnapshotFailed).toBe(false);c('successful empty');
    });
  });
  it('records missing/changed armed board geometry as unresolved',async()=>{
    await parity('board geometry unresolved',feed(NOW,[{name:'301',pickup:900,low:780}]),async(s,c)=>{
      await s.advanceTo(NOW+5000);const changed=feed(NOW+5000);changed.stop_coords[board].lat+=.001;
      await s.receive(changed);expect(s.snapshot().interpretationUnresolved).toBe(true);c('changed coordinate');
      await s.advanceTo(NOW+15_000);await s.receive(feed(NOW+15_000,[{name:'301',pickup:350,low:239}]));
      await s.advanceTo(NOW+16_000);expect(s.snapshot().movement).toBeNull();c('no invented reroute');
    },'B');
  });
});
