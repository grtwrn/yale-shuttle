import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {seedTestId} from './testId.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** A raw current curb is visit zero even when only its next lap is forecast.
 * Keep real following buses between that curb and the modeled next lap. */
export async function checkCurbFollowingArrival({browser, production = false, out, assetDirectory = 'web/dist'}) {
  await fs.mkdir(out, {recursive:true});
  const fixture = JSON.parse(await fs.readFile('web/src/__fixtures__/orange-night-curb-following-20261024.json','utf8'));
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
          if(page)await fs.writeFile(path.join(out,`failure-${scenario.bus}-${mode}-${active.seq}-${width}.json`),JSON.stringify({
            error:String(error.stack??error),receipts,errors,body:await page.locator('body').innerText().catch(()=>'')},null,2));
          throw error;
        } finally {await ctx.unrouteAll({behavior:'wait'});await ctx.close();}
      }
    }
  }
  assert.equal(results.length,40);assert.equal(results.filter(r=>r.screen).length,24);
  await fs.writeFile(path.join(out,'results.json'),JSON.stringify({productionAssets:production,results,
    literalSnapshots:[...frames.values()].map(({seq,sha256})=>({seq,sha256})),literalSourceClocksPreserved:true,
    scope:'Recorded current-curb following arrival UI regression, including real moving later-visit controls; no physical ETA accuracy claim.'},null,2)+'\n');
  return results;
}
