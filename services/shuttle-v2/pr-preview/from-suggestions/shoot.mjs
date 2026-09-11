// Run from services/shuttle-v2 against a staged build: BASE=http://127.0.0.1:<port> node pr-preview/from-suggestions/shoot.mjs
// Screenshots for the From-suggestions PR: seed two recents through the To
// box, then open From (idle list), type an address (suggestions), pick it (plan).
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { seedTestId } from "../../scripts/testId.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8102";
const OUT = process.env.OUT ?? new URL(".", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({
  permissions: ["geolocation"],
  geolocation: { latitude: 41.30815, longitude: -72.92915 }, // Old Campus
  timezoneId: "America/New_York",
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
});
await seedTestId(ctx);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));

async function shot(name, fullPage = false) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });
  console.log("shot", name);
}
async function openTab(label) {
  await page.getByRole("button", { name: new RegExp(`^\\s*(\\S+\\s+)?${label}\\s*$`, "i") }).first().click({ timeout: 10_000 });
  await sleep(1000);
}

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await sleep(4000);
await openTab("Trip").catch(() => {});

// Seed recent #1: Trader Joe's — two stores come back, take the first row.
const to = page.getByPlaceholder(/where do you want to go/i).first();
await to.click({ timeout: 20_000 });
await to.type("trader joes", { delay: 40 });
await sleep(3500);
const opt = page.getByRole("option").first();
if (await opt.isVisible().catch(() => false)) await opt.click();
else await to.press("Enter");
await sleep(4000);

// Seed recent #2: tap the To pill, search Union Station (curated -> auto-picks on Enter).
await page.getByText(/🏁 Trader Joe/).first().click({ timeout: 10_000 });
await sleep(500);
const to2 = page.getByPlaceholder(/where do you want to go/i).first();
await to2.type("Union Station", { delay: 40 });
await sleep(1200);
await to2.press("Enter");
await sleep(4000);

const recents = await page.evaluate(() => localStorage.getItem("shuttle-recent-trips"));
console.log("recents:", recents);

// (1) Tap From: the idle list — Current location, Recent, Saved, Popular.
await page.getByText(/^From$/).first().click({ timeout: 10_000 });
await sleep(800);
const fromInput = page.getByPlaceholder(/current location/i).first();
if (!(await page.getByRole("listbox").first().isVisible().catch(() => false))) throw new Error("no idle list under From");
await shot("1-from-recents");

// (2) Type an address: the geocoder's suggestions replace the idle list.
await fromInput.type("517 prospect", { delay: 60 });
await sleep(3500);
const rows = await page.getByRole("option").allTextContents();
console.log("options:", rows);
if (rows.length === 0) throw new Error("no suggestions for 517 prospect");
await shot("2-from-typing");

// (3) Pick it: the plan from the typed start.
await page.getByRole("option").first().click();
await sleep(5000);
const pill = await page.getByText(/^From$/).first().locator("..").textContent();
console.log("from pill:", pill);
await shot("3-plan-typed-start", true);

const recents2 = await page.evaluate(() => localStorage.getItem("shuttle-recent-trips"));
console.log("recents after:", recents2);

// (4) Bonus: From tapped again — the typed address is now a recent.
await page.getByText(/^From$/).first().click({ timeout: 10_000 });
await sleep(800);
await shot("4-from-recents-after");

// (5) Swap with a typed start: From/To trade places, plan re-runs.
await page.keyboard.press("Escape");
await sleep(600);
await page.getByRole("button", { name: "Swap start and destination", exact: true }).click({ timeout: 10_000 });
await sleep(4000);
const fromAfter = await page.getByText(/^From$/).first().locator("..").textContent();
const toAfter = await page.getByText(/^To$/).first().locator("..").textContent();
console.log("after swap:", fromAfter, "|", toAfter);
if (!/Union Station/.test(fromAfter) || !/517, Prospect/.test(toAfter)) throw new Error("swap lost the typed start");
await shot("5-swapped", true);

fs.writeFileSync(path.join(OUT, "preview.json"), JSON.stringify({
  swap: { from: fromAfter, to: toAfter }, caption: "From box: recents, saved and popular places before typing; geocoder suggestions while typing",
  base: BASE, errors, recentsBefore: JSON.parse(recents ?? "[]").map((t) => t.toText),
  recentsAfter: JSON.parse(recents2 ?? "[]").map((t) => t.toText), options: rows,
}, null, 2));
await browser.close();
if (errors.length) { console.error("page errors:", errors); process.exit(1); }
