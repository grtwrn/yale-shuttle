/** Physical observations only. No dependency on a route-phase reducer. */
import assert from 'node:assert/strict';
import {haversineMeters} from '../../services/shuttle-v2/src/network/legs.ts';
export const NEAR_M=75,EXIT_M=125,GAP_MS=60000,STATIONARY_MS=15000;
export type Observation={busId:number;busName:string;routeId:number;lat:number;lon:number;collectedAt:number};
export type Marker={id:number;lat:number;lon:number};
export interface Episode {
  episodeId:string;version:number;knownAt:number;bus:string;provider:number;route:number;segmentStartedAt:number;
  marker:number;enteredAt:number;entryLowerAt:number|null;lastObservedAt:number;lastWithin75At:number;
  minimumMetres:number;polls:number;nearPolls:number;movementFixes:number;
  plateau:{startedAt:number;lastAt:number;polls:number;metres:number};maxNearPlateauMs:number;maxBandPlateauMs:number;
  stationaryNearKnownAt:number|null;evidence:'stationary_fix_supported'|'possible_pass'|'uncertain';
  status:'open'|'exited'|'censored';exitLowerAt:number|null;exitAt:number|null;censorKnownAt:number|null;
  censorReason:string|null;absenceWitnessAt:number|null;contended:boolean;simultaneousNearMarkers:number[];
}
type RecordState={e:Episode;lat:number;lon:number};
type Track={last:Observation;startedAt:number;contended:boolean;active:Map<number,RecordState>};
export type Update={type:'encounter_update';episodeId:string;version:number;knownAt:number;event:string;episode:Episode};
export type Break={knownAt:number;bus:string;provider:number;route:number;lastObservedAt:number;reason:string;episodeIds:string[]};
const key=(o:Observation)=>JSON.stringify([o.busName,o.busId]);
const copy=(e:Episode):Episode=>({...e,plateau:{...e.plateau},simultaneousNearMarkers:[...e.simultaneousNearMarkers]});

export class EncounterLedger {
  private tracks=new Map<string,Track>();
  private pending=new Map<string,RecordState[]>();
  private records=new Map<string,RecordState>();
  private markers:Marker[];
  private byMarker:Map<number,Marker>;
  private lastAt=-Infinity;
  constructor(markers:Marker[]) {
    this.markers=[...markers].sort((a,b)=>a.id-b.id);this.byMarker=new Map(this.markers.map(m=>[m.id,m]));
    assert.equal(this.byMarker.size,this.markers.length);
  }
  summaries(){return [...this.records.values()].map(r=>copy(r.e));}
  stepBatch(input:readonly Observation[]):{updates:Update[];breaks:Break[]} {
    if(!input.length)return {updates:[],breaks:[]};
    const at=input[0]!.collectedAt;
    assert(input.every(o=>o.collectedAt===at));
    if(at<=this.lastAt)return {updates:[],breaks:[]};
    this.lastAt=at;
    const dedup=new Map<number,Observation>();
    for(const o of input){if(dedup.has(o.busId))assert.deepEqual(o,dedup.get(o.busId));else dedup.set(o.busId,o);}
    const group=[...dedup.values()].sort((a,b)=>a.busId-b.busId),names=new Map<string,Set<number>>();
    for(const o of group){const ids=names.get(o.busName)??new Set();ids.add(o.busId);names.set(o.busName,ids);}
    const updates:Update[]=[],breaks:Break[]=[];
    const emit=(r:RecordState,event:string)=>{
      r.e.version++;r.e.knownAt=at;
      r.e.evidence=r.e.stationaryNearKnownAt!==null?'stationary_fix_supported':r.e.movementFixes?'possible_pass':'uncertain';
      updates.push({type:'encounter_update',episodeId:r.e.episodeId,version:r.e.version,knownAt:at,event,episode:copy(r.e)});
    };
    const censor=(k:string,t:Track,reason:string)=>{
      const episodeIds:string[]=[],pending=this.pending.get(k)??[];
      for(const r of [...t.active.values()].sort((a,b)=>a.e.marker-b.e.marker)) {
        r.e.status='censored';r.e.censorKnownAt=at;r.e.censorReason=reason;r.e.simultaneousNearMarkers=[];
        episodeIds.push(r.e.episodeId);pending.push(r);emit(r,'censor');
      }
      this.pending.set(k,pending);t.active.clear();this.tracks.delete(k);
      breaks.push({knownAt:at,bus:t.last.busName,provider:t.last.busId,route:t.last.routeId,
        lastObservedAt:t.last.collectedAt,reason,episodeIds});
    };
    for(const [k,t] of [...this.tracks].sort((a,b)=>a[1].last.busId-b[1].last.busId))
      if(at-t.last.collectedAt>GAP_MS)censor(k,t,'observation_gap');
    for(const o of group) {
      const k=key(o),contended=names.get(o.busName)!.size>1;
      // A new sole provider for this name is a handoff, not a licence to
      // join or erase the previous provider's marker encounter.
      if(!contended)for(const [other,t] of [...this.tracks].sort((a,b)=>a[1].last.busId-b[1].last.busId))
        if(t.last.busName===o.busName&&t.last.busId!==o.busId)censor(other,t,'provider_change');
      let track=this.tracks.get(k);
      if(track&&track.last.routeId!==o.routeId){censor(k,track,'route_change');track=undefined;}
      if(track&&track.contended!==contended){censor(k,track,'contention_change');track=undefined;}
      const previous=track?.last;
      if(!track){track={last:o,startedAt:at,contended,active:new Map()};this.tracks.set(k,track);}
      const near:Marker[]=[];
      for(const m of this.markers) {
        // Conservative spatial index only; exact haversine decides75m.
        const latBound=NEAR_M/110000;
        const lonBound=NEAR_M/(110000*Math.max(.01,Math.cos((Math.abs(m.lat)+latBound)*Math.PI/180)));
        if(Math.abs(o.lat-m.lat)<=latBound&&Math.abs(o.lon-m.lon)<=lonBound&&haversineMeters(o,m)<=NEAR_M)near.push(m);
      }
      const nearIds=near.map(m=>m.id);
      const pending=this.pending.get(k)??[],unwitnessed:RecordState[]=[];
      for(const r of pending) {
        if(haversineMeters(o,this.byMarker.get(r.e.marker)!)>EXIT_M) {
          r.e.absenceWitnessAt=at;r.e.simultaneousNearMarkers=[...nearIds];emit(r,'absence_witness');
        } else unwitnessed.push(r);
      }
      this.pending.set(k,unwitnessed);
      for(const r of [...track.active.values()].sort((a,b)=>a.e.marker-b.e.marker)) {
        const d=haversineMeters(o,this.byMarker.get(r.e.marker)!);
        r.e.simultaneousNearMarkers=nearIds.filter(id=>id!==r.e.marker);
        if(d>EXIT_M) {
          if(r.lat!==o.lat||r.lon!==o.lon)r.e.movementFixes++;
          r.e.status='exited';r.e.exitLowerAt=r.e.lastObservedAt;r.e.exitAt=at;
          track.active.delete(r.e.marker);emit(r,'exit');continue;
        }
        const repeated=r.lat===o.lat&&r.lon===o.lon;
        r.e.polls++;r.e.lastObservedAt=at;r.e.minimumMetres=Math.min(r.e.minimumMetres,d);
        if(d<=NEAR_M){r.e.nearPolls++;r.e.lastWithin75At=at;}
        if(repeated){r.e.plateau.lastAt=at;r.e.plateau.polls++;}
        else {r.e.movementFixes++;r.e.plateau={startedAt:at,lastAt:at,polls:1,metres:d};}
        const duration=at-r.e.plateau.startedAt;
        if(d<=NEAR_M) {
          r.e.maxNearPlateauMs=Math.max(r.e.maxNearPlateauMs,duration);
          if(duration>=STATIONARY_MS&&r.e.stationaryNearKnownAt===null)r.e.stationaryNearKnownAt=at;
        } else r.e.maxBandPlateauMs=Math.max(r.e.maxBandPlateauMs,duration);
        r.lat=o.lat;r.lon=o.lon;emit(r,'observe');
      }
      for(const marker of near)if(!track.active.has(marker.id)) {
        const distance=haversineMeters(o,marker);
        const episodeId=JSON.stringify([1,o.busName,o.busId,o.routeId,track.startedAt,marker.id,at]);
        assert(!this.records.has(episodeId),'Episode identity reused');
        const e:Episode={episodeId,version:0,knownAt:at,bus:o.busName,provider:o.busId,route:o.routeId,
          segmentStartedAt:track.startedAt,marker:marker.id,enteredAt:at,entryLowerAt:previous?.collectedAt??null,
          lastObservedAt:at,lastWithin75At:at,minimumMetres:distance,polls:1,nearPolls:1,
          movementFixes:previous&&(previous.lat!==o.lat||previous.lon!==o.lon)?1:0,
          plateau:{startedAt:at,lastAt:at,polls:1,metres:distance},maxNearPlateauMs:0,maxBandPlateauMs:0,
          stationaryNearKnownAt:null,evidence:'uncertain',status:'open',exitLowerAt:null,exitAt:null,
          censorKnownAt:null,censorReason:null,absenceWitnessAt:null,contended,
          simultaneousNearMarkers:nearIds.filter(id=>id!==marker.id)};
        const r={e,lat:o.lat,lon:o.lon};track.active.set(marker.id,r);this.records.set(episodeId,r);emit(r,'enter');
      }
      track.last=o;
    }
    updates.sort((a,b)=>a.episode.provider-b.episode.provider||a.episode.marker-b.episode.marker||
      a.episodeId.localeCompare(b.episodeId)||a.version-b.version);
    return {updates,breaks};
  }
}

export function possibleEnd(e:Episode):number {
  return e.exitAt??e.absenceWitnessAt??Infinity;
}
export function barriersFor(episodes:Episode[],asof:number,arrival:number|null,targetIds:string[]) {
  return episodes.filter(e=>e.enteredAt<=(arrival??asof)&&possibleEnd(e)>asof)
    .filter(e=>e.enteredAt<=asof||!targetIds.includes(e.episodeId))
    .map(e=>({episodeId:e.episodeId,
      reason:e.enteredAt<=asof?(e.censorKnownAt!==null&&e.censorKnownAt<=asof?'censored_without_exit':'open_at_asof'):'earlier_encounter',
      entryKnownByAsOf:e.enteredAt<=asof,
      stationaryKnownByAsOf:e.stationaryNearKnownAt!==null&&e.stationaryNearKnownAt<=asof}));
}
