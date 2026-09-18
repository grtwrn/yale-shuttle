/** Bounded feedback/reply regression on the built SPA. All network is mocked.
 * Build web first. Run from services/shuttle-v2; OUT chooses evidence directory.
 * --baseline records the existing defects without requiring their corrections.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
const service = process.cwd();
const out = process.env.OUT || path.join(service, 'pr-preview', 'feedback');
await fs.mkdir(out, {recursive: true});
const baseline = process.argv.includes('--baseline');
const mode = baseline ? 'before' : 'after';
const desktop = process.env.DESKTOP === '1';
const result = {mode, desktop, checks: [], snapshots: {}, requests: [], errors: []};
const feed = JSON.parse(await fs.readFile('web/src/__fixtures__/buses-payload.json', 'utf8'));
feed.buses = [];
const fixtureReport = {id: 901, createdAt: Date.now(), kind: 'feedback', body: 'Fixture: the pickup sign is hard to find.', status: 'open', note: 'Thanks for the detail.', hasImage: false, archived: false, priority: 'normal', followups: []};
let reports = [fixtureReport, {...fixtureReport, id: 903, body: 'Fixture: archived report.', archived: true}], feedbackResponse = 503, actionResponse = 429, loadState = 'ready';
let releaseFeedback, releaseLoad, releaseAction;
const submissions = [];
const browser = await chromium.launch({executablePath: process.env.BOT_CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
try {
  const ctx = await browser.newContext({viewport: {width: desktop ? 1280 : 360, height: 800}, isMobile: !desktop, hasTouch: !desktop, timezoneId: 'America/New_York', serviceWorkers: 'block'});
  await seedTestId(ctx);
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', e => result.errors.push(e.message));
  result.warnings = [];
  page.on('console', m => { if (m.type() === 'warning') result.warnings.push(m.text()); });
  await page.route('**/*', async route => {
    const request = route.request(), u = new URL(request.url());
    if (u.hostname !== 'shuttle.test') return route.abort();
    if (u.pathname.startsWith('/api/')) result.requests.push({path: u.pathname, method: request.method()});
    if (u.pathname === '/api/buses') return route.fulfill({json: feed});
    if (u.pathname === '/api/weather') return route.fulfill({status: 204});
    if (u.pathname === '/api/report') {
      submissions.push(request.postDataJSON());
      if (feedbackResponse === 'pending') await new Promise(resolve => { releaseFeedback = resolve; });
      return route.fulfill({status: feedbackResponse, json: {id: 902}});
    }
    if (u.pathname === '/api/my-reports') {
      if (loadState === 'pending') await new Promise(resolve => { releaseLoad = resolve; });
      return route.fulfill({status: loadState === 'failed' ? 503 : 200, json: {reports}});
    }
    if (u.pathname === '/api/my-reports/901/update') {
      if (actionResponse === 'pending') await new Promise(resolve => { releaseAction = resolve; });
      if (actionResponse === 200) {
        const body = request.postDataJSON();
        if (body.action === 'followup') fixtureReport.followups.push({text: body.text, at: Date.now(), hasImage: !!body.image});
      }
      return route.fulfill({status: actionResponse, json: {ok: actionResponse === 200}});
    }
    if (u.pathname.startsWith('/api/')) return route.fulfill({json: {results: [], routes: []}});
    const file = u.pathname === '/' ? '/index.html' : u.pathname;
    try { return route.fulfill({body: await fs.readFile(service + '/web/dist' + file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'}); }
    catch { return route.fulfill({status: 404}); }
  });
  await page.goto('https://shuttle.test', {waitUntil: 'domcontentloaded'});
  const opener = page.getByRole('button', {name: '💬 Send feedback', exact: true});
  await opener.focus(); await page.keyboard.press('Enter');
  const feedback = page.locator('textarea');
  await feedback.fill('Fixture feedback: please make the pickup sign easier to find.');
  result.snapshots.feedback = await feedback.locator('..').ariaSnapshot();
  result.snapshots.priorityHeights = await page.getByRole('button', {name: /^(🔴 Urgent|Normal|💡 Nice to have)$/}).evaluateAll(es => es.map(e => ({text: e.textContent, height: e.getBoundingClientRect().height, pressed: e.getAttribute('aria-pressed')})));
  await feedback.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  result.snapshots.afterPrioritiesFocus = await page.evaluate(() => ({tag: document.activeElement.tagName, text: document.activeElement.textContent}));
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await page.getByRole('button', {name: 'Send', exact: true}).waitFor();
  result.snapshots.feedbackErrorVisible = await page.getByText("Couldn't send — try again", {exact: true}).isVisible();
  await feedback.locator('..').screenshot({path: out + '/' + mode + (desktop ? '-feedback-desktop.png' : '-feedback-360.png')});
  if (!baseline) {
    assert(result.snapshots.priorityHeights.every(b => b.height >= 44 && b.pressed !== null));
    assert.match(result.snapshots.afterPrioritiesFocus.text, /Attach screenshot/);
    assert.equal(await page.getByRole('textbox', {name: 'Feedback', exact: true}).count(), 1);
    assert.equal(result.snapshots.feedbackErrorVisible, true, 'failed feedback needs a visible error while the draft is open');
    assert.equal(await page.getByRole('alert').getByText("Couldn't send — try again", {exact: true}).count(), 1);
  }
  if (!baseline) {
    const attach = page.getByRole('button', {name: '📎 Attach screenshot', exact: true});
    const pick = async (button, file, key = 'Enter') => {
      assert(await button.isEnabled());
      assert.notEqual(await button.getAttribute('aria-disabled'), 'true');
      await button.focus();
      assert(await button.evaluate(e => e === document.activeElement), 'picker focus');
      const chooser = page.waitForEvent('filechooser');
      await button.press(key, {delay: 60});
      await (await chooser).setFiles(file);
    };
    await pick(attach, {name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('not an image')});
    await page.getByRole('alert').getByText("Couldn't read the image", {exact: true}).waitFor();
    assert.match(await feedback.inputValue(), /pickup sign/);
    const image = {name: 'fixture.png', mimeType: 'image/png', buffer: await page.screenshot()};
    await pick(attach, image, 'Space');
    await page.getByRole('img', {name: 'attached screenshot', exact: true}).waitFor();
    assert.equal(await page.getByText("Couldn't read the image", {exact: true}).count(), 0);
    const replace = page.getByRole('button', {name: '📎 Replace screenshot', exact: true});
    assert(await replace.evaluate(e => e === document.activeElement), 'file picker must retain keyboard focus after attaching');
    await pick(replace, [], 'Enter');
    assert(await page.getByRole('img', {name: 'attached screenshot', exact: true}).isVisible());
    await page.getByRole('button', {name: 'Remove screenshot'}).click();
    assert(await attach.evaluate(e => e === document.activeElement));
    await pick(attach, image);
    const urgent = page.getByRole('button', {name: '🔴 Urgent', exact: true});
    await urgent.focus(); await page.keyboard.press('Space');
    assert.equal(await urgent.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('group', {name: 'How urgent?'}).locator('[aria-pressed="true"]').count(), 1);
    for (const width of [360, 390, 430, 1280, 640]) {
      await page.setViewportSize({width, height: width === 640 ? 422 : 844});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'feedback overflow at ' + width);
      assert.equal(await feedback.evaluate(e => getComputedStyle(e).fontSize), '16px');
      for (const button of await feedback.locator('..').getByRole('button').all()) {
        const box = await button.boundingBox();
        assert(box.width >= 44 && box.height >= 44, await button.innerText());
      }
    }
    await page.setViewportSize({width: 360, height: 800});
    await feedback.locator('..').screenshot({path: out + '/after-feedback-attached-360.png'});
    feedbackResponse = 'pending';
    await page.getByRole('button', {name: 'Send', exact: true}).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', {name: 'Sending…', exact: true}).waitFor();
    assert(await page.getByRole('button', {name: 'Sending…', exact: true}).isDisabled());
    assert.match(submissions.at(-1).image, /^data:image\/jpeg;base64,/);
    assert.equal(submissions.at(-1).priority, 'urgent');
    feedbackResponse = 200; releaseFeedback();
    await opener.waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent.includes('Send feedback'));
    await page.getByRole('status').getByText('Thanks — logged (#902)', {exact: true}).waitFor();
    await opener.press('Enter');
    assert.equal(await feedback.inputValue(), '');
    assert.equal(await page.getByRole('img', {name: 'attached screenshot', exact: true}).count(), 0);
    assert.equal(await page.getByRole('button', {name: 'Normal', exact: true}).getAttribute('aria-pressed'), 'true');
    result.checks.push('Named feedback, selected 44px priorities, keyboard file chooser (Enter/Space), decoding error, replace/cancel/remove, image and priority retained through failed send; success resets and restores focus');
    await feedback.fill('Fixture: focus stays with navigation.');
    feedbackResponse = 'pending';
    await page.getByRole('button', {name: 'Send', exact: true}).click();
    await page.getByRole('button', {name: 'Sending…', exact: true}).waitFor();
    const map = page.getByRole('button', {name: 'map', exact: true});
    await map.focus();
    feedbackResponse = 200; releaseFeedback();
    await opener.waitFor();
    assert(await map.evaluate(e => e === document.activeElement));
    await opener.click();
  }
  await page.getByRole('button', {name: 'Cancel', exact: true}).click();
  if (!baseline) await page.waitForFunction(() => document.activeElement?.textContent.includes('Send feedback'));
  await page.getByRole('button', {name: 'issues', exact: true}).click();
  const reply = page.getByRole('button', {name: 'Reply', exact: true});
  await reply.focus(); await page.keyboard.press('Space');
  const replyText = page.locator('textarea');
  await replyText.fill('Fixture follow-up: I waited beside the signed stop.');
  result.snapshots.reply = await replyText.locator('..').ariaSnapshot();
  await replyText.press('Tab');
  result.snapshots.afterReplyFocus = await page.evaluate(() => ({tag: document.activeElement.tagName, text: document.activeElement.textContent}));
  await page.getByRole('button', {name: 'Send', exact: true}).click();
  await page.getByText(/Too many/).waitFor();
  result.snapshots.replyFailure = await replyText.locator('..').ariaSnapshot();
  await replyText.locator('..').screenshot({path: out + '/' + mode + (desktop ? '-reply-desktop.png' : '-reply-360.png')});
  if (!baseline) {
    assert.equal(await page.getByRole('textbox', {name: 'Your reply', exact: true}).count(), 1);
    assert.match(result.snapshots.afterReplyFocus.text, /Add screenshot/);
    assert.equal(await page.getByRole('alert').getByText(/Too many/).count(), 1);
    assert.match(await replyText.inputValue(), /signed stop/);
    const attach = page.getByRole('button', {name: '📎 Add screenshot or paste one', exact: true});
    await attach.focus();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Space');
    await (await chooser).setFiles({name: 'reply.png', mimeType: 'image/png', buffer: await page.screenshot()});
    await page.getByRole('img', {name: 'Attached screenshot', exact: true}).waitFor();
    assert(await page.getByRole('button', {name: '📎 Replace screenshot', exact: true}).evaluate(e => e === document.activeElement), 'reply picker focus');
    for (const width of [360, 390, 430, 1280, 640]) {
      await page.setViewportSize({width, height: width === 640 ? 422 : 844});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'reply overflow at ' + width);
      assert.equal(await replyText.evaluate(e => getComputedStyle(e).fontSize), '16px');
      for (const button of await replyText.locator('..').getByRole('button').all()) {
        const box = await button.boundingBox();
        assert(box.width >= 44 && box.height >= 44, await button.innerText());
      }
    }
    await page.setViewportSize({width: 390, height: 844});
    await replyText.locator('..').screenshot({path: out + '/after-reply-attached-390.png'});
    actionResponse = 503;
    await page.getByRole('button', {name: 'Send', exact: true}).click();
    await page.getByRole('alert').getByText('Didn’t go through — try again', {exact: true}).waitFor();
    assert(await page.getByRole('img', {name: 'Attached screenshot', exact: true}).isVisible());
    actionResponse = 200;
    await page.getByRole('button', {name: 'Send', exact: true}).focus(); await page.keyboard.press('Enter');
    await reply.waitFor();
    await page.getByRole('status').getByText('Reply sent', {exact: true}).waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Reply');
    assert.equal(fixtureReport.followups.at(-1).hasImage, true);
    await reply.press('Enter');
    assert.equal(await replyText.inputValue(), '');
    assert.equal(await page.getByRole('img', {name: 'Attached screenshot', exact: true}).count(), 0);
    await page.getByRole('button', {name: 'Cancel', exact: true}).focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => document.activeElement?.textContent === 'Reply');
    await reply.press('Enter');
    await replyText.fill('Fixture reply: retain navigation focus.');
    actionResponse = 'pending';
    await page.getByRole('button', {name: 'Send', exact: true}).click();
    await page.getByRole('status').getByText('Sending reply…', {exact: true}).waitFor();
    const nav = page.getByRole('button', {name: 'map', exact: true});
    await nav.focus();
    actionResponse = 200; releaseAction();
    await reply.waitFor();
    await page.getByRole('status').getByText('Reply sent', {exact: true}).waitFor();
    assert(await nav.evaluate(e => e === document.activeElement));
    const priority = page.getByRole('combobox', {name: 'Report priority', exact: true});
    assert.equal(await priority.evaluate(e => getComputedStyle(e).fontSize), '16px');
    assert((await priority.boundingBox()).height >= 44);
    const archived = page.getByRole('button', {name: 'Show 1 archived', exact: true});
    await archived.focus(); await page.keyboard.press('Space');
    assert.equal(await page.getByRole('button', {name: 'Hide archived'}).getAttribute('aria-expanded'), 'true');
    await page.getByText('Fixture: archived report.', {exact: true}).waitFor();
    await page.getByRole('button', {name: 'Hide archived'}).press('Enter');
    assert.equal(await archived.getAttribute('aria-expanded'), 'false');
    result.checks.push('Reply completion preserves navigation focus; named 16px report priority and keyboard archived disclosure');
    result.checks.push('Named reply, keyboard attachment, 429 and 503 announced with draft/image retained, successful reply threaded with status and focus return; cancel restores focus; 360/390/430/1280/640 CSS-pixel reflow');
    await page.getByRole('button', {name: 'trip', exact: true}).click();
    loadState = 'pending';
    await page.getByRole('button', {name: 'issues', exact: true}).click();
    await page.getByRole('status').getByText('Loading…', {exact: true}).waitFor();
    loadState = 'failed'; releaseLoad();
    await page.getByRole('alert').getByText('Couldn’t load your reports.', {exact: true}).waitFor();
    loadState = 'ready'; reports = [];
    await page.getByRole('button', {name: 'Try again', exact: true}).focus(); await page.keyboard.press('Enter');
    await page.getByRole('status').getByText(/No reports yet/).waitFor();
    result.checks.push('Issues loading, failed fetch, keyboard retry and empty state announced; all requests intercepted, no production submissions');
  }
  if (!baseline && !desktop) {
    await opener.tap();
    await feedback.fill('Fixture: mobile touch path.');
    await page.getByRole('button', {name: '💡 Nice to have', exact: true}).tap();
    assert.equal(await page.getByRole('button', {name: '💡 Nice to have', exact: true}).getAttribute('aria-pressed'), 'true');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', {name: '📎 Attach screenshot', exact: true}).tap();
    await (await chooser).setFiles([]);
    await page.getByRole('button', {name: 'Cancel', exact: true}).tap();
    await opener.waitFor();
    result.checks.push('Actual mobile taps open feedback, select priority, activate the native chooser and cancel');
  }
  assert.deepEqual(result.errors, []);
  result.completed = true;
  await ctx.close();
} finally {
  if (!result.completed) result.failureFocus = await browser.contexts()[0]?.pages()[0]?.evaluate(() => ({tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.slice(0,100)}));
  if (!result.completed) result.failureSnapshot = await browser.contexts()[0]?.pages()[0]?.locator('body').ariaSnapshot().catch(() => 'unavailable');
  await browser.close();
  await fs.writeFile(out + '/' + mode + '-browser.json', JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
