/** Independent report actions on the built SPA, with every API intercepted.
 * Build web first, then run from services/shuttle-v2. --baseline records the
 * defect rather than requiring the fix. REPORT_ACTIONS_PRODUCTION_ASSETS=1
 * inspects published assets; synthetic requests still never reach production.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';

const service = process.cwd(), baseline = process.argv.includes('--baseline');
const statusBaseline = process.argv.includes('--status-baseline');
const published = process.env.REPORT_ACTIONS_PRODUCTION_ASSETS === '1';
const base = published ? process.env.REPORT_ACTIONS_BASE_URL || 'https://yale-shuttle.fly.dev' : 'https://report-actions.test';
const host = new URL(base).hostname;
const out = process.env.OUT || path.join(service, 'pr-preview/report-actions');
await fs.mkdir(out, { recursive: true });
const feed = JSON.parse(await fs.readFile('web/src/__fixtures__/buses-payload.json', 'utf8'));
feed.buses = [];
const result = { baseline, statusBaseline, base, scope: 'Synthetic reports and delayed API responses. Every API request intercepted; no report writes reach production.', runs: [] };
if (published) {
  const response = await fetch(new URL('/healthz', base));
  const bytes = Buffer.from(await response.arrayBuffer()), health = JSON.parse(bytes);
  result.production = { at: new Date().toISOString(), status: response.status, build: health.build,
    healthSHA256: createHash('sha256').update(bytes).digest('hex') };
  await fs.writeFile(path.join(out, 'production-health-original.json'), bytes);
}
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
try {
  for (const width of [390, 1280]) {
    const report = id => ({ id, createdAt: Date.now(), kind: 'feedback', body: `Synthetic report ${id}`, status: 'open', note: null, hasImage: false, archived: false, priority: 'normal', followups: [] });
    const reports = [report(901), report(902)], pending = [], loads = [], assets = [];
    let holdLoads = false;
    const run = { width, errors: [], writes: [], checks: {}, assets: [] };
    result.runs.push(run);
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 600, hasTouch: width < 600, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await seedTestId(context);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => run.errors.push(error.message));
    if (published) page.on('response', response => {
      const url = new URL(response.url());
      if (url.hostname !== host || !(url.pathname === '/' || url.pathname.startsWith('/assets/'))) return;
      assets.push((async () => {
        const bytes = await response.body(), sha256 = createHash('sha256').update(bytes).digest('hex');
        run.assets.push({ url: response.url(), bytes: bytes.length, sha256 });
        const file = path.join(out, sha256 + (url.pathname.endsWith('.js') ? '.js' : url.pathname.endsWith('.css') ? '.css' : '.html'));
        await fs.writeFile(file, bytes, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      })());
    });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname !== host) return route.abort();
      const match = /^\/api\/my-reports\/(901|902)\/update$/.exec(url.pathname);
      if (match && request.method() === 'POST') {
        const body = request.postDataJSON(), id = Number(match[1]);
        const receipt = { id, body };
        run.writes.push(receipt);
        const status = await new Promise(resolve => pending.push({ id, resolve }));
        receipt.status = status;
        if (status === 200) {
          const item = reports.find(r => r.id === id);
          if (body.action === 'archive' || body.action === 'unarchive') item.archived = body.action === 'archive';
          if (body.action === 'followup') item.followups.push({ text: body.text, at: Date.now() });
        }
        return route.fulfill({ status, json: { ok: status === 200 } });
      }
      if (request.method() !== 'GET') return route.abort();
      if (url.pathname === '/api/buses') return route.fulfill({ json: feed });
      if (url.pathname === '/api/weather') return route.fulfill({ status: 204 });
      if (url.pathname === '/api/my-reports') {
        const body = JSON.stringify({ reports });
        if (holdLoads) await new Promise(resolve => loads.push({ resolve }));
        return route.fulfill({ body, contentType: 'application/json' });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { results: [], routes: [] } });
      if (published) return route.continue();
      const file = url.pathname === '/' ? '/index.html' : url.pathname;
      try { return route.fulfill({ body: await fs.readFile(service + '/web/dist' + file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
      catch { return route.fulfill({ status: 404 }); }
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'issues', exact: true }).click();
    const card = id => page.getByText(`Synthetic report ${id}`, { exact: true }).locator('..');
    await card(902).getByRole('button', { name: 'Reply', exact: true }).click();
    const draft = page.getByRole('textbox', { name: 'Your reply', exact: true });
    await draft.fill('Synthetic follow-up: keep this draft if the other action finishes.');
    const archive = card(901).getByRole('button', { name: 'Archive', exact: true });
    await archive.click();
    await page.waitForFunction(() => document.querySelector('button[title="Tidy this away — it stays viewable under Archived"]')?.disabled);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Sending…', exact: true }).waitFor();
    run.checks.firstReportStaysDisabled = await archive.isDisabled();
    // Native activation obeys disabled. The old implementation re-enabled this
    // button when the second report started and accepted the same action twice.
    const repeated = !run.checks.firstReportStaysDisabled
      ? page.waitForRequest(request => request.url().endsWith('/api/my-reports/901/update') && request.method() === 'POST') : null;
    await archive.evaluate(button => button.click());
    if (repeated) await repeated;
    run.checks.firstReportWrites = run.writes.filter(x => x.id === 901).length;
    pending.find(x => x.id === 901).resolve(200);
    await page.getByRole('button', { name: 'Show 1 archived', exact: true }).waitFor();
    run.checks.otherDraftSurvives = await draft.count() === 1;
    run.checks.otherRequestStaysDisabled = await page.getByRole('button', { name: 'Sending…', exact: true }).count() === 1
      && await page.getByRole('button', { name: 'Sending…', exact: true }).isDisabled();
    await page.screenshot({ path: path.join(out, `${baseline ? 'before' : 'after'}-pending-${width}.png`), fullPage: true });
    for (const item of pending.filter(x => x.id === 901)) item.resolve(200);
    pending.find(x => x.id === 902).resolve(503);
    if (!baseline) {
      assert.equal(run.checks.firstReportStaysDisabled, true);
      assert.equal(run.checks.firstReportWrites, 1);
      assert.equal(run.checks.otherDraftSurvives, true);
      assert.equal(run.checks.otherRequestStaysDisabled, true);
      await page.getByRole('alert').getByText('Didn’t go through — try again', { exact: true }).waitFor();
      assert.equal(await draft.inputValue(), 'Synthetic follow-up: keep this draft if the other action finishes.');
      run.checks.failedReplyStatusText = await page.getByRole('status').allTextContents();
      assert(!run.checks.failedReplyStatusText.some(text => /Saving|Sending/.test(text)),
        'a final failed action should leave its retry alert, not a pending announcement');
      // Hold the reply refresh, then finish a second action and deliver its
      // newer list first. A late old list must not undo the newer result.
      holdLoads = true;
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByRole('button', { name: 'Sending…', exact: true }).waitFor();
      pending.filter(x => x.id === 902).at(-1).resolve(200);
      await page.getByRole('button', { name: 'Show 1 archived', exact: true }).click();
      await card(901).getByRole('button', { name: 'Unarchive', exact: true }).click();
      const until = async predicate => {
        const deadline = Date.now() + 8000;
        while (!await predicate()) {
          assert(Date.now() < deadline, 'delayed synthetic request was not observed');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      };
      await until(() => loads.length === 1 && pending.filter(x => x.id === 901).length === 2);
      pending.filter(x => x.id === 901).at(-1).resolve(200);
      await until(() => loads.length === 2);
      loads[1].resolve();
      await card(901).getByRole('button', { name: 'Archive', exact: true }).waitFor();
      // Hide-archived disappears once the current list has no archived cards.
      await page.getByRole('button', { name: 'Hide archived', exact: true }).waitFor({ state: 'detached' });
      loads[0].resolve();
      await until(async () => await card(902).getByRole('button', { name: 'Reply', exact: true }).isEnabled());
      assert.equal(await page.getByRole('button', { name: 'Hide archived', exact: true }).count(), 0);
      assert.equal(await card(901).getByRole('button', { name: 'Unarchive', exact: true }).count(), 0);
      await card(902).getByText('Synthetic follow-up: keep this draft if the other action finishes.', { exact: true }).waitFor();
      assert.equal(reports.find(x => x.id === 902).followups.length, 1);
      run.checks.failedDraftRetainedAndRetriedOnce = true;
      run.checks.lateOldRefreshDidNotUndoNewerAction = true;
      // A has already saved, but its list refresh is still pending. B then
      // fails. Finishing A last must replace the interim saving announcement.
      const loadStart = loads.length;
      await card(902).getByRole('button', { name: 'Reply', exact: true }).click();
      await draft.fill('Synthetic failed reply while another report refreshes.');
      await card(901).getByRole('button', { name: 'Archive', exact: true }).click();
      await until(() => pending.filter(x => x.id === 901).length === 3);
      pending.filter(x => x.id === 901).at(-1).resolve(200);
      await until(() => loads.length === loadStart + 1);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByRole('button', { name: 'Sending…', exact: true }).waitFor();
      pending.filter(x => x.id === 902).at(-1).resolve(503);
      await page.getByRole('alert').getByText('Didn’t go through — try again', { exact: true }).waitFor();
      await until(async () => await page.getByRole('button', { name: 'Send', exact: true }).isEnabled());
      loads[loadStart].resolve();
      await page.getByRole('button', { name: /^(Show 1 archived|Hide archived)$/ }).waitFor();
      // Wait for the final action's finally block, not just its list render.
      if (await page.getByRole('button', { name: 'Show 1 archived', exact: true }).count())
        await page.getByRole('button', { name: 'Show 1 archived', exact: true }).click();
      await until(async () => await card(901).getByRole('button', { name: 'Unarchive', exact: true }).isEnabled());
      run.checks.settledStatusText = await page.getByRole('status').allTextContents();
      run.checks.statusSettledAfterOtherFailure = !run.checks.settledStatusText.some(text => /Saving|Sending/.test(text));
      run.checks.otherFailedDraftStillRetained = await draft.inputValue() === 'Synthetic failed reply while another report refreshes.';
      await page.screenshot({ path: path.join(out, `${statusBaseline ? 'before' : 'after'}-settled-${width}.png`), fullPage: true });
      if (!statusBaseline) {
        assert.equal(run.checks.statusSettledAfterOtherFailure, true);
        assert(run.checks.settledStatusText.includes('Saved'), 'the completed successful action should retain its confirmation');
      }
      assert.equal(run.checks.otherFailedDraftStillRetained, true);
    }
    assert.deepEqual(run.errors, []);
    const retained = await Promise.allSettled(assets);
    for (const item of retained) if (item.status === 'rejected') throw item.reason;
    await context.close();
  }
  result.completed = true;
} finally {
  await browser.close();
  await fs.writeFile(path.join(out, `${baseline ? 'before' : 'after'}-browser.json`), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result, null, 2));
