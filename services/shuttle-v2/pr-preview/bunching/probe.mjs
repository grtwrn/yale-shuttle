// The harness that produced the screenshots in this folder. See README.md.
// Iterate bus-2 placements and read the Red card's countdown line.
// One chromium, many page loads. Also measures the countdown span at 390 px.
import fs from "node:fs";
import { chromium } from "playwright-core";
import { seedTestId } from "../../scripts/testId.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8098";
const SC = process.env.OUT_DIR ?? process.cwd();
const basePatch = JSON.parse(fs.readFileSync(process.env.PATCH ?? `${SC}/base-patch.json`, "utf8"));
const ONLY = process.env.ONLY; const scenarios0 = JSON.parse(fs.readFileSync(process.env.SCENARIOS ?? `${SC}/scenarios.json`, "utf8"));
const scenarios = ONLY ? scenarios0.filter((x)=>ONLY.split(",").includes(x.name)) : scenarios0;
const MEASURE = process.env.MEASURE === "1";
const SHOTS = process.env.SHOTS ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOW = Date.now();
const iso = (off) => new Date(NOW + off).toISOString().slice(0, -1);

const payload = await (await fetch(`${BASE}/api/buses`)).json();
const coords = payload.stop_coords;
const BOARD = Number(process.env.BOARD ?? 4), DEST = Number(process.env.DEST ?? 39);
const board = coords[BOARD], dest = coords[DEST];
if (!board || !dest) { console.error("staged server has no stops yet"); process.exit(2); }

const browser = await chromium.launch({
  executablePath: process.env.BOT_CHROMIUM_PATH ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
for (const sc of scenarios) {
  const buses = sc.buses.map((b) => ({
    heading: 0, stationary: false, ...b,
    ...(b.standSec ? {
      at_stop_id: b.at_stop_id ?? b.last_stop_id, stationary: true,
      at_stop_since: iso(-b.standSec * 1000),
      stationary_since: iso(-b.standSec * 1000),
      last_moved_at: iso(-b.standSec * 1000),
    } : { last_moved_at: iso(0) }),
  })).map(({ standSec, ...b }) => b);
  const ctx = await browser.newContext({
    permissions: ["geolocation"],
    geolocation: { latitude: board.lat, longitude: board.lon },
    timezoneId: "America/New_York",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  await seedTestId(ctx);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e.message)));
  const started = Date.now();
  await page.route((u) => u.pathname === "/api/buses", async (route) => {
    const real = await route.fetch();
    let json = {};
    try { json = await real.json(); } catch {}
    // A bus with `moveTo` CREEPS along the leg as the page polls, so the
    // client's belief sees fresh fixes and prices it as moving. A static
    // coordinate repeated every 5 s is, correctly, a standing bus.
    const now = Date.now();
    const live = buses.map((b) => {
      if (!b.moveTo) return b;
      const f = Math.min(1, (now - started) / (b.moveSec * 1000));
      const { moveTo, moveSec, ...rest } = b;
      return { ...rest, lat: b.lat + (moveTo.lat - b.lat) * f, lon: b.lon + (moveTo.lon - b.lon) * f,
        last_moved_at: new Date(now).toISOString().slice(0, -1) };
    });
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ...json, ...basePatch, buses: live }) });
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await sleep(4000);
  const input = page.getByPlaceholder(/where do you want to go/i).first();
  await input.click({ timeout: 20000 });
  await input.fill("");
  await input.type(`${dest.lat},${dest.lon}`, { delay: 20 });
  await sleep(1500);
  await input.press("Enter");
  await sleep(6000);
  const body = await page.evaluate(() => document.body.innerText);
  const lines = body.split("\n").map((l) => l.trim());
  const i = lines.findIndex((l) => /^(Orange Night|Red|Blue Day)$/.test(l));
  console.log(`\n### ${sc.name}`);
  console.log(lines.slice(Math.max(0, i), i + 6).join(" | "));
  if (errs.length) console.log("PAGE ERRORS:", errs.join(" | "));
  fs.writeFileSync(`${SC}/capture-${sc.name}.txt`, body);
  if (SHOTS) {
    await page.getByText("Red", { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: `${SHOTS}/${sc.name}.png`, fullPage: true });
  }
  if (MEASURE && sc.measure) {
    const widths = await page.evaluate(({ PILLS, TEXTS }) => {
      const spans = [...document.querySelectorAll("span")];
      const cands = spans.filter((s) => /·\s*2 buses$/.test(s.textContent.trim())
        && s.children.length === 0 && s.previousElementSibling);
      const eta = cands[0];
      if (!eta) return { error: "no countdown span (" + spans.filter((s) => /2 buses/.test(s.textContent)).length + " candidates)" };
      const pill = eta.previousElementSibling;
      const out = { pillText: pill.textContent, etaText: eta.textContent, avail: eta.clientWidth,
        font: getComputedStyle(eta).font };
      const measure = (pillText, text) => {
        const p0 = pill.textContent, t0 = eta.textContent;
        pill.textContent = pillText; eta.textContent = text;
        void document.body.offsetHeight;
        const r = { pill: pillText, text, need: eta.scrollWidth, avail: eta.clientWidth,
          clipped: eta.scrollWidth > eta.clientWidth + 0.5 };
        pill.textContent = p0; eta.textContent = t0;
        return r;
      };
      out.rows = [];
      for (const pillText of PILLS) for (const t of TEXTS) out.rows.push(measure(pillText, t));
      return out;
    }, { PILLS: JSON.parse(process.env.PILLS ?? '["Orange Night"]'), TEXTS: JSON.parse(fs.readFileSync(process.env.TEXTS, "utf8")) });
    fs.writeFileSync(`${SC}/widths.json`, JSON.stringify(widths, null, 2));
    for (const r of widths.rows ?? []) console.log(`W ${r.clipped ? "CLIP" : "fits"} need=${r.need.toFixed ? r.need.toFixed(0) : r.need} avail=${r.avail} [${r.pill}] "${r.text}"`);
    if (widths.error) console.log("MEASURE ERROR", widths.error);
    else console.log("font:", widths.font);
  }
  if (sc.expand) {
    await page.getByText(/· 2 buses|, then |^in \\d/).first().click({ timeout: 10000 }).catch(() => {});
    await sleep(2500);
    const ex = await page.evaluate(() => document.body.innerText);
    fs.writeFileSync(`${SC}/expanded-${sc.name}.txt`, ex);
    console.log("EXPANDED:", ex.split("\n").map((l) => l.trim()).filter((l) => /stops away|#\d/.test(l)).join(" | "));
  }
  await ctx.close();
}
await browser.close();
