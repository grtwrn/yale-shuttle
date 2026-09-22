/** Research-only adapter. The imported production reducers stay byte-identical. */
import { TransitNetwork, type RouteAnchor } from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import { traceStopLegs, haversineMeters, type TracedLeg } from '../../services/shuttle-v2/src/network/legs.ts';
import { legSlicesInOrder } from '../../services/shuttle-v2/src/network/alignStops.ts';
import { distanceMeters } from '../../services/shuttle-v2/src/network/geo.ts';
import { ANCHOR_LOOKAHEAD, ANCHOR_SLACK_M, AT_STOP_PIN_M, MOVED_M,
  MAX_HANDOFF_GAP_MS, MAX_HANDOFF_SPEED_MPS, type BusObservation, type BusState } from '../../services/shuttle-v2/src/collector/detector.ts';

type Point = {lat:number;lon:number};
export function project(slice: readonly (readonly number[])[], p: Point) {
  let best={offsetM:Infinity,alongM:0},along=0;
  const ky=111320,kx=ky*Math.cos(p.lat*Math.PI/180);
  for(let i=1;i<slice.length;i++) {
    const a=slice[i-1]!,b=slice[i]!,dx=(b[1]!-a[1]!)*kx,dy=(b[0]!-a[0]!)*ky;
    const squared=dx*dx+dy*dy;
    const t=squared ? Math.max(0,Math.min(1,((p.lon-a[1]!)*kx*dx+(p.lat-a[0]!)*ky*dy)/squared)) : 0;
    const point={lat:a[0]!+(b[0]!-a[0]!)*t,lon:a[1]!+(b[1]!-a[1]!)*t};
    const m=haversineMeters(p,point),length=haversineMeters({lat:a[0]!,lon:a[1]!},{lat:b[0]!,lon:b[1]!});
    if(m<best.offsetM)best={offsetM:m,alongM:along+t*length};
    along+=length;
  }
  return best;
}

type Certificate={bus:string;route:number;provider:number;leg:number};
export interface Decision {
  at:number;bus:string;provider:number;route:number;previous:number|null;ordinary:number|null;
  selected:number|null;leg:number|null;protected:boolean;retained:boolean;reason:string;
  previousProjection?:ReturnType<typeof project>;projection?:ReturnType<typeof project>;
  advanceM?:number;displacementM?:number;gapMs?:number;
}
export class DirectedGuard {
  readonly network:TransitNetwork;
  private legs=new Map<number,TracedLeg[]>();
  private certificates=new Map<string,Certificate>();
  private selected=new WeakMap<object,RouteAnchor>();
  constructor(private base:TransitNetwork) {
    for(const [id,r] of base.routes) {
      const stops=r.stops.map(s=>base.stops.get(s));
      if(stops.some(s=>!s))continue;
      let legs=traceStopLegs(r.path,[...stops,stops[0]!]);
      if(legs.some(l=>l.bridged)) {
        const slices=legSlicesInOrder(r.path,stops);
        if(slices?.length===r.stops.length)legs=slices.map(slice=>({slice,bridged:false}));
      }
      if(legs.length===r.stops.length)this.legs.set(id,legs);
    }
    this.network=new Proxy(base,{get:(target,property)=>{
      if(property==='nearestStopOnRoute')return (id:number,p:Point,max=Infinity)=>{
        const override=this.selected.get(p);
        return override && override.meters<=max ? override : target.nearestStopOnRoute(id,p,max);
      };
      if(property==='nearestStopAheadOnRoute')return (id:number,p:Point,index:number,lookahead:number)=>
        this.selected.get(p) ?? target.nearestStopAheadOnRoute(id,p,index,lookahead);
      const value=Reflect.get(target,property,target);
      return typeof value==='function' ? value.bind(target) : value;
    }});
  }
  prepare(key:string,prev:BusState|undefined,o:BusObservation,contended=false):Decision {
    this.selected.delete(o);
    const global=this.base.nearestStopOnRoute(o.routeId,o);
    const ahead=prev && prev.routeId===o.routeId
      ? this.base.nearestStopAheadOnRoute(o.routeId,o,prev.nearestIndex,ANCHOR_LOOKAHEAD):null;
    const ordinary=ahead && global && ahead.meters<=global.meters+ANCHOR_SLACK_M ? ahead:global;
    const d:Decision={at:o.collectedAt,bus:o.busName,provider:o.busId,route:o.routeId,
      previous:prev?.nearestIndex??null,ordinary:ordinary?.index??null,selected:ordinary?.index??null,
      leg:null,protected:false,retained:false,reason:'no_prior'};
    const fail=(reason:string)=>{this.certificates.delete(key);d.reason=reason;return d;};
    if(!prev)return fail('no_prior');
    if(contended) {
      // planTracks temporarily changes keys for a contended name. Clear its
      // unqualified certificate too, so it cannot reappear after contention.
      for(const [other,c] of this.certificates)if(c.bus===o.busName)this.certificates.delete(other);
      return fail('contended_name');
    }
    if(prev.routeId!==o.routeId)return fail('route_change');
    if(prev.busId!==o.busId)return fail('provider_change');
    const gap=o.collectedAt-prev.lastObservedAt;d.gapMs=gap;
    // Older/duplicate polls must not erase an otherwise valid certificate.
    if(gap<=0){d.reason='not_newer';return d;}
    if(gap>MAX_HANDOFF_GAP_MS)return fail('observation_gap');
    const route=this.base.routes.get(o.routeId),n=route?.stops.length??0;
    if(!route || !ordinary || !n)return fail('unknown_route');
    const prior=this.certificates.get(key);
    const previousCertificate=prior && prior.route===o.routeId && prior.provider===o.busId
      && [prior.leg,(prior.leg+1)%n].includes(prev.nearestIndex) ? prior:null;
    const index=previousCertificate?.leg??prev.nearestIndex;
    d.leg=index;
    const leg=this.legs.get(o.routeId)?.[index];
    if(!leg || leg.bridged)return fail('unusable_leg');
    const p0=project(leg.slice,prev),p1=project(leg.slice,o);
    d.previousProjection=p0;d.projection=p1;
    if(p0.offsetM>AT_STOP_PIN_M || p1.offsetM>AT_STOP_PIN_M)return fail('outside_current_leg');
    const repeated=prev.lat===o.lat && prev.lon===o.lon;
    const advance=p1.alongM-p0.alongM,displacement=distanceMeters(prev,o);
    d.advanceM=advance;d.displacementM=displacement;
    if(repeated) {
      if(!previousCertificate)return fail('repeat_without_certificate');
    } else {
      if(displacement<=MOVED_M || advance<=MOVED_M)return fail('no_forward_motion');
      const max=MAX_HANDOFF_SPEED_MPS*(gap/1000)+2*MOVED_M;
      if(advance>max || displacement>max)return fail('implausible_motion');
    }
    const end=(index+1)%n;
    const wouldRewindEndpoint=prev.nearestIndex===end&&ordinary.index===index;
    if((ordinary.index===index || ordinary.index===end)&&!wouldRewindEndpoint) {
      if(previousCertificate){this.certificates.set(key,previousCertificate);d.retained=true;}
      d.reason='ordinary_endpoint';return d;
    }
    const candidates=[index,end].filter(i=>!(prev.nearestIndex===end && i===index))
      .map(i=>({index:i,stopId:route.stops[i]!,meters:distanceMeters(o,this.base.stops.get(route.stops[i]!)!)}))
      .sort((a,b)=>a.meters-b.meters);
    const selected=candidates[0]!;
    this.certificates.set(key,{bus:o.busName,route:o.routeId,provider:o.busId,leg:index});
    this.selected.set(o,selected);
    return {...d,selected:selected.index,protected:true,retained:true,reason:'directed_leg_protected'};
  }
}
