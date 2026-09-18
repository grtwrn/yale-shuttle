// Run on hosted CI, not the resource-constrained watcher Pi.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const service=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(service,'web/public/minimap-options');
const out=path.join(service,'gallery-review');
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH,args:['--no-sandbox','--disable-dev-shm-usage']});
const result={widths:[],errors:[],requests:[]};
try{
  for(const width of [320,390,1440]){
    const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
    const page=await context.newPage();
    page.on('pageerror',e=>result.errors.push(e.message));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      result.requests.push(url.pathname);
      assert.equal(url.hostname,'gallery.test');
      const file=path.basename(url.pathname)||'index.html';
      assert(['index.html','style.css','gallery.js','favicon.ico'].includes(file),`Unexpected request: ${url.pathname}`);
      if(file==='favicon.ico')return route.fulfill({status:204});
      const contentType=file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html';
      return route.fulfill({body:await fs.readFile(path.join(source,file)),contentType});
    });
    await page.goto('https://gallery.test/minimap-options/index.html');
    await page.locator('#option-10').waitFor();
    assert.equal(await page.locator('.concept').count(),10);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal page overflow');
    for(let id=1;id<=10;id++){
      const card=page.locator(`#option-${id}`);
      assert(await card.evaluate(el=>Array.from(el.querySelectorAll('.phone,.summary,.summary-head,.status-strip')).every(n=>n.scrollWidth<=n.clientWidth+1)),`Card ${id} clipped at ${width}`);
      if(width===390)await card.screenshot({path:path.join(out,`option-${String(id).padStart(2,'0')}.png`)});
    }
    await page.screenshot({path:path.join(out,`gallery-${width}.png`),fullPage:true});
    const tap=page.locator('#option-5 .map-bus');
    await tap.focus();await page.keyboard.press('Enter');
    await page.getByRole('heading',{name:'Waiting at 344 Winchester',exact:true}).waitFor();
    assert.match(await page.locator('dialog').innerText(),/4 min/);
    assert.match(await page.locator('dialog').innerText(),/Typical total wait/);
    await page.keyboard.press('Escape');
    assert(await tap.evaluate(e=>document.activeElement===e),'Dialog did not restore focus');
    await page.locator('#option-5 [data-detail="pickup"]').click();
    await page.getByRole('heading',{name:'Division / Prospect',exact:true}).waitFor();
    await page.getByRole('button',{name:'Close details',exact:true}).click();
    await page.locator('#option-4 [data-route="blue"]').click();
    assert.match(await page.locator('#option-4 .summary').innerText(),/3:28–3:34/);
    assert.equal(await page.locator('#option-4 .phone-top .route-badge').innerText(),'Blue');
    await page.locator('#option-4 [data-route="red"]').click();
    for(const phase of ['wait','ride','walk'])await page.locator(`#option-7 [data-phase="${phase}"]`).click();
    await page.locator('#option-10 summary').click();
    assert(await page.locator('#option-10 details').evaluate(e=>e.open));
    await page.locator('#option-10 .map-bus').click();
    await page.getByRole('heading',{name:'Waiting at 344 Winchester',exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#option-10 summary').click();
    await page.locator('[data-save="2"]').click();
    await page.locator('[data-save="8"]').click();
    await page.locator('#favorites').click();
    assert.equal(await page.locator('.concept:visible').count(),2);
    await page.reload();
    assert.equal(await page.locator('#saved-count').innerText(),'2');
    await page.locator('#favorites').click();
    assert.equal(await page.locator('.concept:visible').count(),2);
    await page.locator('[data-save="2"]').click();await page.locator('[data-save="8"]').click();
    assert(await page.locator('#empty').isVisible());
    await page.locator('#all').click();
    assert.equal(await page.locator('.concept:visible').count(),10);
    result.widths.push(width);
    await context.close();
  }
  assert.deepEqual(result.errors,[]);
  assert(!result.requests.some(p=>p.startsWith('/api/')));
}finally{await browser.close();await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));}
console.log(JSON.stringify({widths:result.widths,errors:result.errors}));
