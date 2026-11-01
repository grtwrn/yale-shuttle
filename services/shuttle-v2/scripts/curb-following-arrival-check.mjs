import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {seedTestId} from './testId.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const diagnosticText = (value, maximum) => {
  const bytes=Buffer.from(String(value??''),'utf8');let end=Math.min(bytes.length,maximum);
  // Keep a complete UTF8 prefix, including when the cap lands inside an emoji.
  while(end>0&&end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
  return {text:bytes.subarray(0,end).toString('utf8'),fullUtf8Bytes:bytes.length,
    retainedUtf8Bytes:end,truncated:end<bytes.length};
};

/** A raw current curb is visit zero even when only its next lap is forecast.
 * Keep real following buses between that curb and the modeled next lap. */
export async function checkCurbFollowingArrival({browser, production = false, out, assetDirectory = 'web/dist'}) {
  await fs.mkdir(out, {recursive:true});
  const fixtures = await Promise.all(['orange-night-curb-following-20261024.json', 'blue-night-curb-following-20261025.json']
    .map(file => fs.readFile('web/src/__fixtures__/'+file,'utf8').then(JSON.parse)));
  const fixture = {frames:fixtures.flatMap(f=>f.frames),scenarios:fixtures.flatMap(f=>f.scenarios)};
  const frames = new Map(fixture.frames.map(frame => {
    const raw = gunzipSync(Buffer.from(frame.jsonGzipBase64,'base64'));
    assert.equal(hash(raw),frame.sha256);
    return [frame.seq,{...frame,raw:raw.toString()}];
  }));
  const results = [];
  for (const scenario of fixture.scenarios) {
    const sequence = scenario.sequence.map(seq => frames.get(seq));
    assert(sequence.every(Boolean));
    const source = JSON.parse(sequence[0].raw), endpoints = {
      from:source.stop_coords[scenario.pickup],to:source.stop_coords[scenario.destination],
      fromName:source.stop_names[scenario.pickup],toName:source.stop_names[scenario.destination],
    };
    for (const width of [368,1280]) for (const mode of ['cold','continuous']) {
      const groups = mode === 'cold' ? sequence.filter(f=>scenario.selected.includes(f.seq)).map(f=>[f]) : [sequence];
      for (const selected of groups) {
        let active = selected[0], page;
        const errors = [], receipts = [], ctx = await browser.newContext({viewport:{width,height:854},isMobile:width<500,
          hasTouch:width<500,timezoneId:'America/New_York',serviceWorkers:'block'});
        try {
          await seedTestId(ctx);
          await ctx.addInitScript(({endpoints,now}) => {
            localStorage.setItem('listView','trip');
            sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:endpoints.fromName,fromLL:endpoints.from,
              toText:endpoints.toName,toLL:endpoints.to,tripTime:'',expandedKey:null,savedAt:now}));
          },{endpoints,now:active.at+1250});
          page = await ctx.newPage();page.setDefaultTimeout(10000);
          page.on('pageerror',error=>errors.push(String(error)));
          await page.clock.install({time:new Date(active.at)});await page.clock.pauseAt(new Date(active.at+1250));
          await page.route('**/*',async route => {
            const url = new URL(route.request().url());
            if(url.hostname!=='curb-following.test')return route.abort();
            if(url.pathname==='/api/buses') {
              receipts.push({seq:active.seq,bodySHA256:active.sha256,receivedAt:await page.evaluate(()=>Date.now())});
              return route.fulfill({body:active.raw,contentType:'application/json'});
            }
            if(url.pathname==='/api/weather')return route.fulfill({status:204});
            if(url.pathname.startsWith('/api/'))return route.fulfill({json:{reports:[],results:[],ok:true}});
            if(route.request().method()!=='GET')return route.abort();
            if(production) {
              const response=await route.fetch({url:'https://yale-shuttle.fly.dev'+url.pathname+url.search});
              return route.fulfill({response});
            }
            const name=url.pathname==='/'?'/index.html':url.pathname;assert(!name.includes('..'));
            try {return route.fulfill({body:await fs.readFile(assetDirectory+name),contentType:
              name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html'});}
            catch {return route.fulfill({status:404});}
          });
          for(let i=0;i<selected.length;i++) {
            active=selected[i];const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/buses');
            if(i===0)await page.goto('https://curb-following.test',{waitUntil:'domcontentloaded'});
            else await page.clock.runFor(5200);
            await(await response).finished();
            const receipt=receipts.findLast(r=>r.seq===active.seq);assert(receipt);
            await page.clock.runFor(800);const feed=JSON.parse(active.raw);
            const committed=await page.waitForFunction(expected=>{
              const root=document.getElementById('root'),key=root&&Object.keys(root).find(k=>k.startsWith('__reactContainer$'));
              const host=key&&root[key],start=host?.stateNode?.current??host,todo=start?[start]:[];
              while(todo.length) {const f=todo.pop(),p=f.memoizedProps;
                if(p&&Array.isArray(p.buses)&&p.reportingSnapshot?.serverAt===expected.servedAt
                  &&JSON.stringify(p.reportingSnapshot.buses)===expected.rawBuses
                  &&p.lastBusUpdateAt===p.reportingSnapshot.at&&p.lastBusUpdateAt>=expected.receivedAt)return p.lastBusUpdateAt;
                if(f.child)todo.push(f.child);if(f.sibling)todo.push(f.sibling);
              }return false;
            },{servedAt:feed.server_eta.servedAt,rawBuses:JSON.stringify(feed.buses),receivedAt:receipt.receivedAt});
            const committedAt=await committed.jsonValue();await committed.dispose();
            const row=page.locator(`tbody[data-route="${scenario.route}"][data-pickup="${scenario.pickup}"][data-alight="${scenario.destination}"]`);
            await row.waitFor();assert.equal(await row.getAttribute('data-countdown-bus'),scenario.bus);
            const expected=scenario.expected[String(active.seq)],pickup=await row.getByTestId('route-pickup').innerText();
            if(expected.atStop)assert.match(pickup,/At stop/);else assert(!pickup.includes('At stop'));
            const next=await row.getByTestId('route-next-arrival').innerText();
            assert.equal(next,expected.next,`${scenario.bus}/${active.seq}/${mode}/${width}: ${await row.innerText()}`);
            assert.deepEqual(errors,[]);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
            let screen;
            if(scenario.selected.includes(active.seq)) {
              screen=`${scenario.bus}-${mode}-${active.seq}-${width}.png`;
              await page.screenshot({path:path.join(out,screen),fullPage:true});
            }
            results.push({bus:scenario.bus,mode,width,seq:active.seq,bodySHA256:active.sha256,receipt,committedAt,
              pickup,next,screen,summary:await row.innerText(),pageErrors:[...errors]});
          }
        } catch(error) {
          const body=page?await page.locator('body').innerText().catch(()=>''):'';
          const view=page?await page.evaluate(()=>{
            const rows=[...document.querySelectorAll('[data-testid="route-timing-table"] tbody[data-route]')]
              .filter(row=>row.getClientRects().length>0);
            return {visibleRowCount:rows.length,rows:rows.slice(0,12).map(row=>({
              route:row.getAttribute('data-route'),mode:row.getAttribute('data-mode'),
              pickup:row.getAttribute('data-pickup'),alight:row.getAttribute('data-alight'),
              boardBus:row.getAttribute('data-board-bus'),countdownBus:row.getAttribute('data-countdown-bus'),
              stopsAhead:row.getAttribute('data-board-stops-ahead'),
              board:row.querySelector(':scope > tr:first-child > td')?.innerText??'',
            })),renderedSource:document.querySelector('[data-feedback-source]')?.getAttribute('data-feedback-source')??null};
          }).catch(captureError=>({visibleRowCount:null,rows:[],captureError:String(captureError)}))
            :{visibleRowCount:null,rows:[],captureError:'page-not-created'};
          const diagnostic={kind:'curb-following-arrival-failure',v:1,
            route:diagnosticText(scenario.route,128),bus:diagnosticText(scenario.bus,48),mode,width,
            active:{seq:active.seq,at:active.at,bodySHA256:active.sha256},receiptCount:receipts.length,
            activeReceipt:receipts.findLast(r=>r.seq===active.seq)??null,lastReceipt:receipts.at(-1)??null,
            error:diagnosticText(error.stack??error,2048),pageErrorCount:errors.length,
            pageErrors:errors.slice(0,4).map(value=>diagnosticText(value,512)),pageErrorsTruncated:errors.length>4,
            visibleRowCount:view.visibleRowCount,visibleTripRows:view.rows.map(row=>Object.fromEntries(
              Object.entries(row).map(([key,value])=>[key,diagnosticText(value,key==='board'?512:128)]))),
            visibleTripRowsTruncated:view.visibleRowCount!==null&&view.visibleRowCount>view.rows.length,
            renderedSource:diagnosticText(view.renderedSource,2048),captureError:diagnosticText(view.captureError,512),
            body:diagnosticText(body,32*1024),stderrJsonLimitUtf8Bytes:64*1024,jsonForLogTruncated:false};
          let line=JSON.stringify(diagnostic);
          // JSON escaping can exceed the raw UTF8 budget. Preserve explicit
          // counts/flags while shrinking only this stderr copy; the full file
          // below retains the original failure evidence as before.
          while(Buffer.byteLength(line,'utf8')>diagnostic.stderrJsonLimitUtf8Bytes){
            diagnostic.jsonForLogTruncated=true;
            if(diagnostic.body.retainedUtf8Bytes)diagnostic.body=diagnosticText(body,Math.floor(diagnostic.body.retainedUtf8Bytes/2));
            else if(diagnostic.visibleTripRows.length){diagnostic.visibleTripRows.pop();diagnostic.visibleTripRowsTruncated=true;}
            else if(diagnostic.pageErrors.length){diagnostic.pageErrors.pop();diagnostic.pageErrorsTruncated=true;}
            else diagnostic.error=diagnosticText(error.stack??error,0);
            line=JSON.stringify(diagnostic);
          }
          console.error(line);
          if(page)await fs.writeFile(path.join(out,`failure-${scenario.bus}-${mode}-${active.seq}-${width}.json`),JSON.stringify({
            error:String(error.stack??error),receipts,errors,body},null,2));
          throw error;
        } finally {await ctx.unrouteAll({behavior:'wait'});await ctx.close();}
      }
    }
  }
  assert.equal(results.length,48);assert.equal(results.filter(r=>r.screen).length,32);
  await fs.writeFile(path.join(out,'results.json'),JSON.stringify({productionAssets:production,results,
    literalSnapshots:[...frames.values()].map(({seq,sha256})=>({seq,sha256})),literalSourceClocksPreserved:true,
    scope:'Recorded current-curb following arrival UI regression, including real moving later-visit controls; no physical ETA accuracy claim.'},null,2)+'\n');
  return results;
}
