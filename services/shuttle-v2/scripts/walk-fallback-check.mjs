// Report #35 regression check. A 4.3 km trip where the SERVER planner returns
// a perfectly good ~53-min walk, but the client planner used to suppress the
// walk (its model put the trip over the 1-hour cutoff) and then render a bare
// "No trip options found between these locations."
//
// Drives the real UI the way a rider would: origin from browser geolocation,
// destination typed as a coordinate, then reads the rendered options.
//
// Run: BOT_CHROMIUM_PATH=/usr/bin/chromium node scripts/walk-fallback-check.mjs
import { chromium } from "playwright-core";

import { seedTestId } from "./testId.mjs";

const BASE = process.env.BOT_BASE_URL ?? "https://yale-shuttle.fly.dev";
const ORIGIN = { latitude: 41.318154, longitude: -72.911633 }; // Foster / Lawrence
const DEST = "41.296105,-72.955812";                           // Front / Rt 1 (N), Allingtown

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: process.env.BOT_CHROMIUM_PATH ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({
  permissions: ["geolocation"],
  geolocation: ORIGIN,
  viewport: { width: 390, height: 844 },
});
await seedTestId(ctx);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await sleep(4000); // let the first GPS fix + /api/buses payload land

const input = page.getByPlaceholder(/where do you want to go/i).first();
await input.click({ timeout: 15000 });
await input.fill("");
await input.type(DEST, { delay: 20 });
await sleep(1200);
await input.press("Enter");
await sleep(3500);

const bodyText = await page.evaluate(() => document.body.innerText);
const noOptions = /No trip options found/i.test(bodyText);
// The walk option renders with a walking time; look for a Walk row.
const hasWalk = /\bWalk\b/i.test(bodyText);
const minCount = (bodyText.match(/\d+\s*min/g) ?? []).slice(0, 6);

console.log(`target: ${BASE}`);
console.log(`page errors: ${errors.length}${errors.length ? " -> " + errors.join(" | ") : ""}`);
console.log(`"No trip options found" shown: ${noOptions}`);
console.log(`walk option present: ${hasWalk}`);
console.log(`first durations rendered: ${minCount.join(", ") || "(none)"}`);

if (errors.length) console.log("RESULT: FAIL — page errors");
else if (noOptions) console.log("RESULT: FAIL — rider still sees a dead end (report #35)");
else if (!hasWalk) console.log("RESULT: FAIL — no walk fallback rendered");
else console.log("RESULT: PASS — walk fallback shown instead of a dead end");

await browser.close();
