#!/usr/bin/env node
// Does the Directions button and the ⚠ toggle beside it fit on one row?
//
//   BASE=http://127.0.0.1:8101 OUT=pr-preview/berth-collapsed \
//     BOT_CHROMIUM_PATH=/usr/bin/chromium node scripts/berth-row-measure.mjs
//
// Counting characters is how a wrapping line shipped on 2026-09-03, so the
// wording of that toggle is chosen by measuring the RENDERED controls, at the
// three phone widths this app is checked at. Two things are read:
//
//  1. the real row: both controls' bounding boxes, whether they share a line
//     (equal `top`), and whether either one's text overflows its box;
//  2. every candidate string, laid out in the toggle's own computed font, so a
//     shorter wording can be chosen without a rebuild per candidate.
//
// It prints how much room is left on the row at each width, which is the number
// that decides the wording — and it fails only on a control whose TEXT is
// clipped, because wrapping to two lines is the deliberate fallback below the
// width where the pair fits.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

import { seedTestId } from "./testId.mjs";

const BASE = (process.env.BASE ?? "http://127.0.0.1:8101").replace(/\/$/, "");
const OUT = process.env.OUT ?? "/tmp/berth-collapsed";
const CELL = process.env.CELL ?? "48-3";
const WIDTHS = (process.env.WIDTHS ?? "360,390,430").split(",").map(Number);
/**
 * The wordings considered. The first that fits at 390 px is the one to ship;
 * they are ordered longest-first, because the toggle is the only place the
 * distance is stated while the block is folded.
 */
const CANDIDATES = [
  "⚠ Stops 55 m past the published stop",
  "⚠ Stop is 55 m past",
  "⚠ Stops 55 m past",
  "⚠ 55 m past the stop",
  "⚠ 55 m past",
  "⚠ 55 m",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.BOT_CHROMIUM_PATH ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
await seedTestId(ctx);
const page = await ctx.newPage();

const rows = [];
const bad = [];
for (const w of WIDTHS) {
  await page.setViewportSize({ width: w, height: 844 });
  await page.goto(`${BASE}/?review=berth&cell=${CELL}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: /Directions to/ }).waitFor({ timeout: 30_000 });
  await sleep(600);

  const read = () => page.evaluate((cands) => {
    const dir = document.querySelector('a[href*="maps/dir"]');
    const tog = document.querySelector("button[aria-expanded]");
    const row = dir?.parentElement;
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
    // A control is CLIPPED when its text is wider than the box drawn for it;
    // that is the failure. Two controls on two lines is merely the fallback.
    const clipped = (el) => el.scrollWidth > Math.ceil(el.getBoundingClientRect().width) + 1;
    // Lay each candidate out in the toggle's own font, off-screen, so a
    // wording can be judged without rebuilding the bundle for each one.
    const cs = getComputedStyle(tog);
    const probe = document.createElement("span");
    probe.style.cssText = `position:absolute;left:-9999px;top:0;white-space:nowrap;font:${cs.font};font-weight:${cs.fontWeight};font-size:${cs.fontSize};font-family:${cs.fontFamily}`;
    row.appendChild(probe);
    const widths = {};
    for (const c of cands) { probe.textContent = c; widths[c] = +probe.getBoundingClientRect().width.toFixed(1); }
    probe.remove();
    // What a toggle carrying that string would occupy: text + the chevron, the
    // 4 px gap, 10 px of padding either side and 1.5 px of border either side.
    row.appendChild(probe);
    probe.style.fontSize = "11px";
    probe.textContent = "▾";
    const chev = +probe.getBoundingClientRect().width.toFixed(1);
    probe.remove();
    const chrome = 4 + 2 * 10 + 2 * 1.5;
    // What the Directions button WANTS: `flex: 1 1 auto` stretches it to the
    // row once the toggle has wrapped away, so its rendered width says nothing
    // about whether the pair could have shared the line. A max-content clone
    // does.
    const clone = dir.cloneNode(true);
    clone.style.position = "absolute";
    clone.style.left = "-9999px";
    clone.style.width = "max-content";
    clone.style.flex = "0 0 auto";
    row.appendChild(clone);
    const directionsMin = +clone.getBoundingClientRect().width.toFixed(1);
    // And what a shorter label would want, same clone, same font.
    const dirWidths = {};
    for (const t of ["🧭 Directions to published stop", "🧭 Directions to stop", "🧭 Directions", "Directions"]) {
      clone.textContent = t;
      dirWidths[t] = +clone.getBoundingClientRect().width.toFixed(1);
    }
    clone.remove();
    return {
      directionsMin, directionsCandidateWidths: dirWidths,
      row: box(row), directions: box(dir), toggle: box(tog),
      directionsClipped: clipped(dir), toggleClipped: clipped(tog),
      sameLine: Math.abs(dir.getBoundingClientRect().top - tog.getBoundingClientRect().top) < 2,
      toggleText: tog.innerText.replace(/\n/g, " "),
      directionsText: dir.innerText,
      candidateTextWidths: widths,
      toggleChromePx: chrome,
      chevronPx: chev,
    };
  }, CANDIDATES);

  // BOTH states: the folded row is the one that has to fit, and the open one is
  // where the longer label is allowed to wrap.
  const m = await read();
  await page.locator("button[aria-expanded]").click({ timeout: 10_000 });
  await sleep(1200);
  const opened = await read();
  await page.locator("button[aria-expanded]").click({ timeout: 10_000 });
  await sleep(400);

  // Room for a toggle on this row = the row minus the Directions button at its
  // natural width minus the 8 px gap.
  const roomForToggle = +(m.row.w - m.directionsMin - 8).toFixed(1);
  // With the pair already wrapped, the Directions button has the row to itself,
  // so its own width is not the constraint — the row width is.
  const roomIfOneLine = roomForToggle;
  const fits = Object.fromEntries(Object.entries(m.candidateTextWidths)
    .map(([c, tw]) => [c, { needs: +(tw + m.chevronPx + m.toggleChromePx).toFixed(1), fits: +(tw + m.chevronPx + m.toggleChromePx).toFixed(1) <= roomIfOneLine }]));

  rows.push({
    width: w, ...m, roomForToggle, candidateFitsOneRow: fits,
    open: {
      directionsText: opened.directionsText, toggleText: opened.toggleText,
      directionsMin: opened.directionsMin, toggle: opened.toggle,
      sameLine: opened.sameLine, directionsClipped: opened.directionsClipped,
      toggleClipped: opened.toggleClipped,
    },
  });
  for (const [state, r] of [["closed", m], ["open", opened]]) {
    if (r.directionsClipped) bad.push(`${w}px ${state}: the Directions button's text is clipped`);
    if (r.toggleClipped) bad.push(`${w}px ${state}: the toggle's text is clipped`);
  }
  // The FOLDED row is the one that must not wrap at 390 and above — that is
  // what the operator asked for, and stacking under 360 is the fallback.
  if (w >= 390 && !m.sameLine) bad.push(`${w}px closed: the pair wrapped (${m.directionsMin} + 8 + ${m.toggle.w} of ${m.row.w})`);
  // eslint-disable-next-line no-console
  console.log(`${w}px  row ${m.row.w}`);
  console.log(`   closed  "${m.directionsText}" ${m.directionsMin} + 8 + "${m.toggleText}" ${m.toggle.w} = ${(m.directionsMin + 8 + m.toggle.w).toFixed(1)}  oneRow=${m.sameLine}`);
  console.log(`     open  "${opened.directionsText}" ${opened.directionsMin} + 8 + "${opened.toggleText}" ${opened.toggle.w} = ${(opened.directionsMin + 8 + opened.toggle.w).toFixed(1)}  oneRow=${opened.sameLine}`);
  for (const [c, v] of Object.entries(fits)) console.log(`        ${v.fits ? "fits" : "    "}  ${String(v.needs).padStart(6)} px  ${c}`);
}

const report = { base: BASE, cell: CELL, rows, ok: bad.length === 0, failures: bad };
fs.writeFileSync(path.join(OUT, "row-measure.json"), JSON.stringify(report, null, 2));
// eslint-disable-next-line no-console
console.log(JSON.stringify({
  ok: report.ok, failures: bad,
  perWidth: rows.map((r) => ({ width: r.width, sameLine: r.sameLine, room: r.roomForToggle, toggle: r.toggle.w, fits: r.candidateFitsOneRow })),
}, null, 2));

await ctx.close();
await browser.close();
process.exit(bad.length ? 1 : 0);
