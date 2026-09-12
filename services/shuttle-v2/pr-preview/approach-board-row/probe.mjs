// Screenshots of the expanded Red card's stop list with a standing bus, and the
// captured innerText the canary fixture is taken from. Adapted from
// pr-preview/eta-band/probe.mjs (same mocked /api/buses, same rider). See README.md.
import fs from "node:fs";
import { chromium } from "playwright-core";
import { seedTestId } from "../../scripts/testId.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8104";
const HERE = new URL(".", import.meta.url).pathname;
const OUT = process.env.OUT_DIR ?? HERE;
const TAG = process.env.TAG ?? "after";
const basePatch = JSON.parse(fs.readFileSync(`${HERE}/base-patch.json`, "utf8"));
const ONLY = process.env.ONLY;
const scenarios = JSON.parse(fs.readFileSync(`${HERE}/scenarios.json`, "utf8"))
  .filter((x) => !ONLY || ONLY.split(",").includes(x.name));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOW = Date.now();
const iso = (off) => new Date(NOW + off).toISOString().slice(0, -1);

const payload = await (await fetch(`${BASE}/api/buses`)).json();
const coords = payload.stop_coords;
const BOARD = Number(process.env.BOARD ?? 48), DEST = Number(process.env.DEST ?? 72);
const board = coords[BOARD], dest = coords[DEST];
if (!board || !dest) { console.error("staged server has no stops yet"); process.exit(2); }

const browser = await chromium.launch({
  executablePath: process.env.BOT_CHROMIUM_PATH ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
try {
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
    // The lookup never leaves the page: the rider types a coordinate and the
    // answer is the destination stop itself.
    await page.route((u) => u.pathname === "/api/geocode", (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ results: [{ display_name: "LEPH / 60 College", lat: String(dest.lat), lon: String(dest.lon), type: "bus_stop", class: "shuttle" }] }),
    }));
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await sleep(4000);
    const input = page.getByPlaceholder(/where do you want to go/i).first();
    await input.click({ timeout: 20000 });
    await input.fill("");
    await input.type(`${dest.lat},${dest.lon}`, { delay: 20 });
    await sleep(1500);
    await input.press("Enter");
    await sleep(6000);
    // Open the Red card.
    await page.getByText("Red", { exact: true }).last().click({ timeout: 10000 }).catch((e) => console.log("expand click failed", e.message));
    await sleep(3000);
    const body = await page.evaluate(() => document.body.innerText);
    fs.writeFileSync(`${OUT}/${TAG}-${sc.name}.txt`, body);
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
    const from = lines.findIndex((l) => /stops? away$/.test(l));
    const to = lines.findIndex((l, i) => i > from && /^GET OFF/.test(l));
    const top = lines.findIndex((l) => /^in |^now|^arriving/.test(l));
    console.log(`\n### ${TAG} ${sc.name}`);
    console.log("row:  ", lines[top]);
    console.log("map:  ", lines.filter((l) => /^🚌 \(R\)/.test(l)).join(" | "));
    console.log("list: ", from >= 0 ? lines.slice(from, (to >= 0 ? to : from + 8) + 1).join("\n        ") : "(no approach list)");
    if (errs.length) console.log("PAGE ERRORS:", errs.join(" | "));
    // The stop list, clipped: from the "N stops away" header down to GET OFF.
    const clip = await page.evaluate(() => {
      const all = [...document.querySelectorAll("div")];
      const head = all.filter((d) => /stops? away$/.test((d.innerText || "").trim()) && d.children.length === 0)[0];
      const getOff = [...document.querySelectorAll("span")].filter((s) => (s.textContent || "") === "GET OFF")[0];
      if (!head || !getOff) return null;
      head.scrollIntoView({ block: "center" });
      const a = head.getBoundingClientRect(), b = getOff.getBoundingClientRect();
      return { x: 0, y: a.top - 10, width: 390, height: b.bottom - a.top + 20 };
    });
    await sleep(500);
    if (clip) {
      const c = await page.evaluate(() => {
        const head = [...document.querySelectorAll("div")].filter((d) => /stops? away$/.test((d.innerText || "").trim()) && d.children.length === 0)[0];
        const getOff = [...document.querySelectorAll("span")].filter((s) => (s.textContent || "") === "GET OFF")[0];
        const a = head.getBoundingClientRect(), b = getOff.getBoundingClientRect();
        return { x: 0, y: Math.max(0, a.top - 10), width: 390, height: b.bottom - a.top + 20 };
      });
      await page.screenshot({ path: `${OUT}/${TAG}-${sc.name}-list.png`, clip: c });
    }
    // The whole expanded card, top line to stop list, as one page.
    await page.screenshot({ path: `${OUT}/${TAG}-${sc.name}-page.png`, fullPage: true });
    // Board row geometry at 390 px: does it hold one line?
    const geo = await page.evaluate(() => {
      const tag = [...document.querySelectorAll("span")].filter((s) => (s.textContent || "") === "BOARD")[0];
      const row = tag?.parentElement;
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { text: row.textContent, width: Math.round(r.width), height: Math.round(r.height) };
    });
    console.log("board row:", JSON.stringify(geo));
    await ctx.close();
  }
} finally {
  await browser.close();
}
