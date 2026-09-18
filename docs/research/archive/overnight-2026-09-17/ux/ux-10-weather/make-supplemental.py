from pathlib import Path
root=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17')
out=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10-weather')
s=(root/'services/shuttle-v2/scripts/weather-controls-check.mjs').read_text()
prefix=s.split("  await load('dry');")[0]
prefix=prefix.replace("  page = await ctx.newPage();",'''  await ctx.addInitScript(() => {
    sessionStorage.removeItem('shuttle-trip-draft');
    localStorage.removeItem('shuttle-recent-trips');
    const code = Number(new URL(location.href).searchParams.get('geo') || 1);
    const fail = cb => queueMicrotask(() => cb?.({code, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: 'Fixture location failure'}));
    window.geoCalls = [];
    Object.defineProperty(navigator, 'geolocation', {value: {
      watchPosition(ok, err, options) { window.geoCalls.push({action: 'watch', options}); fail(err); return 1; },
      clearWatch() {},
      getCurrentPosition(ok, err, options) { window.geoCalls.push({action: 'request', options}); fail(err); },
    }});
  });
  page = await ctx.newPage();''')
prefix=prefix.replace("    if (u.pathname.startsWith('/api/'))", "    if (u.pathname === '/api/geocode') return route.fulfill({json: {results: [{display_name: 'Sterling Memorial Library', lat: 41.3113, lon: -72.9288, class: 'amenity', type: 'library'}, {display_name: 'Sterling Hall of Medicine', lat: 41.3037, lon: -72.9322, class: 'amenity', type: 'library'}]}});\n    if (u.pathname.startsWith('/api/'))")
body=r'''
  for (const [code, expected] of [[1, 'Location permission denied'], [2, 'Location unavailable'], [3, 'Location request timed out']]) {
    scenario = 'dry';
    await page.goto('https://shuttle.test/?geo=' + code, {waitUntil: 'domcontentloaded'});
    await unit().waitFor();
    await page.getByRole('button', {name: 'Union Station', exact: true}).click();
    const toSummary = page.getByRole('button', {name: /^To 🏁/});
    const fromSummary = page.getByRole('button', {name: /^From 📍/});
    await toSummary.waitFor(); await fromSummary.waitFor();
    await fromSummary.focus(); await page.keyboard.press('Enter');
    const from = page.getByRole('combobox', {name: 'From', exact: true});
    await from.waitFor();
    await from.press('ArrowDown'); await from.press('Enter');
    await page.getByText(new RegExp(expected)).waitFor();
    await page.getByText('Getting your location…', {exact: true}).waitFor({state: 'hidden'});
    assert(!(await fromSummary.innerText()).includes('Locating'));
    await fromSummary.focus(); await page.keyboard.press('Space'); await from.waitFor();
    await from.fill('Sterling'); await page.clock.runFor(400);
    await page.getByRole('option').nth(1).waitFor();
    await from.press('ArrowDown'); await from.press('Enter');
    await page.getByRole('button', {name: /^From 📍 Sterling Memorial Library/}).waitFor();
    assert.equal(await page.getByText(new RegExp(expected)).count(), 0);
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('shuttle-trip-draft')).fromLL), {lat: 41.3113, lon: -72.9288});
    await page.getByText('Getting your location…', {exact: true}).waitFor({state: 'hidden'});
    report.checks.push(expected + ': explicit current-location request settles; typed From selects correct coordinates and clears stale error/spinner');
    // This selected destination exercises the non-input weather focus fallback.
    const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('shuttle-trip-draft')));
    await unit().focus(); scenario = 'missing'; await page.clock.fastForward(600001); await unit().waitFor({state: 'hidden'});
    await focused(toSummary);
    const after = await page.evaluate(() => JSON.parse(sessionStorage.getItem('shuttle-trip-draft')));
    assert.deepEqual(after.fromLL, draft.fromLL); assert.deepEqual(after.toLL, draft.toLL);
    report.checks.push('Weather removal restores selected To summary without changing either endpoint, location case ' + code);
    await page.waitForTimeout(500);
  }
  await page.clock.setSystemTime(now); await load('dry');
  await line().click(); await panel().focus();
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400);
  const left = await panel().evaluate(e => e.scrollLeft);
  await page.clock.fastForward(600001); await page.waitForTimeout(150);
  await focused(panel()); assert.equal(await panel().evaluate(e => e.scrollLeft), left);
  report.checks.push('Ordinary weather refresh preserves strip focus and horizontal scroll');
  const map = page.getByRole('button', {name: 'map', exact: true});
  await map.focus(); await page.keyboard.press('Enter');
  scenario = 'missing'; await page.clock.fastForward(600001); await focused(map);
  const trip = page.getByRole('button', {name: 'trip', exact: true});
  await trip.focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(150); await focused(trip);
  report.checks.push('Leaving and reopening Trip does not steal focus from navigation');
  assert.deepEqual(report.errors, []); report.passed = true;
'''
footer=s[s.index('} catch (error) {'):]
(out/'supplemental.mjs').write_text(prefix+body+footer)
