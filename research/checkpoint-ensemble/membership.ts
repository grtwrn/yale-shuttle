/** Causal, occurrence-keyed physical departures; no outcomes or fitted values. */
import {physicalReasons} from '../source-discard/observer.ts';
export const SIZES=[5,10];
const dist=(a:number,b:number,n:number)=>(b-a+n)%n;
export const sourceId=(e:any,at:number)=>JSON.stringify([e.busName,e.routeId,e.stopIndex,e.departedAt,at,e.busId]);
export class Families {
  current=new Map<string,any[]>(); epochs=new Map<string,number>(); providers=new Map<string,number>();epochBegan=new Map<string,number>();
  events:any[]=[]; resets:any[]=[]; rejected:any[]=[];
  constructor(readonly routes:Map<number,any>,readonly waits:any){}
  reset(name:string,at:number,reason:string){
    this.epochs.set(name,(this.epochs.get(name)??0)+1);this.epochBegan.set(name,at);this.current.delete(name);
    this.resets.push({name,at,reason,epoch:this.epochs.get(name)});
  }
  identity(name:string,provider:number,at:number){
    const prior=this.providers.get(name);
    if(!this.epochBegan.has(name))this.epochBegan.set(name,at);
    if(prior!==undefined&&prior!==provider)this.reset(name,at,'observed provider ID changed; physical identity unknown');
    this.providers.set(name,provider);
  }
  emission(e:any,at:number,accepted:boolean){
    const reasons=physicalReasons(e,at,this.routes);
    if(!accepted)reasons.push('not inserted into causal model history');
    if(e.anchorBusId!==e.busId)reasons.push('source anchor/emission provider differs');
    const epochBegan=this.epochBegan.get(e.busName)??at;
    if([e.pinnedAt,e.arrivedAt,e.departedAt].some(t=>t<epochBegan))reasons.push('physical source begins before experimental continuity epoch');
    if(reasons.length){this.rejected.push({name:e.busName,route:e.routeId,index:e.stopIndex,at,reasons});return;}
    const n=this.routes.get(e.routeId).stops.length;
    const event={id:sourceId(e,at),name:e.busName,route:e.routeId,index:e.stopIndex,stop:e.stopId,
      provider:e.busId,departed:e.departedAt,knownAt:at,arrived:e.arrivedAt,pinned:e.pinnedAt,
      epoch:this.epochs.get(e.busName)??0};
    this.events.push(event);let fs=this.current.get(e.busName)??[];
    for(const f of fs){
      if(f.invalid||f.route!==e.routeId)continue;
      if(at-f.sources[f.k].departed>2700000){f.invalid='required source expired45min';continue;}
      if(event.id===f.last.id)continue;
      const hop=dist(f.last.index,event.index,n);
      if(!hop||hop>5||event.departed<f.last.departed){f.invalid='ambiguous/non-forward emitted occurrence';continue;}
      const progress=f.progress+hop;
      if(f.progress<f.k&&hop!==1){f.invalid='missing middle physical source';continue;}
      f.progress=progress;f.last=event;
      if(progress<=f.k)f.sources[f.k-progress]=event;
      if(progress>=f.k&&!f.releasedAt)f.releasedAt=at;
    }
    for(const k of SIZES){
      if(k>=n)continue;const wait=(event.index+k)%n;
      if(!(this.waits[e.routeId]??[]).includes(wait))continue;
      // Multiple same-index departures remain separately identified. The query
      // resolver must prove the unique upcoming target, never pick latest index.
      fs.push({id:JSON.stringify([event.id,k,wait]),route:e.routeId,k,wait,epoch:event.epoch,
        epochBegan:this.epochBegan.get(e.busName)??at,sources:{[k]:event},progress:0,last:event,
        phaseProgress:0,phaseIndex:event.index,releasedAt:null,invalid:null});
    }
    // Expired families never revive. Keep the latest rejected family per cell
    // for honest fallback reasons while preserving every still-live traversal.
    const seen=new Set<string>();fs=fs.slice().reverse().filter(f=>{
      if(!f.invalid)return true;const cell=`${f.route}/${f.k}/${f.wait}`;
      if(seen.has(cell))return false;seen.add(cell);return true;
    }).reverse();this.current.set(e.busName,fs);
  }
  state(name:string,index:number,phase:string,at:number){
    for(const f of this.current.get(name)??[]){
      if(f.invalid)continue;
      if(at-f.sources[f.k].departed>2700000){f.invalid='required source expired45min';continue;}
      const n=this.routes.get(f.route).stops.length;
      const hop=dist(f.phaseIndex,index,n);
      if(hop>5){f.invalid='ambiguous causal phase progression';continue;}
      f.phaseProgress+=hop;f.phaseIndex=index;
      // A fixed whole group cannot continue after its first physical pickup.
      // Raw phase evidence retires it even if no strict departure is emitted.
      if(f.phaseProgress>=f.k+1){f.invalid='first fixed-group pickup reached';continue;}
      if(!f.releasedAt&&(dist(f.sources[f.k].index,index,n)>f.k||index===f.wait&&phase==='drive'))f.releasedAt=at;
    }
  }
  snapshot(name:string){return JSON.parse(JSON.stringify(this.current.get(name)??[]));}
}

export function membership(row:any,families:any[],wait:number,k:number,n:number,extension=false){
  const no=(reason:string,extra:any={})=>({supported:false,reason,...extra});
  if(!row.ready)return no('not warm/fresh');
  if(row.targetIndex==null||row.anchorIndex==null)return no('target occurrence ambiguous');
  if(row.targetIndex===wait)return no('target outside fixed downstream group');
  if(row.anchorIndex!==row.index||row.anchorIndex!==row.nearest)return no('phase/nearest/logged target anchors disagree');
  if(k>=n)return no('K outside single-occurrence loop');
  if(!(0<row.stopsAhead&&row.stopsAhead<n))return no('invalid logged target hops');
  const group=families.filter(f=>f.k===k&&f.wait===wait&&f.route===row.route);
  const possible:any[]=[];const failures:string[]=[];
  for(const f of group){
    if(f.invalid){failures.push(f.invalid);continue;}
    const hop=dist(f.last.index,row.anchorIndex,n);
    if(hop>5){failures.push('phase beyond bounded occurrence proof');continue;}
    const progress=f.progress+hop, wanted=k+dist(wait,row.targetIndex,n);
    if(wanted-progress!==row.stopsAhead)continue;
    possible.push(f);
  }
  if(possible.length!==1)return no(possible.length?'ambiguous overlapping physical traversals':failures[0]??'no confirmed same-traversal source', {plausible:possible.length});
  const f=possible[0];const sources=Object.values(f.sources) as any[];
  if(row.asof-f.epochBegan<600000)return no('experimental continuity epoch below10min', {journey:f.id});
  if(sources.some(e=>e.knownAt>row.asof||e.departed>row.began||e.departed>e.knownAt))return no('source not known before current phase', {journey:f.id});
  if(sources.some(e=>row.at-e.departed>2700000))return no('required source expired45min', {journey:f.id});
  const offsets=Object.keys(f.sources).map(Number).sort((a,b)=>a-b),m=offsets[0];
  if(offsets.some((v,i)=>v!==m+i)||offsets.at(-1)!==k)return no('noncontiguous source set');
  const after=Boolean(f.releasedAt);
  if(after&&!extension)return no('released/live', {journey:f.id});
  if(after&&m!==0)return no('release known; wait departure not strictly confirmed', {journey:f.id});
  if(!after&&m===0)return no('wait departure/release disagreement');
  const phaseHop=dist(f.last.index,row.index,n),phaseProgress=f.progress+phaseHop;
  // A hold at the next source has no departure yet. A drive from it requires
  // the actual emission; knowing the phase alone never creates an origin.
  if(phaseHop>5||phaseProgress<f.k&&(phaseProgress>f.progress+(row.phase==='hold'?1:0)))return no('passed source departure not yet emitted', {journey:f.id});
  if(row.phase==='drive'&&phaseProgress<=k&&phaseProgress>f.progress)return no('departing source not yet emitted', {journey:f.id});
  return {supported:true,reason:'same-traversal sources',journey:f.id,wait,k,offsets,
    regime:after?'post-wait':'pre-wait',releasedAt:f.releasedAt,
    sources:f.sources,progress:f.progress,queryProgress:f.progress+dist(f.last.index,row.anchorIndex,n)};
}
