import React from '../../services/shuttle-v2/web/node_modules/react/index.js';
import {create, act} from '../../services/shuttle-v2/web/node_modules/react-test-renderer/index.js';
import {SelectionAdapter, ReferenceTripPlanner, createOriginalPollDriver, WallClock} from '../../services/shuttle-v2/web/src/__researchSelection.generated';
import {boundary} from './boundary';
import {liveAnchorStore} from '../../services/shuttle-v2/web/src/eta';
import {registerRoutePaths} from '../../services/shuttle-v2/web/src/anchor';
import {applyModelParams} from '../../services/shuttle-v2/web/src/eta/params';
import {haversineMeters} from '../../services/shuttle-v2/web/src/geo';
import {walkSecFromMeters} from '../../services/shuttle-v2/web/src/walk';
import {CURRENT_LOCATION_TEXT} from '../../services/shuttle-v2/web/src/endpoints';
import './source';

type LL = {lat:number;lon:number};
type Clock = {now:()=>number; advance:(milliseconds:number)=>Promise<void>};
export type Scenario = {origin:LL;destination:LL};
export type EventSink = {event:(event:any)=>void;flush:()=>Promise<void>};
// Synthetic-only execution. Caller supplies a deterministic global Date/timer
// clock. One session at a time because app model/path stores are module-global.
export async function mountSelection({reference=false, scenario, payload, clock, profile='A',sink,retainEvents=true}:
  {reference?:boolean;scenario:Scenario;payload:any;clock:Clock;profile?:'A'|'B';sink?:EventSink;retainEvents?:boolean}) {
  liveAnchorStore.clear(); registerRoutePaths({}); applyModelParams(undefined);
  boundary.draft = {fromText:CURRENT_LOCATION_TEXT,fromLL:{...scenario.origin},
    toText:'Synthetic destination',toLL:{...scenario.destination},tripTime:'',tripTimeSetAt:clock.now(),expandedKey:null};
  boundary.signals=[]; boundary.shown=0; boundary.permissionAttempts=0;
  const noop=()=>{};
  const props:any = {buses:[],busStatus:'loading',lastBusUpdateAt:null,busUpdateFailed:false,
    busSnapshotFailed:false,stopNames:{},stopCoords:{},routeStops:{},routePaths:{},
    segmentTimes:{},dwellTimes:{},dwellsByBus:{},routeHours:{},routeActive:{},routePeaks:{},
    userLatLon:{...scenario.origin},onRequestLocate:()=>{throw Error('Unexpected locate');},
    locating:false,locateError:null,savedTrips:[],onSaveTrip:noop,onDeleteSaved:noop,onRenameSaved:noop,
    recentTrips:[],onRecordRecent:noop,onDeleteRecent:noop,onClearRecents:noop,announcements:[],
    pendingTrip:null,onConsumePending:noop,onBoard:()=>{throw Error('Research cannot board');}};
  let read:()=>any, actions:any, root:any;
  const events:any[]=[];
  const emit=(event:any)=>{if(retainEvents)events.push(event);sink?.event(event);};
  const flush=async()=>{await sink?.flush();};
  let movement:null|{from:LL;to:LL;since:number;duration:number;kind:string}=null;
  let frozenBoard:null|{id:number;coord:LL}=null;
  let interpretationUnresolved=false;
  let chosen=false;
  let priorReminder:any=null;
  let priorFired={headsUp:false,leaveNow:false};
  let signalIndex=0;
  let priorOptions:any=undefined,priorPlan:any=undefined,priorOrdered:any=undefined,priorVisible:any=undefined;
  const setterNames={setLastBusUpdateAt:'lastBusUpdateAt',setBusUpdateFailed:'busUpdateFailed',
    setBusSnapshotFailed:'busSnapshotFailed',setBuses:'buses',setRouteStops:'routeStops',
    setStopNames:'stopNames',setSegmentTimes:'segmentTimes',setDwellTimes:'dwellTimes',
    setStopCoords:'stopCoords',setRoutePeaks:'routePeaks',setRouteActive:'routeActive',
    setRouteHours:'routeHours',setDwellsByBus:'dwellsByBus',setRoutePaths:'routePaths',setAnnouncements:'announcements'};
  const setters=Object.fromEntries(Object.entries(setterNames).map(([setter,key])=>[setter,(v:any)=>{
    props[key]=typeof v==='function'?v(props[key]):v;
  }]));
  props.__research={observe:(getter:()=>any,a:any)=>{read=getter;actions=a;}};
  const element=()=>React.createElement(WallClock,{},()=>React.createElement(reference?ReferenceTripPlanner:SelectionAdapter,props));
  let nextResponse:any;
  const poll=createOriginalPollDriver(setters,async()=>{
    if(!nextResponse)throw Error('Missing synthetic response');
    return nextResponse;
  });
  async function apply(data:any,ok=true) {
    nextResponse={ok,json:async()=>structuredClone(data)};
    const before=poll.inspect().latestApplied;
    try {await poll.poll();} finally {nextResponse=null;}
    return poll.inspect().latestApplied!==before;
  }
  // The exact original closure also retains latestApplied/abort/catch behavior.
  await apply(payload);
  await act(async()=>{root=create(element());});
  const state=()=>read();
  const move=(to:LL,kind:string,since=clock.now())=>{
    const from={...props.userLatLon};
    movement={from,to:{...to},since,duration:walkSecFromMeters(haversineMeters(from,to))*1000,kind};
    emit({at:since,type:'start_walking',kind,from,to:{...to}});
  };
  // Observe original markFired transitions and pure delivery records. Reading a
  // ref through the probe needs no extra render and cannot refresh its memo.
  const collect=()=>{
    const s=state();
    if(liveAnchorStore.size!==0)throw Error('Live replay entered the offline anchor estimator');
    if(s.options!==priorOptions || s.stableOptions!==priorPlan || s.orderedOptions!==priorOrdered || s.visibleOptions!==priorVisible){
      emit({at:clock.now(),type:'selection_update',planChanged:s.stableOptions!==priorPlan,
        ...(s.stableOptions!==priorPlan?{stableOptions:s.stableOptions}:{}),
        options:s.options,orderedOptions:s.orderedOptions,visibleOptions:s.visibleOptions,
        refreshKey:s.refreshKey,rank:structuredClone(s.rank),third:s.third,desiredOrder:s.desiredOrder});
      priorOptions=s.options;priorPlan=s.stableOptions;priorOrdered=s.orderedOptions;priorVisible=s.visibleOptions;
    }
    if (!priorFired.headsUp && s.fired.headsUp || !priorFired.leaveNow && s.fired.leaveNow) {
      const kind=!priorFired.leaveNow && s.fired.leaveNow?'leave_now':'heads_up';
      const delivery=boundary.signals[signalIndex++];
      if (!delivery) throw Error('Fired flag without pure delivery');
      emit({at:delivery.at,type:'would_signal',kind,fired:{...s.fired},message:delivery.message});
      if(profile==='B' && kind==='leave_now' && frozenBoard && !movement && !interpretationUnresolved) move(frozenBoard.coord,'to_board',delivery.at);
    }
    if(priorReminder && !s.reminder) emit({at:clock.now(),type:'disarm',reason:s.fired.leaveNow?'leave_now':'invalid_input'});
    priorReminder=s.reminder?{...s.reminder}:null; priorFired={...s.fired};
  };
  const chooseInitial=async()=>{
    if(chosen || profile==='A') return;
    chosen=true;
    const top=state().orderedOptions?.[0];
    if(!top) {emit({at:clock.now(),type:'initial_choice',result:'absent'});return;}
    emit({at:clock.now(),type:'initial_choice',routeLabel:top.routeLabel,mode:top.mode});
    if(top.mode==='walk') {move(scenario.destination,'direct');return;}
    const coord=props.stopCoords[top.boardStopId];
    if(coord) frozenBoard={id:top.boardStopId,coord:{...coord}};
    let armed=false;
    await act(async()=>{armed=actions.arm(top.routeLabel);});
    emit({at:clock.now(),type:'arm_attempt',accepted:armed,
      result:armed?'armed':top.walkToSec<60?'at_stop_no_ping':top.departed?'departed':top.etaUnavailable?'eta_unavailable':'invalid_live_input',
      routeLabel:top.routeLabel,boardStopId:top.boardStopId,alightStopId:top.alightStopId});
    if(armed && !coord) interpretationUnresolved=true;
    collect();
    if(armed && !state().reminder)emit({at:clock.now(),type:'disarm',reason:state().fired.leaveNow?'leave_now':'invalid_input',immediate:true});
  };
  collect();
  await chooseInitial();
  await flush();
  function checkBoard() {
    if(!frozenBoard || interpretationUnresolved) return;
    const c=props.stopCoords[frozenBoard.id];
    if(!c || c.lat!==frozenBoard.coord.lat || c.lon!==frozenBoard.coord.lon) {
      interpretationUnresolved=true;
      emit({at:clock.now(),type:'unresolved_board_geometry',boardStopId:frozenBoard.id});
    }
  }
  async function positionTick() {
    if(!movement) return;
    const f=movement.duration===0?1:Math.min(1,Math.max(0,(clock.now()-movement.since)/movement.duration));
    const ll={lat:movement.from.lat+(movement.to.lat-movement.from.lat)*f,
      lon:movement.from.lon+(movement.to.lon-movement.from.lon)*f};
    if(ll.lat===props.userLatLon.lat && ll.lon===props.userLatLon.lon) return;
    props.userLatLon=ll;
    await act(async()=>{root.update(element());});
  }
  return {
    state,
    snapshot:()=>structuredClone({...state(),events,feed:{lastBusUpdateAt:props.lastBusUpdateAt,busUpdateFailed:props.busUpdateFailed,
      busSnapshotFailed:props.busSnapshotFailed},movement,interpretationUnresolved}),
    async advanceTo(at:number) {
      if(at<clock.now()) throw Error('Noncausal event');
      // Settle every wall second. Large fake-timer batches would coalesce React
      // renders and silently change freshness/ranking/roster effect timing.
      while(clock.now()<at) {
        const next=Math.min(at,clock.now()+1000-(clock.now()%1000));
        await act(async()=>{await clock.advance(next-clock.now());});
        collect();
        if(next%1000===0) await positionTick();
        collect();
        await flush();
      }
    },
    async receive(data:any) {
      emit({at:clock.now(),type:await apply(data)?'feed_applied':'feed_failed',poll:poll.inspect()});
      checkBoard(); await act(async()=>{root.update(element());}); collect();
      await flush();
    },
    async fail(){await apply(null,false);emit({at:clock.now(),type:'feed_failed',poll:poll.inspect()});await act(async()=>{root.update(element());});collect();await flush();},
    async locate(ll:LL){props.userLatLon={...ll};await act(async()=>{root.update(element());});collect();},
    // Component reset parity only; the fixed prospective policy never invokes it.
    async testOnlySetDestination(ll:LL){await act(async()=>{actions.testOnlySetDestination({...ll});});collect();},
    async arm(routeLabel:string){let accepted=false;await act(async()=>{accepted=actions.arm(routeLabel);});collect();return accepted;},
    async close(){poll.stop();await act(async()=>{root.unmount();});await flush();},
  };
}
