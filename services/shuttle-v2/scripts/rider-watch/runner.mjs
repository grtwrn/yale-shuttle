import { BoardingEvidenceUnavailable, BoardingMissed, boardSelectedRide } from './boarding.mjs';
import { auditPauseMaps, confirmPauseMaps, pauseReadDelay, readPauseMaps } from './map-pause.mjs';
import { completeArrival } from './complete-arrival.mjs';
import { auditPickupDisclosure, confirmPickupDisclosure, publishedPickupRequirement } from './service-disclosure.mjs';
import { confirmConflict, pickupCountConflict, rideCountConflict, rideTrackingConflict } from './screen-consistency.mjs';
import { confirmExitInstruction, offPoleExitInstruction } from './exit-instruction.mjs';
import { boardedTransferMatches, completedLegRecord, nextTransferStage, readTransferSections, riderLineAllowed, sameTransferLeg, selectTransferTrip, transferLegTrip, transferWaitingContext } from './transfer-journey.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { appendRolling, maintainImages, saveImage } from '../retention/storage.mjs';
import { saveCheckpoint } from './checkpoint.mjs';
import { captureFeedResponse } from './feed-evidence.mjs';
import * as metrics from '../canary-metrics.mjs';
import * as rotation from '../canary-rotation.mjs';
import {BOARD_M,cardBoardsBus,followedBusName,labeledStopId,observedAtStop,oppositePickupCurb,otherPickupOccurrence,pastPickup,quotedRideMin,quotedWaitMin,rideCapMin,selectDestination,WAIT_CAP_MIN,waitCapMin} from './inputs.mjs';
const TEST='00000000-0000-4000-8000-000000000000';
const norm=s=>String(s).replace(/\s/g,'').toLowerCase();
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const SELECTION_BACKOFF_MS=2*60000;
// The app's BUS_ABSENT_MS (web/src/rideEnd.ts).
export const BUS_GONE_MS=10*60000;
// As long for a boarded bus the feed and the app both put off its route.
export const BUS_OFF_ROUTE_MS=10*60000;
const MAX_FEED_AGE_MS=30000;
// Earlier saved feeds omit the clock. A supplied clock must satisfy the
// existing arrival-observation bounds, independently of HTTP receipt age.
const observationFresh=(bus,at)=>Number.isFinite(at)&&(bus.observed_at===undefined
 ||Number.isFinite(bus.observed_at)&&bus.observed_at<=at+5000&&at-bus.observed_at<=MAX_FEED_AGE_MS);
const ROUTE_TRACKING_UNAVAILABLE=/(?:^|\n)(?:Looking for your bus…|Bus location available · arrival estimate unavailable)(?:\n|$)/;
export async function attach({page,ctx,clockNow=()=>Date.now(),autoTick=true,initialTrip,initialLine,initialTransfer,initialFeed,initialFeedAt=clockNow(),initialResponse,initialRun,outputDir,allowedLabels,fixedTrip,randomLines=false}) {
 if (!outputDir) throw new Error('outputDir is required');
 if (!Array.isArray(initialFeed?.buses) || !Number.isFinite(initialFeedAt)) throw new Error('A valid initial feed and receipt time are required');
 const ROOT=outputDir;
 await fs.mkdir(ROOT,{recursive:true});
 let feed=initialFeed,feedAt=initialFeedAt,busy=false,stopped=false,timer,run=null,lastImage=0,lastPhase='',cursor=metrics.CANARY_LINES.findIndex(l=>l.label===initialLine?.label),imageBytes=0;
 let idleStale=false,pendingInitialTrip=initialRun?null:initialTrip;
 let journeySelections=0;
 let restartRequested;
 let ready=false,pickupTimer,pickupPromise,pendingPickup=null,pickupChecking=false;
 const feedSources=new WeakMap();
 feedSources.set(initialFeed,{response:initialResponse,receivedAt:initialFeedAt,sourceKind:'bootstrap-request',byRun:new Map()});
 const feedEvidence={state:'initializing',captured:0,unavailable:0,consecutiveFailures:0};
 let pendingArrivalEvidence;
 let lastPosition;
 // A line whose trip row is missing (e.g. a bus still in the feed after its
 // last loop) is skipped for a while, so a fixed-trip rider does not reload,
 // log and screenshot the same empty planner every 10 s.
 const unavailableUntil={};
 await fs.appendFile(path.join(ROOT,'journeys.jsonl'),'');
 let retention=await maintainImages(ROOT,{activeRunId:initialRun?.id});imageBytes=retention.imageBytes;
 const locate=async position=>{await ctx.setGeolocation(position);lastPosition=position;};
 const feedStatus=()=>{
  const feedAgeMs=Math.max(0,clockNow()-feedAt);
  return {feedReceivedAt:new Date(feedAt).toISOString(),feedAgeMs,feedStale:feedAgeMs>MAX_FEED_AGE_MS,cachedBuses:feed.buses.length};
 };
 const status=async(extra={})=>{
  await fs.writeFile(path.join(ROOT,'status.json'),JSON.stringify({updatedAt:new Date(clockNow()).toISOString(),running:!stopped,phase:run?.phase??'selecting',line:run?.line.label,trip:run?.trip,startedAt:run?.startedAt,boardedAt:run?.boardedAt,bus:run?.busName,imageBytes,retention,mapPauseAudit:run?.phase==='waiting'?run.mapPauseAudit:null,
   ...(run?.transfer?{transfer:{stage:run.transfer.stage+1,lines:run.transfer.legs.map(l=>l.routeLabel),completedLegs:run.transfer.completedLegs.length,startedAt:run.transfer.startedAt,finalDestination:run.transfer.originalTrip.destination}}:{}),...feedStatus(),feedEvidence,...(restartRequested?{restartRequested}:{}),...extra},null,2));
  await saveCheckpoint(ROOT,page,run,lastPosition,clockNow());
 };
 const event=async(kind,detail)=>{const e={at:new Date(clockNow()).toISOString(),runId:run?.id,line:run?.line.label,kind,detail};await appendRolling(ROOT,'events',e);console.log(JSON.stringify(e));};
 const capture=async(label)=>{
  const at=new Date(clockNow()).toISOString(),name=at.replace(/[:.]/g,'-')+'-'+label.replace(/[^a-zA-Z0-9-]/g,'-')+'.jpg';
  const buffer=await page.screenshot({type:'jpeg',quality:72,timeout:12000});
  retention=await saveImage(ROOT,{at,name,label,runId:run?.id},buffer,run?.id,{phase:run?.phase,line:run?.line.label});
  imageBytes=retention.imageBytes;lastImage=clockNow();
 };
 const retainFeed=(sampledFeed,runId)=>{
  const source=feedSources.get(sampledFeed);
  if(!source)return Promise.resolve({v:1,state:'unavailable',runId,reason:'feed-response-identity-unavailable'});
  if(!source.byRun.has(runId))source.byRun.set(runId,captureFeedResponse(ROOT,{response:source.response,feed:sampledFeed,runId,receivedAt:source.receivedAt,sourceKind:source.sourceKind}).then(async receipt=>{
   if(receipt.state==='captured'){feedEvidence.state='healthy';feedEvidence.captured++;feedEvidence.consecutiveFailures=0;feedEvidence.storage=receipt.storage;}
   else{
    feedEvidence.state='unavailable';feedEvidence.unavailable++;feedEvidence.consecutiveFailures++;
    feedEvidence.lastFailure={at:new Date(clockNow()).toISOString(),runId,reason:receipt.reason};
    if(feedEvidence.consecutiveFailures===3)await event('candidate-feed-evidence',feedEvidence.lastFailure).catch(()=>{});
   }
   return receipt;
  }));
  return source.byRun.get(runId);
 };
 const finish=async(reason)=>{if(pendingArrivalEvidence?.runId===run.id)await pendingArrivalEvidence.promise;
  run.finishedAt=new Date(clockNow()).toISOString();run.result=reason;
  if(run.transfer){run.transfer.completedLegs.push(completedLegRecord(run,reason));run.transfer.finishedAt=run.finishedAt;if(reason==='completed')run.transfer.busLegsFinishedAt=run.arrivedAt;}
  await capture(reason);await appendRolling(ROOT,'journeys',run);await event('journey-finished',reason);run=null;pendingArrivalEvidence=undefined;};
 const begin=async(trip,line,transfer)=>{run={instrumentVersion:transfer?'transfer-v1':'inputs-v2',id:clockNow().toString(),startedAt:new Date(clockNow()).toISOString(),phase:'waiting',line,trip,samples:0};
  if(transfer){run.transfer={...transfer,originalTrip:structuredClone(trip),stage:0,completedLegs:[],startedAt:run.startedAt,allowedLabels};run.trip=transferLegTrip(trip,transfer.legs[0],feed);run.excludeAccuracy=true;run.excludeAccuracyReason='Two-leg diagnostic; separate from one-seat accuracy aggregates';}
  journeySelections++;await event('journey-started',{line:line.label,trip,...(transfer?{transfer:run.transfer}: {})});await capture('waiting-'+line.label);await status();};
 // Keep one original qualifying receipt, rather than losing a five-second
 // position when the next response replaces it before the ten-second UI tick.
 const rememberArrival=(next,receivedAt)=>{
  const boardedAt=Date.parse(run?.boardedAt);
  if(run?.phase!=='riding'||run.arrivalObservation||!Number.isFinite(receivedAt)||!Number.isFinite(boardedAt)
   ||receivedAt-boardedAt<=30000)return;
  const bus=next.buses.find(b=>b.bus_name===run.busName&&run.line.busRouteIds.includes(b.route_id));
  const coord=next.stop_coords?.[run.exitStopId];
  if(!bus||![bus.lat,bus.lon,coord?.lat,coord?.lon].every(Number.isFinite))return;
  if(!observationFresh(bus,receivedAt))return;
  const distanceM=metrics.haversineM(bus,coord);
  const criterion=distanceM<=45?'GPS-within-45m':distanceM<=60&&bus.at_stop_id===run.exitStopId&&bus.stationary===true?'stationary-at-target-within-60m':null;
  if(criterion){const observation=run.arrivalObservation={receivedAt:new Date(receivedAt).toISOString(),
   stopId:run.exitStopId,stopName:next.stop_names?.[run.exitStopId],stopCoords:structuredClone(coord),
   bus:structuredClone(bus),distanceM,criterion,feedResponse:{v:1,state:'pending',receivedAt}};
   pendingArrivalEvidence={runId:run.id,promise:retainFeed(next,run.id).then(receipt=>{observation.feedResponse=receipt;})};}
 };
 // A five-second pickup can fall entirely between ten-second heartbeats.
 // Reuse the response already fetched by the page and require its exact
 // body identity to be committed by the product before reading/clicking.
 // Only near-stop waiting responses wake this check; polling is unchanged.
 const pickupCurrent=request=>!stopped&&run?.phase==='waiting'&&run.id===request.runId
  &&feed===request.feed&&feedAt===request.receivedAt;
 const schedulePickup=()=>{
  if(!ready||!autoTick||stopped||busy||pickupChecking||pickupTimer||!pendingPickup)return;
  pickupTimer=setTimeout(()=>{
   pickupTimer=undefined;
   if(stopped||busy||!pendingPickup)return;
   const request=pendingPickup;pendingPickup=null;pickupChecking=true;
   pickupPromise=(async()=>{
    if(!pickupCurrent(request))return;
    const receipt=await retainFeed(request.feed,request.runId);
    if(!pickupCurrent(request)||receipt.state!=='captured'||receipt.decodedSHA256!==request.source.sha256)return;
    try{
     await page.waitForFunction(source=>{
      const element=document.querySelector('[data-feedback-source]');
      let rendered;try{rendered=JSON.parse(element?.getAttribute('data-feedback-source')??'null');}catch{return false;}
      return rendered?.snapshotId===source.snapshotId&&rendered?.sha256===source.sha256
       &&rendered?.modelAt===source.modelAt&&rendered?.servedAt===source.servedAt;
     },request.source,{timeout:1500});
    }catch{return;}
    if(pickupCurrent(request)&&!busy)await tick();
   })().catch(async error=>{if(!stopped)await event('pickup-response-check-unavailable',{message:error.message}).catch(()=>{});})
    .finally(()=>{pickupChecking=false;pickupPromise=undefined;schedulePickup();});
  },0);
 };
 const observePickup=async(next,receivedAt,response)=>{
  if(!autoTick||run?.phase!=='waiting'||!Number.isSafeInteger(run.boardStopId))return;
  const coord=next.stop_coords?.[run.boardStopId];
  if(!coord||!next.buses.some(bus=>run.line.busRouteIds.includes(bus.route_id)&&observationFresh(bus,receivedAt)
   &&(metrics.haversineM(bus,coord)<=BOARD_M||observedAtStop(bus,run.boardStopId,next.stop_coords))))return;
  let source;try{source=JSON.parse((await response.headers())['x-shuttle-snapshot']??'null');}catch{return;}
  if(!source||!/^([a-f0-9]{64})$/.test(source.snapshotId??'')||!/^([a-f0-9]{64})$/.test(source.sha256??'')
   ||source.modelAt!==(next.server_eta?.at??null)||source.servedAt!==(next.server_eta?.servedAt??null))return;
  if(feed!==next||feedAt!==receivedAt||run?.phase!=='waiting')return;
  pendingPickup={feed:next,receivedAt,source,runId:run.id};schedulePickup();
 };
 const onResponse=async r=>{if(new URL(r.url()).pathname==='/api/buses'&&r.ok())try{
  const receiving=run?.phase==='riding'?run:null,next=await r.json();
  if(Array.isArray(next?.buses)){feed=next;feedAt=clockNow();feedSources.set(next,{response:r,receivedAt:feedAt,sourceKind:'page-response',byRun:new Map()});if(receiving&&run===receiving)rememberArrival(next,feedAt);await observePickup(next,feedAt,r);}
 }catch{}};
 page.on('response',onResponse);
 const onPageError=e=>event('candidate-page-error',e.message).catch(()=>{});
 page.on('pageerror',onPageError);
 const onRequest=r=>{if(/\/api\/(buses|geocode|my-reports)/.test(r.url())&&r.headers()['x-anon-id']!==TEST){stopped=true;clearInterval(timer);event('tester-id-missing',r.url()).catch(()=>{});status().catch(()=>{});}};
 page.on('request',onRequest);
 const removeListeners=()=>{page.off('response',onResponse);page.off('pageerror',onPageError);page.off('request',onRequest);};
 const idleFeedReady=async()=>{
  const info=feedStatus();
  if(info.feedStale&&!idleStale){
   idleStale=true;
   await event('candidate-stale-feed',{phase:'selecting',ageMs:info.feedAgeMs,cachedBuses:info.cachedBuses,text:await page.locator('body').innerText()});
   await capture('idle-stale-feed');
  }
  // A response may arrive while the diagnostic screenshot is captured.
  if(feedStatus().feedStale){await status({note:'Waiting for a fresh shuttle feed'});return false;}
  if(idleStale){idleStale=false;await event('feed-recovered',{phase:'selecting',ageMs:feedStatus().feedAgeMs});}
  return true;
 };
 const selectionReady=async line=>{
  if(!await idleFeedReady())return false;
  if(!metrics.liveBusesOf(feed,line).length){await status({note:'No suitable live trip currently available'});return false;}
  return true;
 };
 // Read the product's selected stop-service state. This rider cannot place a
 // Dispatch request; proximity or a modeled pass must not imply one.
 const requestOnlyPickup=async(lineLabel,stopId)=>{
  const rows=await page.locator('tbody[data-pickup-service="on-demand"]').evaluateAll(elements=>elements.map(el=>({
   routeLabel:el.dataset.route,stopId:Number(el.dataset.pickup),text:el.innerText
  })));
  return rows.find(row=>row.routeLabel===lineLabel&&Number.isSafeInteger(row.stopId)
   &&(stopId==null||row.stopId===stopId));
 };
 const pickupRows=async()=>page.locator('tbody[data-route][data-pickup]').evaluateAll(elements=>elements.map(el=>{
  const visible=node=>!!node&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden';
  const shown=selector=>[...el.querySelectorAll(selector)].some(visible);
  return {routeLabel:el.dataset.route,stopId:Number(el.dataset.pickup),visible:visible(el),text:el.innerText,
   callLinks:[...el.querySelectorAll('a[href^="tel:"]')].filter(visible).map(a=>a.getAttribute('href')),
   hasPickupTime:shown('[data-testid="pickup-range"]'),hasNextTime:shown('[data-testid="route-next-arrival"]'),
   hasDestinationTime:shown('[data-testid="destination-arrival"]')};
 }));
 const pickupAudit=async(lineLabel,stopId,text,at)=>auditPickupDisclosure({routeLabel:lineLabel,stopId,at,rows:await pickupRows(),text});
 const select=async()=>{
  // One page, one journey at a time. Normal UI interactions test lookup too.
  const order=metrics.CANARY_LINES.map((_,i)=>(cursor+i+1)%metrics.CANARY_LINES.length);
  if(randomLines)for(let i=order.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
  for(const idx of order){
   const line=metrics.CANARY_LINES[idx];
   if(!riderLineAllowed(line.label,allowedLabels,randomLines))continue;
   if(!metrics.liveBusesOf(feed,line).length)continue;
   if((unavailableUntil[line.label]??0)>clockNow())continue;
   let picked=fixedTrip ?? null;
   for(let attempt=0;!picked && attempt<12;attempt++){
    const candidate=rotation.randomTripForLine(feed,line).trip;if(!candidate)break;
    const seq=feed.routes[String(line.busRouteIds[0])]??[];
    // Ambiguous repeated endpoints need a manual positional audit, not a
    // distance-only automated arrival verdict.
    if([candidate.origin.stopId,candidate.destination.stopId].every(id=>seq.filter(s=>s===id).length===1)){picked=candidate;break;}
   }
   if(!picked)continue;
   cursor=idx;
   await page.evaluate(()=>{localStorage.removeItem('shuttle-boarded-ride');localStorage.removeItem('shuttle-transfer-handoff');sessionStorage.clear();localStorage.setItem('listView','trip');});
   await locate({latitude:picked.origin.lat,longitude:picked.origin.lon});
   try{await page.reload({waitUntil:'domcontentloaded',timeout:30000});}
   catch(error){
    // A failed navigation can leave an error page with no more feed requests.
    // Let the existing launcher replace this idle browser. A stale-feed pause
    // alone cannot recover a page that has stopped fetching altogether.
    restartRequested='selection-navigation-failed';stopped=true;clearInterval(timer);
    throw error;
   }
   const clear=page.getByRole('button',{name:'Clear',exact:true});if(await clear.isVisible())await clear.click();
   await selectDestination(page,picked.destination);
   await sleep(1500);
   if(!await selectionReady(line))return;
   // Reuse the general rider's browser: try a transfer every third selection,
   // beginning with the first, and retain the ordinary trip when none fits.
   if(randomLines&&!fixedTrip&&journeySelections%3===0){
    let transfer;
    try{transfer=await selectTransferTrip(page,feed,line,allowedLabels,randomLines);}
    catch(error){unavailableUntil[line.label]=clockNow()+SELECTION_BACKOFF_MS;await event('selection-transfer-unavailable',{line:line.label,trip:picked,message:error.message,text:await page.locator('body').innerText()});await capture('selection-transfer-unavailable');await status();return;}
    if(transfer){
     if(!await selectionReady(line)||!metrics.liveBusesOf(feed,metrics.CANARY_LINES.find(l=>l.label===transfer.legs[1].routeLabel)).length)return;
     await begin(picked,line,transfer);return;
    }
   }
   const more=page.getByRole('button',{name:/Show \d+ more route/});if(await more.isVisible())await more.click();
   const row=page.getByRole('button',{name:'View '+line.label+' trip details',exact:true});
   if(!await row.isVisible()){unavailableUntil[line.label]=clockNow()+SELECTION_BACKOFF_MS;await event('selection-unavailable',{line:line.label,trip:picked,text:await page.locator('body').innerText()});await capture('selection-unavailable');return;}
   // A centre click can hit the nested arrival disclosure. Activate the
   // focused trip card itself; its keyboard handler opens the trip view.
   await row.focus();await page.keyboard.press('Enter');
   if(!await selectionReady(line))return;
   const selectedText=await page.locator('body').innerText();
   const selectedStop=labeledStopId(selectedText,'BOARD',feed.stop_names);
   const expected=publishedPickupRequirement(line.label,selectedStop,clockNow());
   if(expected){
    const audit=await pickupAudit(line.label,selectedStop,selectedText,clockNow());
    if(audit.state==='contradiction'){
     // Keep this bad screen long enough for two independently retained
     // observations. The diagnostic cannot board or count toward accuracy.
     await begin(picked,line);run.excludeAccuracy=true;run.pickupServiceDiagnostic=true;
     run.excludeAccuracyReason='Published pickup requires Dispatch; verifying missing service disclosure';await status();return;
    }
    unavailableUntil[line.label]=clockNow()+SELECTION_BACKOFF_MS;
    await event('selection-on-demand-request-required',{line:line.label,trip:picked,service:expected,audit});
    await status({note:'Choose a scheduled pickup; this rider cannot request Dispatch service'});continue;
   }
   const requested=selectedStop!==null?await requestOnlyPickup(line.label,selectedStop):null;
   if(requested){unavailableUntil[line.label]=clockNow()+SELECTION_BACKOFF_MS;
    await event('selection-on-demand-request-required',{line:line.label,trip:picked,service:requested});
    await status({note:'Choose a scheduled pickup; this rider cannot request Dispatch service'});continue;}
   await begin(picked,line);return;
  }
  await status({note:'No suitable live trip currently available'});
 };
 const tick=async()=>{
  if(busy||stopped)return;busy=true;
  try{
   if(!run){
    if(pendingInitialTrip){
     if(!await selectionReady(initialLine))return;
     const trip=pendingInitialTrip;pendingInitialTrip=null;await begin(trip,initialLine,initialTransfer);
    }else{
     if(!await idleFeedReady())return;
     await select();return;
    }
   }
   let sampledFeed=feed,sampledFeedAt=feedAt;
   const renderWaitMs=run.phase==='waiting'?pauseReadDelay(sampledFeed,sampledFeedAt,clockNow(),run.line.label):0;
   if(renderWaitMs){
    await sleep(renderWaitMs);if(stopped)return;
    // Refresh both receipt and payload before reading text/DOM or deciding to board.
    sampledFeed=feed;sampledFeedAt=feedAt;
   }
   const text=await page.locator('body').innerText();
   const maps=run.phase==='waiting'?await readPauseMaps(page):[];
   const transferRead=run.transfer&&run.phase==='waiting'?transferWaitingContext(await readTransferSections(page),run.transfer.legs[run.transfer.stage],sampledFeed):null;
   const now=clockNow();
   const feedStable=feed===sampledFeed&&feedAt===sampledFeedAt;
   const wire=sampledFeed.server_eta;
   const mapPause=run.phase==='waiting'?auditPauseMaps(maps,sampledFeed,sampledFeedAt,now,feedStable):null;
   const pauses=confirmPauseMaps(run.mapPauseConflicts,mapPause?.findings??[],now);
   run.mapPauseConflicts=pauses.state;
   run.mapPauseAudit=mapPause?{checked:mapPause.checked,skipped:mapPause.skipped,reason:mapPause.reason,renderWaitMs,sampledAt:new Date(now).toISOString()}:null;
   const sample={at:new Date(now).toISOString(),runId:run.id,phase:run.phase,feedAgeMs:now-sampledFeedAt,text,buses:sampledFeed.buses,
    ...(run.transfer?{transfer:{stage:run.transfer.stage+1,leg:run.transfer.legs[run.transfer.stage],ui:transferRead,oneSeatAccuracyExcluded:true}}:{}),
    ...(mapPause?{mapPauseAudit:{...mapPause,maps,renderWaitMs,feedStableDuringRead:feedStable}}:{}),
    ...(run.phase==='riding'?{rideContext:{busName:run.busName,routeLabel:run.line.label,
     exitStopId:run.exitStopId,exitStopName:sampledFeed.stop_names?.[run.exitStopId],
     exitCoords:sampledFeed.stop_coords?.[run.exitStopId],feedStableDuringTextRead:feedStable}}:{}),
    ...(wire?{server_eta:{v:wire.v,at:wire.at,servedAt:wire.servedAt,buses:wire.buses}}:{}),
    feedResponse:await retainFeed(sampledFeed,run.id)};
   await appendRolling(ROOT,'samples',sample);run.samples++;
   for(const alert of pauses.alerts){await event('candidate-map-pause',alert);await capture('candidate-map-pause');}
   if(now-feedAt>MAX_FEED_AGE_MS){run.exitInstructionConflict=null;run.rideTrackingConflict=null;if(!run.stale){run.stale=true;await event('candidate-stale-feed',{ageMs:now-feedAt,text});await capture('stale-feed');}await status();return;}run.stale=false;
   if(run.phase==='waiting'){
    const requestedBoard=transferRead?.boardStopId??labeledStopId(text,'BOARD',sampledFeed.stop_names);
    const expected=publishedPickupRequirement(run.line.label,requestedBoard,now);
    if(expected&&!run.transfer){
     run.pickupServiceDiagnostic=true;run.excludeAccuracy=true;run.excludeAccuracyReason='Published pickup requires a Dispatch request; automated rider cannot arrange service';
     if(!feedStable){await status({note:'Waiting for a stable pickup-service observation'});return;}
     const audit=await pickupAudit(run.line.label,requestedBoard,text,now);
     if(feed!==sampledFeed||feedAt!==sampledFeedAt){await status({note:'Waiting for a stable pickup-service observation'});return;}
     const checked=confirmPickupDisclosure(run.pickupServiceConflict,audit,{at:now,feedResponse:sample.feedResponse});
     run.pickupServiceConflict=checked.state;run.pickupServiceAudit=audit;
     if(checked.alert){run.pickupServiceObservation=checked.alert;await event('candidate-pickup-service',checked.alert);await capture('candidate-pickup-service');}
     if(audit.state==='contradiction'&&!checked.unassessedReason&&!checked.state?.reported){
      await status({note:'Checking request-only pickup instructions against a second fresh response'});return;
     }
     unavailableUntil[run.line.label]=now+SELECTION_BACKOFF_MS;
     await event('on-demand-request-required',{service:expected,audit,...(checked.unassessedReason?{unassessedReason:checked.unassessedReason}:{})});
     await finish('on-demand-request-required-excluded');await status();return;
    }
    run.pickupServiceConflict=null;
    if(run.pickupServiceDiagnostic){
     // A clock/date transition or changed selected stop ended this diagnostic.
     // It is never converted into a scored scheduled-service journey.
     unavailableUntil[run.line.label]=now+SELECTION_BACKOFF_MS;
     await event('on-demand-observation-ended',{reason:'Selected policy context changed before confirmation'});
     await finish('on-demand-request-required-excluded');await status();return;
    }
    const requested=feedStable&&requestedBoard!==null?await requestOnlyPickup(run.line.label,requestedBoard):null;
    if(requested){run.excludeAccuracy=true;run.excludeAccuracyReason='Published pickup requires a Dispatch request; automated rider cannot arrange service';
     await event('on-demand-request-required',{service:requested});
     await finish('on-demand-request-required-excluded');await status();return;}
    // The direct-card count check reads literal direct-card text. Transfer
    // metadata is used only for boarding identity/occurrence checks below.
    const checked=confirmConflict(run.countConflict,run.transfer?null:pickupCountConflict(text,feed,run.line.busRouteIds,now),now);
    run.countConflict=checked.state;
    if(checked.alert){await event('candidate-stop-count',{line:run.line.label,...checked.alert,text});await capture('candidate-stop-count');}
    // Wait as long as the card's first quote allows, as the ride cap does:
    // Grocery Ham quoted "About 44 min · Likely 33–60 min" and #42 pulled in
    // at 47.6 min, 2.6 min after a fixed 45 min cap ended the run (96f99a88).
    if(run.waitCapMin==null){const quoted=quotedWaitMin(run.transfer?transferRead?.controlText:text);if(quoted!==null)run.waitCapMin=waitCapMin(quoted);}
    const waitCapMs=(run.waitCapMin??WAIT_CAP_MIN)*60000;
    // The line left service (e.g. Orange Night after its last loop): nothing
    // to board, so stop instead of waiting out the cap.
    if(metrics.liveBusesOf(feed,run.line).length){run.noServiceSince=undefined;}
    else{run.noServiceSince??=now;if(now-run.noServiceSince>5*60000){run.excludeAccuracy=true;await finish('no-service-excluded');await status();return;}}
    if(run.transfer&&(!feedStable||!transferRead)){
     if(!transferRead&&feedStable){run.transfer.screenMissingSince??=now;if(now-run.transfer.screenMissingSince>=30000&&!run.transfer.screenMissingReported){run.transfer.screenMissingReported=true;await event('candidate-transfer-screen',{stage:run.transfer.stage+1,expected:run.transfer.legs[run.transfer.stage],text});await capture('candidate-transfer-screen');}}
     if(now-Date.parse(run.startedAt)>waitCapMs)await finish('transfer-screen-timeout-needs-review');
     await status({note:'Waiting for a stable current transfer pickup'});return;
    }
    if(run.transfer){delete run.transfer.screenMissingSince;delete run.transfer.screenMissingReported;}
    const assessmentText=transferRead?.assessmentText??text;
    const boardLabel=transferRead?feed.stop_names[transferRead.boardStopId]:text.match(/(?:^|\n)BOARD([^\n]+)/)?.[1],exitLabel=transferRead?feed.stop_names[transferRead.exitStopId]:text.match(/(?:^|\n)GET OFF([^\n]+)/)?.[1];
    const board=transferRead?.boardStopId??labeledStopId(text,'BOARD',feed.stop_names);
    const exit=transferRead?.exitStopId??labeledStopId(text,'GET OFF',feed.stop_names);
    const name=transferRead?transferRead.busName:followedBusName(text,board,feed.buses,run.line.busRouteIds,run.busName,feed.stop_coords);
    // Do not reuse yesterday's/last poll's stop identity after a parse failure.
    if(board===null || exit===null){
     run.invalidStopSamples=(run.invalidStopSamples??0)+1;run.excludeAccuracy=true;
     if(!run.invalidStopReported){run.invalidStopReported=true;await event('measurement-invalid-stop-label',{boardLabel,exitLabel});}
     if(now-Date.parse(run.startedAt)>waitCapMs)await finish('invalid-stop-label-excluded');
     await status();return;
    }
    // No followed bus (e.g. "Unavailable" with no prediction) only skips this
    // poll: nothing stale is reused, so it does not taint the run.
    if(!name){
     run.unnamedBusSamples=(run.unnamedBusSamples??0)+1;
     if(!run.unnamedBusReported){run.unnamedBusReported=true;await event('waiting-bus-unnamed',{boardLabel,exitLabel});}
     if(now-Date.parse(run.startedAt)>waitCapMs)await finish('waiting-timeout-needs-review');
     await status();return;
    }
    run.boardStopId=board;run.exitStopId=exit;run.busName=name;
    const pickupFeed=feed,pickupFeedAt=feedAt;
    const bus=pickupFeed.buses.find(b=>b.bus_name===name&&run.line.busRouteIds.includes(b.route_id));
    const coord=pickupFeed.stop_coords[run.boardStopId];
    if(bus&&coord){
     const distance=metrics.haversineM(bus,coord);run.lastBoardDistanceM=distance;
     // If the planner picks a nearby alternate stop, simulate walking there
     // before boarding; never teleport across the city to catch a shuttle.
     if(!run.walkUntil || run.walkStopId!==run.boardStopId){run.walkStopId=run.boardStopId;run.walkUntil=now+metrics.haversineM(run.trip.origin,coord)/1.1*1000;run.walkStart=now;}
     const f=Math.min(1,(now-run.walkStart)/Math.max(1,run.walkUntil-run.walkStart));
     const at={lat:run.trip.origin.lat+(coord.lat-run.trip.origin.lat)*f,lon:run.trip.origin.lon+(coord.lon-run.trip.origin.lon)*f};
     await locate({latitude:at.lat,longitude:at.lon});
     // Also board when the card marks the bus at the stop (BOARD🚌) and the
     // feed agrees: Red #119 stood at Division / Prospect 47 m from the pole
     // for one poll and was missed (run 1790956246494).
     const atStop=/(?:^|\n)BOARD\s*🚌/.test(assessmentText)&&observedAtStop(bus,run.boardStopId,feed.stop_coords);
     // Within 45 m, but not a bus the feed has moving on past the pickup: the
     // card names a bus that just drove through as a lap away, and a rider
     // cannot board it (#317, 42 m past 100 Church Street South, run
     // 1791158187158). One that stops is boarded once its fix holds still,
     // or at the stop further on.
     const past=distance<=BOARD_M&&pastPickup(bus,run.boardStopId,feed.stop_coords);
     if(past){run.pastStopSamples=(run.pastStopSamples??0)+1;if(!run.pastStopReported){run.pastStopReported=true;await event('waiting-bus-past-stop',{bus:name,stop:boardLabel,distanceM:distance,lastStopId:bus.last_stop_id});}}
     // Opposite-direction poles can share the radius but be a lap apart.
     // Do not turn a named, stops-away card into that wrong-occurrence ride.
     const opposite=distance<=BOARD_M&&!past&&oppositePickupCurb(bus,run.boardStopId,assessmentText,feed);
     if(opposite){run.oppositeCurbSamples=(run.oppositeCurbSamples??0)+1;if(!run.oppositeCurbReported){run.oppositeCurbReported=true;await event('waiting-bus-opposite-curb',{bus:name,stop:boardLabel,distanceM:distance,atStopId:bus.at_stop_id});}}
     const other=distance<=BOARD_M&&otherPickupOccurrence(bus,run.boardStopId,assessmentText,feed,now);
     if(other){run.otherOccurrenceSamples=(run.otherOccurrenceSamples??0)+1;if(!run.otherOccurrenceReported){run.otherOccurrenceReported=true;await event('waiting-bus-other-occurrence',{...other,distanceM:distance});}}
     const eligibilityAt=clockNow(),eligibilityFeedAt=feedAt,stablePickup=feed===pickupFeed&&feedAt===pickupFeedAt;
     if(observationFresh(bus,feedAt)&&observationFresh(bus,now)&&((distance<=BOARD_M&&!past&&!opposite)||atStop)&&!other&&now>=run.walkUntil){
      await capture('pickup-'+run.line.label);run.pickupText=text;
      const boardingObservation=run.boardingObservation={v:1,attemptedAt:new Date(clockNow()).toISOString(),busName:name,
       routeIds:[...run.line.busRouteIds],stopId:run.boardStopId,stopCoords:structuredClone(coord),riderCoords:structuredClone(at),
       sample:{sampledAt:sample.at,feedReceivedAt:new Date(sampledFeedAt).toISOString(),feedStableDuringTextRead:feedStable,feedResponse:sample.feedResponse},checks:[]};
      const pendingChecks=[];
      // Snapshot every decision before starting asynchronous body retention.
      // Retention never delays a click's observation check; settle the receipts
      // before saving the outcome so a later poll cannot replace their source.
      const recordCheck=(kind,currentFeed,currentAt,checkedAt,allowed,detail={})=>{
       const current=currentFeed.buses.find(b=>b.bus_name===name&&run.line.busRouteIds.includes(b.route_id));
       const check={kind,checkedAt:new Date(checkedAt).toISOString(),feedReceivedAt:new Date(currentAt).toISOString(),allowed,
        bus:current?structuredClone(current):null,distanceM:current&&[current.lat,current.lon,coord.lat,coord.lon].every(Number.isFinite)?metrics.haversineM(current,coord):null,
        ...detail,feedResponse:{v:1,state:'pending',receivedAt:currentAt}};
       boardingObservation.checks.push(check);
       pendingChecks.push(retainFeed(currentFeed,run.id).then(receipt=>{check.feedResponse=receipt;}));
       return check;
      };
      const settleChecks=async outcome=>{boardingObservation.outcome=outcome;boardingObservation.outcomeAt=new Date(clockNow()).toISOString();await Promise.all(pendingChecks);return boardingObservation;};
      recordCheck('pickup-eligible',pickupFeed,pickupFeedAt,eligibilityAt,true,{text:assessmentText,feedStableFromSelection:stablePickup,
       gpsFreshnessClock:new Date(now).toISOString(),freshnessFeedReceivedAt:new Date(eligibilityFeedAt).toISOString(),
       atStop,past,opposite,otherOccurrence:other,walkUntil:new Date(run.walkUntil).toISOString()});
      // A ride the app started on another bus replaces the trip card, so
      // waiting on only reaches the 45 min cap (wrongbusboard20261002: it
      // stored Green #331 while #122 pulled in). No ride stored: retry as
      // before; our bus stored late: it boarded.
      // The at-stop offer can go before its click lands; the card's "I'm on
      // it" then stores our bus only while it is still the nearest within
      // 100 m in the app's latest feed. Otherwise the bus left without us,
      // and waiting on would time the next one (riderpromptmiss20261004:
      // #317, boarded 15 min after #330 stood at the stop, ended "completed").
      const boardingReady=async()=>{
       const currentFeed=feed,currentAt=feedAt,checkedAt=clockNow();
       const current=currentFeed.buses.find(b=>b.bus_name===name&&run.line.busRouteIds.includes(b.route_id));
       const allowed=!!current&&checkedAt-currentAt<=MAX_FEED_AGE_MS&&observationFresh(current,currentAt)&&observationFresh(current,checkedAt);
       return recordCheck('observation-ready',currentFeed,currentAt,checkedAt,allowed).allowed;
      };
      const unavailableBoarding=async()=>{
       const currentFeed=feed,currentAt=feedAt,checkedAt=clockNow();
       const current=currentFeed.buses.find(b=>b.bus_name===name&&run.line.busRouteIds.includes(b.route_id));
       recordCheck('boarding-observation-unavailable',currentFeed,currentAt,checkedAt,false);
       run.excludeAccuracy=true;
       await event('boarding-observation-unavailable',{bus:name,observedAt:current?.observed_at??null,feedReceivedAt:new Date(currentAt).toISOString(),boardingObservation:await settleChecks('boarding-observation-unavailable-excluded')});
       await finish('boarding-observation-unavailable-excluded');await status();
      };
      try{await boardSelectedRide(page,name,{
       boardingReady,
       ...(transferRead?.buttonName?{cardButton:page.getByTestId('transfer-pickup-controls').getByRole('button',{name:transferRead.buttonName,exact:true})}:{}),
       cardBoards:async()=>{
       if(run.transfer){
        const currentFeed=feed,currentAt=feedAt,currentRead=transferWaitingContext(await readTransferSections(page),run.transfer.legs[run.transfer.stage],currentFeed);
        const current=currentFeed.buses.find(b=>b.bus_name===name&&run.line.busRouteIds.includes(b.route_id));
        const checkedAt=clockNow(),stable=feed===currentFeed&&feedAt===currentAt;
        const otherOccurrence=current&&currentRead?otherPickupOccurrence(current,run.boardStopId,currentRead.assessmentText,currentFeed,checkedAt):null;
        const allowed=stable&&!!currentRead&&currentRead.busName===name&&!!currentRead.buttonName&&!!current
         &&!otherOccurrence;
        return recordCheck('card-boards',currentFeed,currentAt,checkedAt,allowed,{text:currentRead?.assessmentText??null,
         card:currentRead?{busName:currentRead.busName,buttonName:currentRead.buttonName}:null,feedStableDuringTextRead:stable,otherOccurrence}).allowed;
       }
       const readFeed=feed,readAt=feedAt,currentText=await page.locator('body').innerText(),latest=feed,latestAt=feedAt,checkedAt=clockNow();
       const current=latest.buses.find(b=>b.bus_name===name&&run.line.busRouteIds.includes(b.route_id));
       const otherOccurrence=current?otherPickupOccurrence(current,run.boardStopId,currentText,latest,checkedAt):null;
       const allowed=!!current&&cardBoardsBus(latest.buses,run.line.busRouteIds,at,name)
        &&!otherOccurrence;
       return recordCheck('card-boards',latest,latestAt,checkedAt,allowed,{text:currentText,feedStableDuringTextRead:latest===readFeed&&latestAt===readAt,otherOccurrence}).allowed;
      }});}catch(e){
       if(e instanceof BoardingEvidenceUnavailable){await unavailableBoarding();return;}
       const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('shuttle-boarded-ride')||'null')?.busName??null);
       // A newer recheck can identify an earlier loop visit that the pickup
       // sample could not yet distinguish. The card still quotes a later
       // pickup: retain that veto and keep waiting for the selected visit.
       const decision=boardingObservation.checks.at(-1),pickupQuotes=[...assessmentText.matchAll(/🚌\s*(#[\w-]+)\s*·\s*(\d+) stops? away/g)];
       const pickupStillAhead=pickupQuotes.length===1&&pickupQuotes[0][1].replace(/^#/,'')===name.replace(/^#/,'')&&Number(pickupQuotes[0][2])>=2;
       if(!stored&&e instanceof BoardingMissed&&pickupStillAhead&&decision?.kind==='card-boards'&&decision.allowed===false&&decision.otherOccurrence){
        run.otherOccurrenceSamples=(run.otherOccurrenceSamples??0)+1;
        await event('boarding-deferred-other-occurrence',{...decision.otherOccurrence,boardingObservation:await settleChecks('waiting-other-pickup-occurrence')});
        if(now-Date.parse(run.startedAt)>waitCapMs)await finish('waiting-timeout-needs-review');
        await status({note:'Waiting for the selected pickup visit'});return;
       }
       if(!stored&&e instanceof BoardingMissed){const check=recordCheck('boarding-missed',feed,feedAt,clockNow(),false);run.excludeAccuracy=true;await event('boarding-missed',{bus:name,stop:boardLabel,observedDistanceM:distance,distanceNowM:check.distanceM,boardingObservation:await settleChecks('boarding-missed-excluded')});await finish('boarding-missed-excluded');await status();return;}
       if(!stored){await event('boarding-checks',await settleChecks('harness-error'));throw e;}
       if(stored.replace(/^#/,'')!==name.replace(/^#/,'')){recordCheck('wrong-bus-boarded',feed,feedAt,clockNow(),false);run.excludeAccuracy=true;await event('wrong-bus-boarded',{bus:name,stored,stop:boardLabel,observedDistanceM:distance,boardingObservation:await settleChecks('wrong-bus-boarded-excluded')});await finish('wrong-bus-boarded-excluded');await status();return;}
      }
      // Matching storage can recover a delayed confirmation, but cannot
      // restore vehicle evidence that went unavailable during that wait.
      if(!await boardingReady()){await unavailableBoarding();return;}
      run.boardedAt=new Date(clockNow()).toISOString();run.phase='riding';
      run.boardedStorage=await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>/board/i.test(k))));
      if(run.transfer){const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('shuttle-boarded-ride')||'null'));if(!boardedTransferMatches(stored,run.transfer)){await event('candidate-transfer-boarded-state',{stage:run.transfer.stage+1,expected:run.transfer.legs,stored,boardingObservation:await settleChecks('wrong-transfer-state-excluded')});await finish('wrong-transfer-state-excluded');await status();return;}}
      await event('boarded',{bus:name,stop:boardLabel,observedDistanceM:distance,boardingObservation:await settleChecks('boarded')});
     }
    }
    if(run.phase==='waiting'&&now-Date.parse(run.startedAt)>waitCapMs)await finish('waiting-timeout-needs-review');
   }else if(run.phase==='riding'){
    const tracking=confirmConflict(run.rideTrackingConflict,feedStable
     ?rideTrackingConflict(text,sampledFeed,run,now):null,now);
    run.rideTrackingConflict=tracking.state;
    if(tracking.alert){await event('candidate-ride-tracking-status',{...tracking.alert,text,feedResponse:sample.feedResponse,
     scope:'Sustained tracking-message/raw-position contradiction; not route progress, physical arrival or ETA accuracy.'});await capture('candidate-ride-tracking-status');}
    const rideCount=confirmConflict(run.rideCountConflict,feedStable
     ?rideCountConflict(text,sampledFeed,run,now):null,now);
    run.rideCountConflict=rideCount.state;
    if(rideCount.alert){await event('candidate-ride-stop-count',{...rideCount.alert,text,
     scope:'Sustained screen/served-travel contradiction; not physical arrival or ETA accuracy.'});await capture('candidate-ride-stop-count');}
    const instruction=confirmExitInstruction(run.exitInstructionConflict,feedStable
     ?offPoleExitInstruction(text,sampledFeed,run,now,now-sampledFeedAt):null,now);
    run.exitInstructionConflict=instruction.state;
    if(instruction.alert){await event('candidate-exit-instruction',{...instruction.alert,text});await capture('candidate-exit-instruction');}
    rememberArrival(feed,feedAt);
    const arrival=run.arrivalObservation;
    if(arrival){
     if(pendingArrivalEvidence?.runId===run.id)await pendingArrivalEvidence.promise;
     await locate({latitude:arrival.bus.lat,longitude:arrival.bus.lon});run.lastExitDistanceM=arrival.distanceM;
     run.arrivalCriterion=arrival.criterion;run.arrivedAt=arrival.receivedAt;
     run.arrivalProcessedAt=new Date(clockNow()).toISOString();run.arrivalText=text;
     // A newer arrival can land while this tick retains its earlier screen
     // sample. Keep both receipt identities and clocks; text does not attest
     // the screen at the first-arrival response or at the later screenshot.
     run.arrivalTextContext={sampledAt:sample.at,feedReceivedAt:new Date(sampledFeedAt).toISOString(),
      feedStableDuringTextRead:feedStable,feedResponse:sample.feedResponse,
      matchesArrivalResponse:sample.feedResponse.state==='captured'&&arrival.feedResponse?.state==='captured'
       ?sample.feedResponse.id===arrival.feedResponse.id:null};
     run.phase='arrived';
     await event('arrived',{bus:run.busName,stop:arrival.stopName,
      rideSeconds:(Date.parse(run.arrivedAt)-Date.parse(run.boardedAt))/1000,observation:arrival,screen:run.arrivalTextContext});
    }else{
    const bus=feed.buses.find(b=>b.bus_name===run.busName&&run.line.busRouteIds.includes(b.route_id));
    const coord=feed.stop_coords[run.exitStopId];
    // The boarded bus left a fresh feed (stale feeds return above): end the
    // ride when the app does ("Ride tracking stopped" after 10 min absent,
    // web/src/rideEnd.ts) rather than riding out the cap with nothing to score.
    if(bus)run.busLastSeenAt=new Date(now).toISOString();
    else if(now-Date.parse(run.busLastSeenAt??run.boardedAt)>BUS_GONE_MS){run.excludeAccuracy=true;await event('bus-left-feed',{bus:run.busName,lastSeenAt:run.busLastSeenAt??run.boardedAt,lastExitDistanceM:run.lastExitDistanceM});await finish('bus-left-feed-excluded');await status();return;}
    // The boarded bus is in the feed but off its route (an end-of-service
    // deadhead: Pink #324 drove 7 km north after its last loop, run
    // 1790978871687), so the app has no route estimate (older builds said
    // "Looking for your bus…") and no ride end fires. Only sustained
    // agreement counts: a poll with the bus back on
    // its route, or with the app tracking it, resets the clock, so a detour or
    // a GPS jump is ridden through and an app that loses an on-route bus is
    // still ridden to the cap for review. Polls without the bus don't reset it.
    if(bus){
     if(!metrics.busOnRoute(feed,bus,run.line)&&ROUTE_TRACKING_UNAVAILABLE.test(text)){
      if(!run.offRouteSince){run.offRouteSince=new Date(now).toISOString();run.offRouteFrom={lat:bus.lat,lon:bus.lon};}
      if(now-Date.parse(run.offRouteSince)>BUS_OFF_ROUTE_MS){run.excludeAccuracy=true;await event('bus-off-route',{bus:run.busName,offRouteSince:run.offRouteSince,from:run.offRouteFrom,at:{lat:bus.lat,lon:bus.lon},exitDistanceM:coord?metrics.haversineM(bus,coord):null});await finish('bus-off-route-excluded');await status();return;}
     }else{run.offRouteSince=undefined;run.offRouteFrom=undefined;}
    }
    if(bus){await locate({latitude:bus.lat,longitude:bus.lon});run.lastExitDistanceM=coord?metrics.haversineM(bus,coord):null;}
    if(/Get off in 2 stops/.test(text)&&/Get off NEXT stop|Arriving at/.test(text)&&!run.popupMismatch){run.popupMismatch=true;await event('candidate-stale-alert',text);await capture('candidate-stale-alert');}
    // Ride at least as long as the card quoted at pickup (bounded); a fixed
    // 50 min gave up on a quoted 54 min ride before it could be scored.
    run.rideCapMin??=rideCapMin(quotedRideMin(run.pickupText));
    if(now-Date.parse(run.boardedAt)>run.rideCapMin*60000)await finish('ride-timeout-needs-review');
    }
   }else if(run.phase==='arrived'&&now-Date.parse(run.arrivedAt)>15000){
    if(run.transfer?.stage===0){
     // A normal end-of-tracking prompt alone is never an arrival. This
     // transition requires the retained first-leg GPS receipt above.
     const nextRun=nextTransferStage(run,feed,now);
     await completeArrival(page,()=>capture('first-arrival-dismissed'),{buttonName:'End first ride'});
     const handoff=page.getByTestId('transfer-handoff');await handoff.waitFor({timeout:5000});
     const next=handoff.getByRole('button',{name:'Continue to next pickup',exact:true});if(await next.isVisible())await next.click();
     const sections=await readTransferSections(page);if(sections.length!==1||!sameTransferLeg(sections[0],run.transfer.legs[1]))throw Error('Transfer handoff does not retain the expected second leg');
     run=nextRun;await event('transfer-handoff',{next:run.transfer.legs[1],firstArrival:run.transfer.completedLegs[0].arrivalObservation,origin:run.trip.origin});await capture('transfer-handoff');
    }else{await completeArrival(page,()=>capture('arrival-dismissed'));await finish('completed');}
   }
   if(run&&(lastPhase!==run.phase||now-lastImage>=60000)){await capture(run.phase+'-'+run.line.label);lastPhase=run.phase;}
   await status();
  }catch(e){await event('harness-error',{message:e.message,stack:e.stack});if(run){run.harnessErrors=(run.harnessErrors??0)+1;if(run.harnessErrors>=3)await finish('harness-failed-excluded');}await status({error:e.message});}
  finally{busy=false;schedulePickup();}
 };
 if(initialRun){run={...initialRun,instrumentVersion:initialRun.transfer?'transfer-v1':'inputs-v2',instrumentHandoverAt:new Date(clockNow()).toISOString(),excludeAccuracy:true};await event('harness-resumed','Browser process restored; resumed journey excluded from accuracy scoring');await status();}
 ready=true;if(autoTick)timer=setInterval(()=>tick(),10000);await tick();
 const cancelPickup=()=>{clearTimeout(pickupTimer);pickupTimer=undefined;pendingPickup=null;};
 return {status:()=>({running:!stopped,busy,run,imageBytes,feedAt,restartRequested,feedEvidence,pickupCheckPending:!!(pendingPickup||pickupTimer||pickupChecking)}),capture,stop:async()=>{stopped=true;clearInterval(timer);cancelPickup();removeListeners();await pickupPromise;await pendingArrivalEvidence?.promise;await status();},tick, detach:()=>{stopped=true;clearInterval(timer);cancelPickup();removeListeners();return run;}};
}
