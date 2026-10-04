/** The at-stop offer ("On Purple #330? Detected near your board stop") lives
 * only while the feed puts the bus at the stop (at_stop_id, TransitMap), so it
 * can go between the poll that decided to board and the click. Purple #330 left
 * West Haven Train Station as the click began, and Playwright's 30 s default
 * waited for a button that never came back (riderpromptmiss20261004). Offer
 * clicks in the retained runs all landed within 1.3 s. */
export const OFFER_CLICK_MS = 3000;
/** The offer went before it was clicked and the card's "I'm on it" would no
 * longer store our bus: the bus was at the stop and left without us. */
export class BoardingMissed extends Error {}
/** Prefer the auto-detection confirmation only when it names our chosen bus.
 * If the offer goes first, board through the card's "🚌 I'm on it" only while
 * `cardBoards()` says it stores our bus. */
export async function boardSelectedRide(page, busName, {cardBoards = async () => false} = {}) {
  const yes = page.getByRole('button', {name: "Yes, I'm on it", exact: true});
  const card = page.getByRole('button', {name: "🚌 I'm on it", exact: true});
  // False when the offer went away instead of taking the click.
  const clickOffer = async (button) => {
    try { await button.click({timeout: OFFER_CLICK_MS}); return true; }
    catch (e) { if (await yes.isVisible()) throw e; return false; }
  };
  if (await yes.isVisible()) {
    const text = await page.locator('body').innerText();
    const detected = text.match(/On [^\n]*?#([\w-]+)\?/i)?.[1];
    if (detected === busName.replace(/^#/, '')) {
      if (!await clickOffer(yes)) {
        if (!await cardBoards()) throw new BoardingMissed(`The offer for ${busName} went before the click and "I'm on it" would not store it`);
        await card.click();
      }
    } else {
      await clickOffer(page.getByRole('button', {name: 'Not me', exact: true}));
      await card.click();
    }
  } else await card.click();
  await page.waitForFunction((name) => {
    const ride = JSON.parse(localStorage.getItem('shuttle-boarded-ride') || 'null');
    return ride && ride.busName.replace(/^#/, '') === name.replace(/^#/, '');
  }, busName, {timeout: 5000});
}
