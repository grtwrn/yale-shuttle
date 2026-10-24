import { distributionDiagnostics } from './distribution-diagnostics.mjs';
import { horizonOf, widen } from '../reestimate-lib.mjs';
import { conformalFactor } from '../../web/src/eta/conformal.mjs';
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

/** Widen at the original model horizon, then age/clip exactly as a browser.
 * Aging first changes the blended runtime factor or loses a negative bound. */
export function scoreEstimate(estimate, conformal = UNIT) {
 const raw=estimate.raw??estimate,age=estimate.ageSec??0;
 const eta=Math.max(0,raw.eta-age);
 if(![raw.eta,raw.low,raw.high,age].every(Number.isFinite)||age<0||age>=45
   ||raw.low>raw.eta||raw.high<raw.eta||!forecastPipelineValid(estimate))return {...estimate,eta,low:null,high:null};
 // New protocol forecasts already contain the real runtime interval, including
 // smoothing and per-bound exemptions. Never widen it again after prediction.
 const bounds=estimate.conformalBounds??{low:true,high:true};
 const widened=widen(raw.eta,raw.low,raw.high,estimate.runtimeIntervals===true?1:conformalFactor(raw.eta,conformal));
 const low=bounds.low?widened[0]:raw.low,high=bounds.high?widened[1]:raw.high;
 return {...estimate,eta,low:Math.max(0,low-age),high:Math.max(0,high-age)};
}
function forecastPipelineValid(estimate) {
 const b=estimate.conformalBounds;
 return (estimate.forecastSource===undefined&&b===undefined)
  ||(b&&typeof b.low==='boolean'&&typeof b.high==='boolean'
   &&(estimate.forecastSource==='base'||(estimate.forecastSource==='fixed-k10'&&!b.low&&!b.high)));
}
export function calibrationObservation(row) {
 const estimate=row.challenger,raw=estimate.raw??estimate,age=estimate.ageSec??0;
 // These fixed post-processing intervals replace the base conformal output.
 // Keep their original samples in scoring; fitting a parameter that runtime
 // never applies to them would invent an improvement.
 if((estimate.conformalBounds&&(!estimate.conformalBounds.low||!estimate.conformalBounds.high))||!forecastPipelineValid(estimate))return null;
 const valid=[raw.eta,raw.low,raw.high].every(Number.isFinite)&&raw.low<=raw.eta&&raw.high>=raw.eta;
 return {r:row.r,...raw,det:valid&&Number.isFinite(row.det)&&row.det>=0&&Number.isFinite(age)&&age>=0&&age<45?row.det+age:null};
}
function controlMetadataValid(row) {
 const estimate=row.champion,c=estimate?.control;
 return Boolean(c&&[row.at,c.modelAt,c.servedAt,c.receivedAt,estimate.ageSec].every(Number.isFinite)
  &&c.modelAt<=c.servedAt&&c.servedAt-c.modelAt<45000&&c.modelAt<=row.at+5000
  &&c.receivedAt===row.at&&Math.abs(estimate.ageSec-(c.servedAt-c.modelAt)/1000)<1e-9
  &&c.r===row.r&&c.busId===row.busId&&c.busName===row.busName&&c.stop===row.stop
  &&[c.r,c.busId,c.stop].every(Number.isInteger)&&typeof c.busName==='string'
  &&Number.isInteger(c.stopsAhead)&&typeof c.label==='string'
  &&Array.isArray(c.reference)&&c.reference.length===3&&c.reference.every(Number.isFinite)
  &&c.reference[1]<=c.reference[0]&&c.reference[0]<=c.reference[2]);
}
/** Missing, unserved or mismatched control is retained and fails the gate. */
export function productionControlValid(row) {
 if(!controlMetadataValid(row)||!row.champion.raw)return false;
 const p=scoreEstimate(row.champion),c=row.champion.control,age=row.champion.ageSec;
 return [p.eta,p.low,p.high].every(Number.isFinite)
  &&Math.abs(row.champion.eta-p.eta)<1e-9
  &&(!row.h||row.h===horizonOf(p.eta,1800))
  &&[p.eta,p.low,p.high].every((v,i)=>Math.abs(v-Math.max(0,c.reference[i]-age))<=0.500001);
}
/** Bind the attestation to the retained original HTTP receipt, independently
 * of whether the shadow forecast itself matched production. */
export function productionControlInputValid(row, input) {
 if(!controlMetadataValid(row))return false;
 const c=row.champion.control,packet=input?.source,feed=c.source?packet?.feed:input?.feed,wire=feed?.server_eta,norm=s=>String(s).replace(/^#/,'');
 if(c.source){
  const s=c.source,hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  if(s.v!==1||typeof s.epoch!=='string'||!Number.isSafeInteger(s.cursor)||s.cursor<1||s.at!==c.modelAt
   ||!['chain','seedSha256','sha256','contextSha256','sourceKey','championModel','challengerModel'].every(k=>hash(s[k]))
   ||packet?.v!==1||packet.build!==s.build||packet.epoch!==s.epoch||packet.cursor!==s.cursor||packet.latest!==s.cursor||packet.hasMore!==false
   ||row.champion.runtimeIntervals!==true||!forecastPipelineValid(row.champion))return false;
 }
 if(!wire||wire.v!==2||!Array.isArray(wire.rows)||!Array.isArray(wire.buses)||!Array.isArray(feed.buses)
  ||input.receivedAt!==row.at||wire.at!==c.modelAt||wire.servedAt!==c.servedAt)return false;
 if(!feed.buses.some(b=>b.route_id===row.r&&b.bus_id===row.busId&&b.bus_name===row.busName))return false;
 return wire.rows.some(r=>{
  const bus=wire.buses[r[0]];
  return bus&&bus[1]===c.label&&norm(bus[0])===norm(row.busName)&&r[1]===row.stop&&r[5]===c.stopsAhead
   &&r.slice(2,5).every((v,i)=>v===c.reference[i]);
 });
}

/** One forecast per future bus/stop visit and reference horizon. Identity is
 * allocated before the outcome; repeat polls cannot create extra test trips. */
export function recordForecast(state, bus, stop, at, champion, challenger, phase, inputHash) {
 const h=horizonOf(champion.eta,1800);
 if(!h||champion.eta<0||!['calibration','test'].includes(phase))return;
 const base=keyOf(bus,stop),visit=state.visits[base]??={ordinal:0,latched:false};
 // The confirmation may arrive later, but its arrival time is the first
 // qualifying curb snapshot. Never create promises from already seen arrivals.
 if(visit.latched||visit.candidate)return;
 const id=`${base}|${visit.ordinal+1}|${h}`;
 if(state.pending[id])return;
 state.pending[id]={id,visitId:`${base}|${visit.ordinal+1}`,base,h,phase,day:etDay(at),r:bus.route_id,busId:bus.bus_id,busName:bus.bus_name,stop,at,inputHash,champion,challenger,
  ...(state.trial?{sourceContextId:state.id}:{})};
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
 * Tracking IDs can change and a bus can change routes within the same day.
 * Conservatively join either shared provider IDs or normalized bus names,
 * including transitive aliases seen on rows without a scored outcome. This
 * groups uncertainty only: it never joins visits or manufactures outcomes.
 * Require a negative 95% upper confidence bound on pooled WIS difference. */
export function clusteredImprovement(rows, conformal) {
 const parents=new Map(), identities=new Map();
 const root=key=>{let found=key;while(parents.get(found)!==found)found=parents.get(found);
  while(key!==found){const next=parents.get(key);parents.set(key,found);key=next;}return found;};
 for(const p of rows){
  const name=typeof p.busName==='string'?p.busName.trim().replace(/^#/,'').trim().toLowerCase():'';
  if(typeof p.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(p.day)
    ||!Number.isSafeInteger(p.busId)||p.busId<0||!name)continue;
  const id=JSON.stringify([p.day,'provider',p.busId]),label=JSON.stringify([p.day,'name',name]);
  for(const key of [id,label])if(!parents.has(key))parents.set(key,key);
  const a=root(id),b=root(label);if(a!==b)parents.set(a,b);
  identities.set(p,id);
 }
 const clusters=new Map();let unverifiedIdentityRows=0;
 for(const p of rows){
  if(!Number.isFinite(p.det))continue;
  const common={r:p.r,h:p.h,det:p.det};
  const a=validationCells([{...common,...scoreEstimate(p.champion)}],UNIT,{referenceHorizons:true})['0|all'];
  const b=validationCells([{...common,...scoreEstimate(p.challenger,conformal)}],UNIT,{referenceHorizons:true})['0|all'];
  if(!a?.scored||!b?.scored)continue;
  const identity=identities.get(p);
  if(!identity){unverifiedIdentityRows++;continue;}
  const key=root(identity);
  const c=clusters.get(key)??{day:p.day,delta:0,n:0};c.delta+=b.wis-a.wis;c.n++;clusters.set(key,c);
 }
 const blocks=[...clusters.values()];
 if(unverifiedIdentityRows)return {pass:false,clusters:blocks.length,unverifiedIdentityRows,
  reason:'Need verified day/bus identities for every scored uncertainty row.'};
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
 if(state.trial&&(!state.contextQualifiedAt||!state.contextQualification))reasons.push('Current producer context has no positive served-control qualification.');
 if(state.protocolFailures?.count)reasons.push('Observed production-control protocol failures remain in this cycle.');
 for(const p of test){
  if(ids.has(p.id))reasons.push('Duplicate forecast visit/horizon identity.');ids.add(p.id);
  if(![p.at,p.availableAt].every(Number.isFinite)||p.at<state.calibratedAt||p.at<(state.trial?.startedAt??state.startedAt)||p.availableAt<p.at||!p.inputHash)reasons.push('Invalid prospective evidence clocks or missing input receipt.');
  if(!productionControlValid(p))reasons.push('Production-control parity is missing or mismatched.');
 }
 if(!(state.champion.publishedAt<(state.trial?.startedAt??state.startedAt)))reasons.push('Champion vintage does not precede prospective collection.');
 if(!state.calibratedAt||state.calibratedAt>=Math.min(...test.map(p=>p.at)))reasons.push('Final candidate was not frozen before test predictions.');
 const perDay=closedDays.map(day=>{
  const daily=test.filter(p=>p.day===day);
  const pairs=(arm,factors)=>daily.map(p=>({r:p.r,h:p.h,det:p.det,...scoreEstimate(p[arm],factors)}));
  return {day,champion:validationCells(pairs('champion',UNIT),UNIT,{referenceHorizons:true}),challenger:validationCells(pairs('challenger',state.candidate.params.CONFORMAL),UNIT,{referenceHorizons:true})};
 });
 const decision=validationDecision(perDay,{groupingVerified:!reasons.length,availabilityVerified:!reasons.length,baselineVintageVerified:!reasons.length});
 // Every route in the training population needs its own support, including
 // weekend-only lines. A weekday-only test cannot certify a global change.
 for(const route of state.requiredRoutes)if(!decision.totals.challenger[`${route}|all`]?.scored)reasons.push(`Route ${route}: no untouched test support.`);
 const uncertainty=clusteredImprovement(test,state.candidate.params.CONFORMAL);
 if(!uncertainty.pass)reasons.push(uncertainty.reason??'Pooled WIS improvement is not supported by clustered uncertainty.');
 return {...decision,distributionDiagnostic:distributionDiagnostics(test,productionControlValid),promote:decision.promote&&!reasons.length,reasons:[...new Set([...decision.reasons,...reasons])],uncertainty,evidenceKey:identityHash({cycle:state.id,trial:state.trialSHA256??null,contexts:state.priorContexts??[],closedDays,ids:[...ids]})};
}
