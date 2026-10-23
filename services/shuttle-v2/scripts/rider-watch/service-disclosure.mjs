// Independent operator expectation from Yale's published service policy.
// Keep this separate from the product's pickupService helper: a rendering or
// policy regression must not become the observer's expected behavior too.
// Verified 2026-10-23 against the official West Campus and Dispatch pages.
const eastern = new Intl.DateTimeFormat('en-CA', {
 timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'
});
export const PICKUP_DISCLOSURE_CONFIRM_MS=5000;
export const PICKUP_DISCLOSURE_MAX_GAP_MS=150000;
export function publishedPickupRequirement(routeLabel,stopId,at){
 if(routeLabel!=='Purple'||![121,122].includes(stopId)||!Number.isFinite(at)||!Number.isFinite(new Date(at).valueOf()))return null;
 const parts=Object.fromEntries(eastern.formatToParts(new Date(at)).map(p=>[p.type,p.value]));
 if(Number(parts.hour)<12)return null;
 return {id:'purple-union-after-noon',routeLabel,stopId,serviceDate:[parts.year,parts.month,parts.day].join('-'),timeZone:'America/New_York',
  source:'https://your.yale.edu/campus-essentials/getting-around-campus/using-the-shuttle/west-campus-shuttle',
  contact:'https://your.yale.edu/campus-essentials/getting-around-campus/using-the-shuttle/contact-us'};
}
const dispatchLink=href=>/^tel:\+?1?2032815470(?:[;,].*)?$/i.test(String(href).replace(/[().\s-]/g,''));
export function auditPickupDisclosure({routeLabel,stopId,at,rows,text=''}){
 const policy=publishedPickupRequirement(routeLabel,stopId,at);
 if(!policy)return {state:'not-required',policy:null};
 const row=rows.find(r=>r.visible!==false&&r.routeLabel===routeLabel&&r.stopId===stopId);
 if(!row)return {state:'unassessed',policy,reason:'selected-pickup-row-unavailable'};
 const issues=[];
 if(!/\bOn request\b/i.test(row.text??''))issues.push('request-only-label-missing');
 if(!/\bDispatch\b/i.test(row.text??'')||!(row.callLinks??[]).some(dispatchLink))issues.push('dispatch-call-instructions-missing');
 if(!/\b(?:option|ext\.?|extension)\s*1\b/i.test(row.text??''))issues.push('dispatch-option-missing');
 if(row.hasPickupTime||row.hasNextTime||row.hasDestinationTime)issues.push('unconditional-time-visible');
 if(/(?:^|\n)Arrival:\s*About\b/i.test(text))issues.push('unconditional-detail-time-visible');
 if(/\bRemind me\b/.test(text))issues.push('pickup-reminder-visible');
 return {state:issues.length?'contradiction':'disclosed',policy,issues,display:{...row}};
}
export function confirmPickupDisclosure(previous,audit,{at,feedResponse}){
 if(audit.state!=='contradiction')return {state:null,alert:null};
 if(!Number.isFinite(at)||!Number.isFinite(new Date(at).valueOf())||feedResponse?.state!=='captured'||!/^[a-f0-9]{64}$/.test(feedResponse.id??'')
  ||!/^\d{1,20}$/.test(feedResponse.runId??'')||feedResponse.file!=='feed-responses/'+feedResponse.runId+'.jsonl'
  ||!Number.isFinite(feedResponse.receivedAt)||at-feedResponse.receivedAt>30000||feedResponse.receivedAt-at>5000){
  return {state:null,alert:null,unassessedReason:'original-response-unavailable-or-stale'};
 }
 const key=JSON.stringify([audit.policy.id,audit.policy.routeLabel,audit.policy.stopId,audit.policy.serviceDate,feedResponse.runId]);
 const observation={at:new Date(at).toISOString(),feedResponse:structuredClone(feedResponse),issues:audit.issues,display:audit.display};
 if(!previous||previous.key!==key||at<previous.firstAt||at-previous.firstAt>PICKUP_DISCLOSURE_MAX_GAP_MS){
  return {state:{key,firstAt:at,lastAt:at,first:observation,reported:false},alert:null};
 }
 const state={...previous,lastAt:at};
 if(state.reported||feedResponse.id===state.first.feedResponse.id
  ||feedResponse.receivedAt<=state.first.feedResponse.receivedAt||at-state.firstAt<PICKUP_DISCLOSURE_CONFIRM_MS)return {state,alert:null};
 state.reported=true;
 return {state,alert:{v:1,policy:audit.policy,observations:[state.first,observation],issues:audit.issues,
  scope:'Rendered service disclosure at two fresh retained responses; not physical bus service or ETA accuracy.'}};
}
