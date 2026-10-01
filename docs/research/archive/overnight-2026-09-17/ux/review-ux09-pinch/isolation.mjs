// Reviewer-only adapter integration: remove one map while another is pinching.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const service = process.cwd(), out = process.env.OUT;
if (!out) throw Error('Set OUT');
await fs.mkdir(out, { recursive: true });
const { build } = createRequire(service + '/web/package.json')('esbuild');
const { chromium } = createRequire(service + '/package.json')('playwright-core');
const { seedTestId } = await import(service + '/scripts/testId.mjs');
const bundle = await build({ stdin: { loader: 'ts', resolveDir: service + '/web/src', contents: `
 import L from 'leaflet';
 import { cancelMapTouchZoom } from './mapLifecycle';
 const maps = ['first','second','disabled'].map(id => {
   const map = L.map(id, {zoomAnimation:false,touchZoom:id !== 'disabled'}).setView([41.3,-72.93],14);
   L.polyline([[41.298,-72.934],[41.305,-72.926]]).addTo(map);
   return map;
 });
 window.removeMap = i => { cancelMapTouchZoom(maps[i]); maps[i].stop(); maps[i].remove(); };
 window.mapState = () => maps.map(m => ({zoom:m.getZoom(),touch:m.touchZoom.enabled()}));
` }, bundle: true, write: false, format: 'iife', sourcemap: 'inline' });
await fs.writeFile(out + '/adapter-bundle.js', bundle.outputFiles[0].text);
const css = await fs.readFile(service + '/web/node_modules/leaflet/dist/leaflet.css', 'utf8');
const report = { scope: 'Actual helper and installed Leaflet in bounded two-map fixture; native browser touch; normal clock', checks: [], errors: [] };
let browser, context, page, client;
try {
 browser = await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
 await seedTestId(context);
 page = await context.newPage(); page.setDefaultTimeout(8000);
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.route('**/*',r=>r.request().url()==='https://adapter.test/' ? r.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'\nbody{margin:0}.map{height:250px}</style><div class="map" id="first"></div><div class="map" id="second"></div><div class="map" id="disabled"></div><script>'+bundle.outputFiles[0].text+'</script>'}) : r.abort());
 await page.goto('https://adapter.test/');
 await page.locator('#second .leaflet-overlay-pane path').waitFor();
 client = await context.newCDPSession(page);
 const doc = await client.send('Runtime.evaluate',{expression:'document'});
 const counts = async()=>{
  const {listeners}=await client.send('DOMDebugger.getEventListeners',{objectId:doc.result.objectId});
  return Object.fromEntries(['touchmove','touchend','touchcancel'].map(type=>[type,listeners.filter(l=>l.type===type).length]));
 };
 const points = async(id,gap)=>{const b=await page.locator('#'+id).boundingBox();return [{x:b.x+b.width/2-gap,y:b.y+b.height/2,id:1},{x:b.x+b.width/2+gap,y:b.y+b.height/2,id:2}];};
 report.before=await counts();
 await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:await points('first',25)});
 // Leaflet's no-movement touchEnd leaves its document callbacks installed.
 await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 report.afterUnmovedFirst=await counts();
 assert.equal(report.afterUnmovedFirst.touchmove,report.before.touchmove+1);
 await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:await points('second',25)});
 report.both=await counts();
 assert.equal(report.both.touchmove,report.before.touchmove+2);
 await page.evaluate(()=>window.removeMap(0));
 report.afterFirstRemoved=await counts();
 for(const type of Object.keys(report.before)) assert.equal(report.afterFirstRemoved[type],report.before[type]+1,type+' retains only second map');
 const before=(await page.evaluate(()=>window.mapState()))[1];
 for(const gap of [30,40,60]) {await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:await points('second',gap)});await page.waitForTimeout(40);}
 await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await page.waitForTimeout(300);
 const after=(await page.evaluate(()=>window.mapState()))[1];
 assert(after.touch && after.zoom>before.zoom,'Other mounted map still completes pinch');
 assert.deepEqual(await counts(),report.before);
 report.checks.push('Removing one map unregisters only its callbacks; a different active map completes native pinch');
 await page.locator('#second').getByRole('button',{name:'Zoom out',exact:true}).tap();
 await page.waitForTimeout(100);
 assert((await page.evaluate(()=>window.mapState()))[1].zoom<after.zoom);
 await page.evaluate(()=>{window.removeMap(1);window.removeMap(2);});
 assert.deepEqual(await counts(),report.before);
 // Leaflet removes panes but intentionally leaves classes on standalone host divs.
 assert.equal(await page.locator('.leaflet-map-pane').count(),0);
 report.checks.push('Surviving map accepts later touch; removing idle and touch-disabled maps is safe');
 assert.deepEqual(report.errors,[]); report.completed=true;
} finally {
 if(client)await client.detach();if(page)await page.close();if(context)await context.close();if(browser)await browser.close();
 report.resourcesClosed=true;await fs.writeFile(out+'/isolation.json',JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report,null,2));
