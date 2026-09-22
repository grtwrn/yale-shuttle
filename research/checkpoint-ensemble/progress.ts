/** Observed forward occurrences, independent of which visits later complete.
 *
 * Call reset at every causal identity/reset boundary. Observe actual active
 * pre/post reducer states at their own lastObservedAt, never at a later poll
 * just because an old object is still retained. Index is active pass.stopIndex
 * (including a passing pass), otherwise transit.fromIndex. Do not construct an
 * active pass from an emitted/finalized visit to manufacture its provenance.
 * This records observed occurrence continuity, not physical vehicle identity
 * or proof that an unobserved real-world movement was impossible.
 */
type Epoch = number | string;
type Route = {stops: number[]};
type State = {
  identityEpoch: Epoch; occurrenceEpoch: string; beganAt: number;
  route: number | null; provider: number | null; index: number | null;
  progress: number; lastAt: number; phase: string | null;
};
export type PinProof = {
  supported: true; name: string; route: number; provider: number; index: number;
  anchoredAt: number; pinnedAt: number; arrivedAt: number;
  identityEpoch: Epoch; occurrenceEpoch: string; progress: number;
  occurrenceBeganAt: number; observedAt: number; arrivalReference: 'rest' | 'closest';
};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const integer=(v:unknown):v is number=>finite(v)&&Number.isInteger(v)&&v>=0;
const epochValid=(v:unknown):v is Epoch=>integer(v)||typeof v==='string'&&v.length>0;
const signature=(name:string,route:number,provider:number,index:number,anchor:number,pin:number,arrival:number)=>
  JSON.stringify([name,route,provider,index,anchor,pin,arrival]);

export class ProgressLedger {
  readonly records: PinProof[]=[];
  readonly resets: any[]=[];
  readonly rejections: any[]=[];
  private states=new Map<string,State>();
  private generations=new Map<string,number>();
  private pins=new Map<string,Map<string,PinProof>>();
  constructor(readonly routes:Map<number,Route>){}

  private fresh(name:string,at:number,identityEpoch:Epoch,reason:string,
                route:number|null=null,provider:number|null=null,index:number|null=null):State {
    const generation=(this.generations.get(name)??0)+1;
    this.generations.set(name,generation);
    const state:State={identityEpoch,occurrenceEpoch:JSON.stringify([name,identityEpoch,generation]),
      beganAt:at,route,provider,index,progress:0,lastAt:at,phase:null};
    this.states.set(name,state);
    this.resets.push({name,at,identityEpoch,occurrenceEpoch:state.occurrenceEpoch,reason});
    return state;
  }

  reset(name:string,at:number,identityEpoch:Epoch){
    if(typeof name!=='string'||!name||!finite(at)||!epochValid(identityEpoch))throw Error('Invalid progress reset');
    const previous=this.states.get(name);
    if(previous&&at<previous.lastAt)throw Error('Progress reset moved backwards in time');
    return {...this.fresh(name,at,identityEpoch,'explicit causal identity/reset boundary')};
  }

  observe(name:string,route:number,provider:number,index:number,phase:string,at:number,pass:any|null){
    const reject=(reason:string)=>{this.rejections.push({name,route,provider,index,at,reason});return {supported:false,reason};};
    let state=this.states.get(name);
    if(!state)return reject('no explicit identity epoch');
    if(!finite(at)||at<state.lastAt)throw Error('Progress observation moved backwards or has invalid clock');
    if(!integer(route)||!integer(provider)||!this.routes.has(route)){
      this.fresh(name,at,state.identityEpoch,'unknown route/provider');
      return reject('unknown route/provider');
    }
    const n=this.routes.get(route)!.stops.length;
    if(!integer(index)||index>=n||typeof phase!=='string'||!phase){
      this.fresh(name,at,state.identityEpoch,'unknown phase index',route,provider);
      return reject('unknown phase index');
    }
    if((state.route!==null&&state.route!==route)||(state.provider!==null&&state.provider!==provider)){
      state=this.fresh(name,at,state.identityEpoch,'route/provider changed without retained continuity',route,provider,index);
    }else if(at-state.lastAt>60_000){
      state=this.fresh(name,at,state.identityEpoch,'observation gap above60s',route,provider,index);
    }else if(state.index!==null){
      const hop=(index-state.index+n)%n;
      if(hop>5)state=this.fresh(name,at,state.identityEpoch,'ambiguous forward hop above5',route,provider,index);
      else state.progress+=hop;
    }
    state.route=route;state.provider=provider;state.index=index;state.lastAt=at;state.phase=phase;
    if(pass===null||pass===undefined)return {supported:true,reason:'observed index without physical pin',...state};
    if(pass.kind==='visit')return reject('emitted visit is not an active pass');
    if(pass.stopIndex!==index||pass.stopId!==this.routes.get(route)!.stops[index])return reject('active pass disagrees with observed occurrence');
    if(!integer(pass.anchorBusId)||pass.anchorBusId!==provider)return reject('active pin has another anchor provider');
    const arrival=pass.arrivedAt??pass.closestAt;
    const times=[pass.anchoredAt,pass.pinnedAt,arrival];
    if(!times.every(finite))return reject('active pass lacks finite anchor/pin/arrival reference');
    if(times.some(t=>t<state!.beganAt||t>at))return reject('active pass physical times outside current observed epoch');
    // The collector can resume a pin/rest clock from earlier raw fixes. Match
    // its exact fields; do not invent an anchor<=pin condition it does not use.
    const key=signature(name,route,provider,index,pass.anchoredAt,pass.pinnedAt,arrival);
    let candidates=this.pins.get(key);
    if(!candidates)this.pins.set(key,candidates=new Map());
    const occurrence=JSON.stringify([state.occurrenceEpoch,state.progress]);
    if(!candidates.has(occurrence)){
      const record:PinProof={supported:true,name,route,provider,index,
        anchoredAt:pass.anchoredAt,pinnedAt:pass.pinnedAt,arrivedAt:arrival,
        identityEpoch:state.identityEpoch,occurrenceEpoch:state.occurrenceEpoch,
        progress:state.progress,occurrenceBeganAt:state.beganAt,observedAt:at,
        arrivalReference:pass.arrivedAt===null||pass.arrivedAt===undefined?'closest':'rest'};
      candidates.set(occurrence,record);this.records.push(record);
    }
    return {supported:true,reason:'observed active pin',...state};
  }

  proof(event:any,knownAt:number):({supported:false;reason:string}|(PinProof&{knownAt:number;departedAt:number})) {
    const no=(reason:string)=>({supported:false as const,reason});
    if(!event||event.kind!=='visit'||typeof event.busName!=='string')return no('not a visit emission');
    const state=this.states.get(event.busName);
    if(!state)return no('no observed identity epoch');
    if(!finite(knownAt)||knownAt<state.lastAt)return no('emission precedes observed evidence');
    if(knownAt-state.lastAt>60_000)return no('emission lacks fresh occurrence observation');
    if(!integer(event.routeId)||!integer(event.busId)||!integer(event.anchorBusId)
       ||event.busId!==event.anchorBusId||event.routeId!==state.route||event.busId!==state.provider)
      return no('emission route/provider differs from active continuity epoch');
    const seq=this.routes.get(event.routeId)?.stops;
    if(!seq||!integer(event.stopIndex)||event.stopIndex>=seq.length||seq[event.stopIndex]!==event.stopId)return no('emission occurrence mismatch');
    if(!['stopped','passed'].includes(event.outcome)||event.how===null||event.how===undefined||event.how==='gap')
      return no('emission is unresolved or gap-closed');
    const times=[event.anchoredAt,event.pinnedAt,event.arrivedAt,event.departedAt];
    if(!times.every(finite)||times.some(t=>t<state.beganAt||t>knownAt))return no('emission physical times outside current observed epoch');
    if(event.arrivedAt>event.departedAt)return no('emission physical times are out of order');
    const key=signature(event.busName,event.routeId,event.busId,event.stopIndex,event.anchoredAt,event.pinnedAt,event.arrivedAt);
    const candidates=[...(this.pins.get(key)?.values()??[])].filter(p=>
      p.identityEpoch===state.identityEpoch&&p.occurrenceEpoch===state.occurrenceEpoch&&p.observedAt<=knownAt);
    if(candidates.length!==1)return no(candidates.length?'ambiguous repeated active pin occurrence':'exact active pin was never observed in current epoch');
    const pin=candidates[0];
    if(pin.progress>state.progress)return no('pin lies beyond current observed progress');
    return {...pin,knownAt,departedAt:event.departedAt};
  }
}
