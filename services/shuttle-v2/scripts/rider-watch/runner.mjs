import { boardSelectedRide } from './boarding.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as metrics from '../canary-metrics.mjs';
import * as rotation from '../canary-rotation.mjs';
import {followedBusName,labeledStopId,observedAtStop,quotedRideMin,rideCapMin,selectDestination} from './inputs.mjs';
const TEST='00000000-0000-4000-8000-000000000000';
const norm=s=>String(s).replace(/\s/g,'').toLowerCase();
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const SELECTION_BACKOFF_MS=2*60000;
// The app's BUS_ABSENT_MS (web/src/rideEnd.ts).
export const BUS_GONE_MS=10*60000;
export async function attach({page,ctx,initialTrip,initialLine,initialFeed,initialRun,outputDir,allowedLabels,fixedTrip,randomLines=false}) {
 if (!outputDir) throw new Error('outputDir is required');
 const ROOT=outputDir;
 await fs.mkdir(ROOT,{recursive:true});
 let feed=initialFeed,feedAt=Date.now(),busy=false,stopped=false,timer,run=null,lastImage=0,lastPhase='',cursor=metrics.CANARY_LINES.findIndex(l=>l.label===initialLine?.label),imageBytes=0;
 const images=[];
 // A line whose trip row is missing (e.g. a bus still in the feed after its
 // last loop) is skipped for a while, so a fixed-trip rider does not reload,
 // log and screenshot the same empty planner every 10 s.
 const unavailableUntil={};
 try { for(const line of (await fs.readFile(path.join(ROOT,'images.jsonl'),'utf8')).trim().split('\n')) if(line)images.push(JSON.parse(line)); } catch {}
 await fs.appendFile(path.join(ROOT,'journeys.jsonl'),'');
 await fs.mkdir(path.join(ROOT,'images'),{recursive:true});
 for(const name of await fs.readdir(path.join(ROOT,'images'))) imageBytes+=(await fs.stat(path.join(ROOT,'images',name))).size;
 const status=async(extra={})=>fs.writeFile(path.join(ROOT,'status.json'),JSON.stringify({updatedAt:new Date().toISOString(),running:!stopped,phase:run?.phase??'selecting',line:run?.line.label,trip:run?.trip,startedAt:run?.startedAt,boardedAt:run?.boardedAt,bus:run?.busName,imageBytes,...extra},null,2));
 const event=async(kind,detail)=>{const e={at:new Date().toISOString(),runId:run?.id,kind,detail};await fs.appendFile(path.join(ROOT,'events.jsonl'),JSON.stringify(e)+'\n');console.log(JSON.stringify(e));};
 const publish=async()=>{
  await fs.writeFile(path.join(ROOT,'index.html'),'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="60"><title>Ongoing rider QA</title><style>body{font:16px system-ui;max-width:1000px;margin:24px auto;padding:16px}img{max-width:390px;width:100%}article{display:inline-block;vertical-align:top;margin:12px}p{max-width:850px}</style><h1>Ongoing simulated rider QA</h1><p>One tester browser, sequential live journeys. GPS-simulated positions follow the operator feed; arrival observations are not independent ground truth. Screenshots below are live production views. Candidate anomalies require review before being called defects.</p><p>Updated '+esc(new Date().toISOString())+' · '+esc(run?.line.label??'Selecting')+' · '+esc(run?.phase??'idle')+'</p><p><a href="status.json">Current status</a> · <a href="events.jsonl">Events</a> · <a href="journeys.jsonl">Completed journeys</a></p>'+images.slice(-100).reverse().map(i=>'<article><p>'+esc(i.at+' '+i.label)+'</p><a href="images/'+i.name+'"><img loading="lazy" src="images/'+i.name+'"></a></article>').join(''));
 };
 const capture=async(label)=>{
  // A conservative hard cap on this new run, leaving ample room under 2 GB
  // even with the earlier reports. Stop capturing instead of deleting evidence.
  if(imageBytes>=200*1024*1024)return;
  const at=new Date().toISOString(),name=at.replace(/[:.]/g,'-')+'-'+label.replace(/[^a-zA-Z0-9-]/g,'-')+'.jpg';
  const buffer=await page.screenshot({type:'jpeg',quality:72,timeout:12000});
  if(imageBytes+buffer.length>200*1024*1024)return;
  await fs.writeFile(path.join(ROOT,'images',name),buffer);imageBytes+=buffer.length;
  const item={at,name,label,runId:run?.id};images.push(item);await fs.appendFile(path.join(ROOT,'images.jsonl'),JSON.stringify(item)+'\n');lastImage=Date.now();await publish();
 };
 const finish=async(reason)=>{run.finishedAt=new Date().toISOString();run.result=reason;await capture(reason);await fs.appendFile(path.join(ROOT,'journeys.jsonl'),JSON.stringify(run)+'\n');await event('journey-finished',reason);run=null;};
 const begin=async(trip,line)=>{run={instrumentVersion:'inputs-v2',id:Date.now().toString(),startedAt:new Date().toISOString(),phase:'waiting',line,trip,samples:0};await event('journey-started',{line:line.label,trip});await capture('waiting-'+line.label);await status();};
 const onResponse=async r=>{if(new URL(r.url()).pathname==='/api/buses'&&r.ok())try{feed=await r.json();feedAt=Date.now();}catch{}};
 page.on('response',onResponse);
 const onPageError=e=>event('candidate-page-error',e.message).catch(()=>{});
 page.on('pageerror',onPageError);
 const onRequest=r=>{if(/\/api\/(buses|geocode|my-reports)/.test(r.url())&&r.headers()['x-anon-id']!==TEST){stopped=true;clearInterval(timer);event('tester-id-missing',r.url()).catch(()=>{});status().catch(()=>{});}};
 page.on('request',onRequest);
 const removeListeners=()=>{page.off('response',onResponse);page.off('pageerror',onPageError);page.off('request',onRequest);};
 const select=async()=>{
  // One page, one journey at a time. Normal UI interactions test lookup too.
  const order=metrics.CANARY_LINES.map((_,i)=>(cursor+i+1)%metrics.CANARY_LINES.length);
  if(randomLines)for(let i=order.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
  for(const idx of order){
   const line=metrics.CANARY_LINES[idx];
   if(allowedLabels && !allowedLabels.includes(line.label))continue;
   if(!metrics.liveBusesOf(feed,line).length)continue;
   if((unavailableUntil[line.label]??0)>Date.now())continue;
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
   await page.evaluate(()=>{localStorage.removeItem('shuttle-boarded-ride');sessionStorage.clear();localStorage.setItem('listView','trip');});
   await ctx.setGeolocation({latitude:picked.origin.lat,longitude:picked.origin.lon});
   await page.reload({waitUntil:'domcontentloaded',timeout:30000});
   const clear=page.getByRole('button',{name:'Clear',exact:true});if(await clear.isVisible())await clear.click();
   await selectDestination(page,picked.destination);
   await sleep(1500);
   const more=page.getByRole('button',{name:/Show \d+ more route/});if(await more.isVisible())await more.click();
   const row=page.getByRole('button',{name:'View '+line.label+' trip details',exact:true});
   if(!await row.isVisible()){unavailableUntil[line.label]=Date.now()+SELECTION_BACKOFF_MS;await event('selection-unavailable',{line:line.label,trip:picked,text:await page.locator('body').innerText()});await capture('selection-unavailable');return;}
   // A centre click can hit the nested arrival disclosure. Activate the
   // focused trip card itself; its keyboard handler opens the trip view.
   await row.focus();await page.keyboard.press('Enter');await begin(picked,line);return;
  }
  await status({note:'No suitable live trip currently available'});
 };
 const tick=async()=>{
  if(busy||stopped)return;busy=true;
  try{
   if(!run){await select();return;}
   const now=Date.now(),text=await page.locator('body').innerText();
   const sample={at:new Date(now).toISOString(),runId:run.id,phase:run.phase,feedAgeMs:now-feedAt,text,buses:feed.buses};
   // Bound text records as well: 5 MB chunks, latest 12, at most about 60 MB.
   const log=path.join(ROOT,'samples.jsonl');let size=0;try{size=(await fs.stat(log)).size;}catch{}
   if(size>5*1024*1024){const archived='samples-'+now+'.jsonl';await fs.rename(log,path.join(ROOT,archived));const old=(await fs.readdir(ROOT)).filter(n=>/^samples-\d+\.jsonl$/.test(n)).sort();for(const n of old.slice(0,-11))await fs.unlink(path.join(ROOT,n));}
   await fs.appendFile(log,JSON.stringify(sample)+'\n');run.samples++;
   if(now-feedAt>30000){if(!run.stale){run.stale=true;await event('candidate-stale-feed',{ageMs:now-feedAt,text});await capture('stale-feed');}await status();return;}run.stale=false;
   if(run.phase==='waiting'){
    // The line left service (e.g. Orange Night after its last loop): nothing
    // to board, so stop instead of waiting out the 45 minutes.
    if(metrics.liveBusesOf(feed,run.line).length){run.noServiceSince=undefined;}
    else{run.noServiceSince??=now;if(now-run.noServiceSince>5*60000){run.excludeAccuracy=true;await finish('no-service-excluded');await status();return;}}
    const boardLabel=text.match(/(?:^|\n)BOARD([^\n]+)/)?.[1],exitLabel=text.match(/(?:^|\n)GET OFF([^\n]+)/)?.[1];
    const board=labeledStopId(text,'BOARD',feed.stop_names);
    const exit=labeledStopId(text,'GET OFF',feed.stop_names);
    const name=followedBusName(text,board,feed.buses,run.line.busRouteIds,run.busName,feed.stop_coords);
    // Do not reuse yesterday's/last poll's stop identity after a parse failure.
    if(board===null || exit===null){
     run.invalidStopSamples=(run.invalidStopSamples??0)+1;run.excludeAccuracy=true;
     if(!run.invalidStopReported){run.invalidStopReported=true;await event('measurement-invalid-stop-label',{boardLabel,exitLabel});}
     if(now-Date.parse(run.startedAt)>45*60000)await finish('invalid-stop-label-excluded');
     await status();return;
    }
    // No followed bus (e.g. "Unavailable" with no prediction) only skips this
    // poll: nothing stale is reused, so it does not taint the run.
    if(!name){
     run.unnamedBusSamples=(run.unnamedBusSamples??0)+1;
     if(!run.unnamedBusReported){run.unnamedBusReported=true;await event('waiting-bus-unnamed',{boardLabel,exitLabel});}
     if(now-Date.parse(run.startedAt)>45*60000)await finish('waiting-timeout-needs-review');
     await status();return;
    }
    run.boardStopId=board;run.exitStopId=exit;run.busName=name;
    const bus=feed.buses.find(b=>b.bus_name===name&&run.line.busRouteIds.includes(b.route_id));
    const coord=feed.stop_coords[run.boardStopId];
    if(bus&&coord){
     const distance=metrics.haversineM(bus,coord);run.lastBoardDistanceM=distance;
     // If the planner picks a nearby alternate stop, simulate walking there
     // before boarding; never teleport across the city to catch a shuttle.
     if(!run.walkUntil || run.walkStopId!==run.boardStopId){run.walkStopId=run.boardStopId;run.walkUntil=now+metrics.haversineM(run.trip.origin,coord)/1.1*1000;run.walkStart=now;}
     const f=Math.min(1,(now-run.walkStart)/Math.max(1,run.walkUntil-run.walkStart));
     await ctx.setGeolocation({latitude:run.trip.origin.lat+(coord.lat-run.trip.origin.lat)*f,longitude:run.trip.origin.lon+(coord.lon-run.trip.origin.lon)*f});
     // Also board when the card marks the bus at the stop (BOARD🚌) and the
     // feed agrees: Red #119 stood at Division / Prospect 47 m from the pole
     // for one poll and was missed (run 1790956246494).
     const atStop=/(?:^|\n)BOARD\s*🚌/.test(text)&&observedAtStop(bus,run.boardStopId,feed.stop_coords);
     if((distance<=45||atStop)&&now>=run.walkUntil){
      await capture('pickup-'+run.line.label);run.pickupText=text;
      await boardSelectedRide(page,name);
      run.boardedAt=new Date().toISOString();run.phase='riding';
      run.boardedStorage=await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>/board/i.test(k))));
      await event('boarded',{bus:name,stop:boardLabel,observedDistanceM:distance});
     }
    }
    if(now-Date.parse(run.startedAt)>45*60000)await finish('waiting-timeout-needs-review');
   }else if(run.phase==='riding'){
    const bus=feed.buses.find(b=>b.bus_name===run.busName&&run.line.busRouteIds.includes(b.route_id));
    const coord=feed.stop_coords[run.exitStopId];
    // The boarded bus left a fresh feed (stale feeds return above): end the
    // ride when the app does ("Ride tracking stopped" after 10 min absent,
    // web/src/rideEnd.ts) rather than riding out the cap with nothing to score.
    if(bus)run.busLastSeenAt=new Date(now).toISOString();
    else if(now-Date.parse(run.busLastSeenAt??run.boardedAt)>BUS_GONE_MS){run.excludeAccuracy=true;await event('bus-left-feed',{bus:run.busName,lastSeenAt:run.busLastSeenAt??run.boardedAt,lastExitDistanceM:run.lastExitDistanceM});await finish('bus-left-feed-excluded');await status();return;}
    if(bus){await ctx.setGeolocation({latitude:bus.lat,longitude:bus.lon});run.lastExitDistanceM=coord?metrics.haversineM(bus,coord):null;
     if(coord&&(run.lastExitDistanceM<=45 || (run.lastExitDistanceM<=60 && bus.at_stop_id===run.exitStopId && bus.stationary===true))&&now-Date.parse(run.boardedAt)>30000){run.arrivalCriterion=run.lastExitDistanceM<=45?'GPS-within-45m':'stationary-at-target-within-60m';run.arrivedAt=new Date().toISOString();run.arrivalText=text;run.phase='arrived';await event('arrived',{bus:run.busName,stop:feed.stop_names[run.exitStopId],rideSeconds:(now-Date.parse(run.boardedAt))/1000});}
    }
    if(/Get off in 2 stops/.test(text)&&/Get off NEXT stop|Arriving at/.test(text)&&!run.popupMismatch){run.popupMismatch=true;await event('candidate-stale-alert',text);await capture('candidate-stale-alert');}
    // Ride at least as long as the card quoted at pickup (bounded); a fixed
    // 50 min gave up on a quoted 54 min ride before it could be scored.
    run.rideCapMin??=rideCapMin(quotedRideMin(run.pickupText));
    if(now-Date.parse(run.boardedAt)>run.rideCapMin*60000)await finish('ride-timeout-needs-review');
   }else if(run.phase==='arrived'&&now-Date.parse(run.arrivedAt)>15000){
    const got=page.getByRole('button',{name:'Got it',exact:true});if(await got.isVisible())await got.click();
    await capture('arrival-dismissed');const done=page.getByRole('button',{name:'Done',exact:true});if(await done.isVisible())await done.click();await finish('completed');
   }
   if(run&&(lastPhase!==run.phase||now-lastImage>=60000)){await capture(run.phase+'-'+run.line.label);lastPhase=run.phase;}
   await status();
  }catch(e){await event('harness-error',{message:e.message,stack:e.stack});if(run){run.harnessErrors=(run.harnessErrors??0)+1;if(run.harnessErrors>=3)await finish('harness-failed-excluded');}await status({error:e.message});}
  finally{busy=false;}
 };
 if(initialRun){run={...initialRun,instrumentVersion:'inputs-v2',instrumentHandoverAt:new Date().toISOString(),excludeAccuracy:true};await event('harness-resumed','Browser process restored; sampling gap excluded from accuracy scoring');await status();}
 else if(initialTrip)await begin(initialTrip,initialLine);
 timer=setInterval(()=>tick(),10000);await tick();
 return {status:()=>({running:!stopped,busy,run,imageBytes,feedAt}),capture,stop:async()=>{stopped=true;clearInterval(timer);removeListeners();await status();},tick, detach:()=>{stopped=true;clearInterval(timer);removeListeners();return run;}};
}
