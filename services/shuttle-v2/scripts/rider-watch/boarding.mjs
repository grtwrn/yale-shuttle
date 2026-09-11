/** Prefer the auto-detection confirmation only when it names our chosen bus. */
export async function boardSelectedRide(page, busName) {
  const yes = page.getByRole('button', {name: "Yes, I'm on it", exact: true});
  if (await yes.isVisible()) {
    const text = await page.locator('body').innerText();
    const detected = text.match(/On [^\n]*?#([\w-]+)\?/i)?.[1];
    if (detected === busName.replace(/^#/, '')) await yes.click();
    else {
      await page.getByRole('button', {name: 'Not me', exact: true}).click();
      await page.getByRole('button', {name: "🚌 I'm on it", exact: true}).click();
    }
  } else await page.getByRole('button', {name: "🚌 I'm on it", exact: true}).click();
  await page.waitForFunction((name) => {
    const ride = JSON.parse(localStorage.getItem('shuttle-boarded-ride') || 'null');
    return ride && ride.busName.replace(/^#/, '') === name.replace(/^#/, '');
  }, busName, {timeout: 5000});
}
