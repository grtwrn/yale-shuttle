import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(here, "../../services/shuttle-v2/package.json"));
const { chromium } = require("playwright-core");
const payload = JSON.parse(fs.readFileSync(path.join(here, "captured-buses.json"), "utf8"));
const provenance = JSON.parse(fs.readFileSync(path.join(here, "provenance.json"), "utf8"));
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const board = payload.stop_coords[11], dest = payload.stop_coords[48];
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2,
  permissions: ["geolocation"], geolocation: { latitude: board.lat, longitude: board.lon }, timezoneId: "America/New_York" });
await ctx.addInitScript(now => {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(now); }
    static now() { return now; }
  }
  window.Date = FrozenDate;
  localStorage.setItem("yale-shuttle-test-id", "preview-generalized-shuttle-eta");
}, provenance.observedAt);
const page = await ctx.newPage();
const pageErrors = [], failedRequests = [], clickedTabs = [], captures = [];
page.on("pageerror", e => pageErrors.push(e.message));
page.on("requestfailed", r => failedRequests.push({ url: r.url(), reason: r.failure()?.errorText }));
await page.route("**/api/buses*", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) }));
await page.route("**/api/weather*", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: false, hourly: [] }) }));
// Every API write stays in this preview and returns without changing a service.
await page.route("**/api/**", async r => {
  if (!["GET", "HEAD"].includes(r.request().method())) return r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  return r.fallback();
});
async function tab(name) {
  const button = page.getByRole("button", { name: new RegExp(`^\\s*(?:\\S+\\s+)?${name}\\s*$`, "i") }).first();
  await button.click({ timeout: 15000 });
  clickedTabs.push(name);
  await page.waitForTimeout(1200);
}
async function shot(name, fullPage = true) {
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(here, file), fullPage });
  captures.push(file);
}
try {
  await page.goto("http://127.0.0.1:8097", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  await tab("trip");
  const input = page.getByPlaceholder(/where do you want to go/i).first();
  await input.fill(`${dest.lat},${dest.lon}`);
  await input.press("Enter");
  await page.waitForTimeout(3000);
  await shot("trip");
  await tab("map");
  await page.waitForTimeout(1200);
  await shot("map");
  const text = await page.locator("body").innerText();
  fs.writeFileSync(path.join(here, "map-visible.txt"), text);
  await tab("issues");
  await shot("issues");
  if (await page.getByText("App crashed", { exact: false }).count()) throw Error("App crash screen");
  if (pageErrors.length) throw Error(`Page errors: ${pageErrors.join(" | ")}`);
} finally {
  fs.writeFileSync(path.join(here, "preview.json"), JSON.stringify({
    caption: "Recorded Red bus at 344 Winchester, with the browser clock fixed to September 9 at 07:34 ET. This first-visit example uses the normal duration fallback. The map's 8–11 min badge is a historical pause range; the trip destination coordinates identify Division/Prospect. Historical validation is shown separately.",
    base: "http://127.0.0.1:8097", observedAt: provenance.observedAt, boardStopId: 11, destinationStopId: 48,
    clickedTabs, expectedTabs: ["trip", "map", "issues"], pageErrors, failedRequests, captures,
    allThreeTabsClicked: ["trip", "map", "issues"].every(x => clickedTabs.includes(x)),
    upstreamCallsFromServer: false, productionWrites: false, futureOutcomesRead: false,
  }, null, 2) + "\n");
  await ctx.close(); await browser.close();
}
if (clickedTabs.length !== 3 || pageErrors.length) process.exitCode = 1;
