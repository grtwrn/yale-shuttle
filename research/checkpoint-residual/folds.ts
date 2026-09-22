/** Pure fold construction. No outcomes, point fitting or evaluation labels. */
import assert from 'node:assert/strict';
import {membership,SIZES} from '../checkpoint-ensemble/membership.ts';
export const FROZEN=Date.parse('2026-09-16T04:00:00Z');
export const MAX_BANK=Date.parse('2026-09-19T04:00:00Z');
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
export const date=(at:number)=>formatter.format(new Date(at));
export function midnight(day:string){assert(/^2026-09-\d\d$/.test(day),'Frozen September dates only');return Date.parse(day+'T04:00:00Z');}
export const cutoffFor=(day:string)=>midnight(day)-86400000;
const finite=(x:any)=>typeof x==='number'&&Number.isFinite(x);
export function classify(routes:Map<number,any>,visits:any[],cutoff:number){
 const waits:any=Object.fromEntries([...routes.keys()].map(r=>[r,[]])),groups=new Map<string,any[]>();let admittedVisits=0;
 for(const v of visits){
  if(![v.arrived_at,v.departed_at,v.known_at].every(finite)||!(v.arrived_at<=v.departed_at&&v.departed_at<=v.known_at&&v.known_at<cutoff)
   ||v.how==='gap'||!['passed','stopped'].includes(v.outcome)||!finite(v.stand_sec))continue;
  assert.equal(routes.get(v.route_id)?.stops[v.stop_index],v.stop_id);
  const key=JSON.stringify([v.route_id,v.stop_index]);let vs=groups.get(key);if(!vs)groups.set(key,vs=[]);vs.push(v);admittedVisits++;
 }
 const waitStats:any[]=[];
 for(const [key,vs]of groups){
  const [route,index]=JSON.parse(key),values=vs.map(v=>v.stand_sec).sort((a,b)=>a-b),x=(values.length-1)*.75;
  const p75=values[Math.floor(x)]*(1-x%1)+values[Math.ceil(x)]*(x%1),dates=[...new Set(vs.map(v=>date(v.arrived_at)))].sort();
  const major=vs.length>=30&&dates.length>=3&&p75>=180;
  if(major)waits[route].push(index);
  waitStats.push({route,index,stop:routes.get(route).stops[index],n:vs.length,days:dates.length,dates,p75,major});
 }
 for(const ws of Object.values(waits) as number[][])ws.sort((a,b)=>a-b);
 waitStats.sort((a,b)=>a.route-b.route||a.index-b.index);
 return {cutoff,waits,waitStats,admittedVisits};
}
export function foldMaps(routes:Map<number,any>,visits:any[],preds:any[]){
 const dates=[...new Set(preds.filter(p=>p.predicted_at<MAX_BANK).map(p=>date(p.predicted_at)))].sort();
 return Object.fromEntries(dates.map(day=>[day,{date:day,...classify(routes,visits,cutoffFor(day))}]));
}
export function project(row:any,families:any[],routes:Map<number,any>,waits:any){
 const n=routes.get(row.route).stops.length,ws:number[]=waits[row.route]??[],d=(w:number)=>((row.targetIndex??-1)-w+n)%n||n;
 const wait=row.targetIndex==null||!ws.length?null:ws.reduce((a,b)=>d(b)<d(a)?b:a);
 const length=wait==null?0:Math.min(...ws.filter(w=>w!==wait).map(w=>(w-wait+n)%n),n-1);
 const targets=wait==null?[]:Array.from({length},(_,i)=>(wait+i+1)%n),result:any={};
 for(const k of SIZES)for(const extension of [false,true]){
  const id=`K${k}_${extension?'extended':'primary'}`;
  const m=wait==null||!targets.includes(row.targetIndex)?{supported:false,reason:'no fixed downstream wait/target group'}:
   {...membership(row,families,wait,k,n,extension),targetGroup:targets};
  const {sources,...rest}=m;
  result[id]=sources?{...rest,sourceIds:Object.fromEntries(Object.entries(sources).map(([j,e]:[string,any])=>[j,e.id]))}:rest;
 }
 return result;
}
