import { horizonOf } from '../reestimate-lib.mjs';
import { identityHash, validationCells, validationDecision } from '../reestimate-validation.mjs';
import { haversineM } from '../canary-metrics.mjs';

export const MATCH_MS = 45 * 60000;
export const SETTLE_MS = MATCH_MS + 2 * 60000;
export const UNIT = {'0-2':1,'2-5':1,'5-10':1,'10-30':1};
export const etDay = ms => new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
export function nextDay(day) {return new Date(Date.parse(day+'T12:00:00Z')+86400000).toISOString().slice(0,10);}
export function dayStart(day) {
 for(const h of [4,5]){const t=Date.parse(`${day}T0${h}:00:00Z`);if(etDay(t)===day)return t;}
 throw Error('Invalid ET day');
}
export const keyOf = (bus,stop) => `${bus.route_id}|${bus.bus_id}|${bus.bus_name}|${stop}`;

/** One forecast per future bus/stop visit and reference horizon. Identity is
 * allocated before the outcome; repeat polls cannot create extra test trips. */
export function recordForecast(state, bus, stop, at, champion, challenger, phase, inputHash) {
 const h=horizonOf(champion.eta,1800);
 if(!h||champion.eta<0||!['calibration','test'].includes(phase))return;
 const base=keyOf(bus,stop),visit=state.visits[base]??={ordinal:0,latched:false};
 if(visit.latched)return;
 const id=`${base}|${visit.ordinal+1}|${h}`;
 if(state.pending[id])return;
 state.pending[id]={id,visitId:`${base}|${visit.ordinal+1}`,base,h,phase,day:etDay(at),r:bus.route_id,busId:bus.bus_id,busName:bus.bus_name,stop,at,inputHash,champion,challenger};
}

/** Arrival is a new, twice-observed stationary service at the named curb,
 * within the app's 75 m rule. A visit re-arms beyond 150 m. Both clocks are
 * recorded: feed observation and the time this process received the evidence. */
export function observe(state, feed, receivedAt, inputHash) {
 const resolved=[];
 for(const bus of feed.buses){
  if(!Number.isFinite(bus.observed_at)||Math.abs(receivedAt-bus.observed_at)>30000)continue;
  for(const [base,visit] of Object.entries(state.visits)) {
   if(!base.startsWith(`${bus.route_id}|${bus.bus_id}|${bus.bus_name}|`))continue;
   const stop=Number(base.split('|').at(-1)),coord=feed.stop_coords[stop];
   if(coord&&haversineM(bus,coord)>150){visit.latched=false;delete visit.candidate;}
  }
  const stop=bus.at_stop_id,coord=feed.stop_coords[stop];
  if(!coord||bus.stationary!==true||haversineM(bus,coord)>75)continue;
  const base=keyOf(bus,stop),visit=state.visits[base]??={ordinal:0,latched:false};
  if(visit.latched)continue;
  if(!visit.candidate){visit.candidate={at:bus.observed_at,receivedAt,inputHash};continue;}
  if(bus.observed_at-visit.candidate.at<9000)continue;
  const arrivedAt=visit.candidate.at,visitId=`${base}|${visit.ordinal+1}`;
  for(const p of Object.values(state.pending))if(p.visitId===visitId&&!p.closed){
   // No forecasts made after first arrival evidence are scored as forecasts.
   const wait=arrivedAt-p.at;
   p.closed=true;
   if(wait>=0&&wait<=MATCH_MS)resolved.push({...p,arrivedAt,availableAt:receivedAt,arrivalInputHash:visit.candidate.inputHash,outcomeInputHash:inputHash,det:wait/1000});
   else resolved.push({...p,availableAt:receivedAt,det:null,reason:'outside-match-window'});
  }
  for(const [id,p]of Object.entries(state.pending))if(p.visitId===visitId)delete state.pending[id];
  visit.ordinal++;visit.latched=true;delete visit.candidate;
 }
 for(const p of Object.values(state.pending))if(!p.closed&&receivedAt-p.at>SETTLE_MS){
  p.closed=true;resolved.push({...p,availableAt:receivedAt,det:null,reason:'no-service-observed'});
 }
 return resolved;
}
export function excludePending(state, now, reason) {
 const rows=[];
 for(const p of Object.values(state.pending))if(!p.closed){p.closed=true;rows.push({...p,availableAt:now,det:null,reason});}
 for(const v of Object.values(state.visits))delete v.candidate;
 return rows;
}

export function phaseAt(state, at) {
 const day=etDay(at);
 if(day<state.calibrationDays[0])return 'warming';
 if(state.calibrationDays.includes(day))return 'calibration';
 if(!state.calibratedAt||at<state.calibratedAt)return 'settling-calibration';
 return 'test';
}

/** Resample paired day/bus service blocks, rather than correlated stop rows.
 * Require a negative 95% upper confidence bound on pooled WIS difference. */
export function clusteredImprovement(rows, conformal) {
 const clusters=new Map();
 for(const p of rows){
  if(!Number.isFinite(p.det))continue;
  const common={r:p.r,h:p.h,det:p.det};
  const a=validationCells([{...common,...p.champion}],UNIT,{referenceHorizons:true})['0|all'];
  const b=validationCells([{...common,...p.challenger}],conformal,{referenceHorizons:true})['0|all'];
  if(!a?.scored||!b?.scored)continue;
  const key=`${p.day}|${p.r}|${p.busId}`;
  const c=clusters.get(key)??{day:p.day,delta:0,n:0};c.delta+=b.wis-a.wis;c.n++;clusters.set(key,c);
 }
 const blocks=[...clusters.values()];
 if(blocks.length<30)return {pass:false,clusters:blocks.length,reason:'Need at least 30 day/bus service blocks for clustered uncertainty.'};
 let seed=1729;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const days=[...new Set(blocks.map(c=>c.day))];
 const byDay=days.map(day=>blocks.filter(c=>c.day===day));
 const draws=[];
 for(let i=0;i<2000;i++){let delta=0,n=0;for(let d=0;d<days.length;d++){const selected=byDay[Math.floor(random()*days.length)];for(let j=0;j<selected.length;j++){const c=selected[Math.floor(random()*selected.length)];delta+=c.delta;n+=c.n;}}draws.push(delta/n);}
 draws.sort((a,b)=>a-b);const upper95=draws[Math.floor(draws.length*0.95)];
 return {pass:upper95<0,clusters:blocks.length,upper95WisDelta:upper95};
}

export function evaluate(state, rows, closedDays) {
 const test=rows.filter(p=>p.phase==='test'&&closedDays.includes(p.day));
 const ids=new Set();const reasons=[];
 for(const p of test){
  if(ids.has(p.id))reasons.push('Duplicate forecast visit/horizon identity.');ids.add(p.id);
  if(![p.at,p.availableAt].every(Number.isFinite)||p.at<state.calibratedAt||p.at<state.startedAt||p.availableAt<p.at||!p.inputHash)reasons.push('Invalid prospective evidence clocks or missing input receipt.');
 }
 if(!(state.champion.publishedAt<state.startedAt))reasons.push('Champion vintage does not precede prospective collection.');
 if(!state.calibratedAt||state.calibratedAt>=Math.min(...test.map(p=>p.at)))reasons.push('Final candidate was not frozen before test predictions.');
 const perDay=closedDays.map(day=>{
  const daily=test.filter(p=>p.day===day);
  const pairs=arm=>daily.map(p=>({r:p.r,h:p.h,det:p.det,...p[arm]}));
  return {day,champion:validationCells(pairs('champion'),UNIT,{referenceHorizons:true}),challenger:validationCells(pairs('challenger'),state.candidate.params.CONFORMAL,{referenceHorizons:true})};
 });
 const decision=validationDecision(perDay,{groupingVerified:!reasons.length,availabilityVerified:!reasons.length,baselineVintageVerified:!reasons.length});
 // Every route in the training population needs its own support, including
 // weekend-only lines. A weekday-only test cannot certify a global change.
 for(const route of state.requiredRoutes)if(!decision.totals.challenger[`${route}|all`]?.scored)reasons.push(`Route ${route}: no untouched test support.`);
 const uncertainty=clusteredImprovement(test,state.candidate.params.CONFORMAL);
 if(!uncertainty.pass)reasons.push(uncertainty.reason??'Pooled WIS improvement is not supported by clustered uncertainty.');
 return {...decision,promote:decision.promote&&!reasons.length,reasons:[...new Set([...decision.reasons,...reasons])],uncertainty,evidenceKey:identityHash({cycle:state.id,closedDays,ids:[...ids]})};
}
