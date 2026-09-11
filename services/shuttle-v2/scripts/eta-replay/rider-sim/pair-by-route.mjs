/**
 * The gate's own arithmetic, per route: for every wait present in BOTH runs,
 * how many riders had each defect FIXED and how many had it INTRODUCED.
 *
 * A total can hide a swap — the selection-only arm's strand total looked
 * survivable while it fixed 229 and introduced 431 — so the acceptance
 * criterion is this split, not the totals.
 *
 *   node scripts/eta-replay/rider-sim/pair-by-route.mjs a.waits.jsonl b.waits.jsonl
 */
import fs from "node:fs";
import readline from "node:readline";

const [fa, fb] = process.argv.slice(2);
if (!fa || !fb) { console.error("usage: pair-by-route.mjs <a.waits.jsonl> <b.waits.jsonl>"); process.exit(2); }

const FLAGS = [
  ["strand", (w) => !!w.strand],
  ["jump>=180", (w) => (w.catastrophic ?? 0) > 0],
  ["reversal", (w) => (w.notableReversals ?? 0) > 0],
  ["dropped", (w) => (w.droppedApproaching ?? 0) > 0],
];

async function load(f) {
  const m = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let w; try { w = JSON.parse(line); } catch { continue; }
    if (!w.id || w.outcome === "gave up early") { /* keep everything the compare keeps */ }
    const id = w.id;
    m.set(id, w);
  }
  return m;
}

const A = await load(fa);
const B = await load(fb);
const routes = new Map();
for (const [id, a] of A) {
  const b = B.get(id);
  if (!b) continue;
  const r = a.label ?? "?";
  let acc = routes.get(r);
  if (!acc) routes.set(r, (acc = { n: 0, ...Object.fromEntries(FLAGS.map(([k]) => [k, { fixed: 0, introduced: 0, both: 0 }])) }));
  acc.n++;
  for (const [k, f] of FLAGS) {
    const x = f(a), y = f(b);
    if (x && !y) acc[k].fixed++;
    else if (!x && y) acc[k].introduced++;
    else if (x && y) acc[k].both++;
  }
}

const names = [...routes.keys()].sort();
console.log(`paired waits ${[...routes.values()].reduce((s, a) => s + a.n, 0)}   (${fa.split("/").pop()} -> ${fb.split("/").pop()})`);
console.log("route            n  " + FLAGS.map(([k]) => k.padStart(16)).join(""));
console.log("                    " + FLAGS.map(() => "  fixed/intro   ".padStart(16)).join(""));
for (const r of names) {
  const a = routes.get(r);
  const cells = FLAGS.map(([k]) => `${a[k].fixed}/${a[k].introduced}`.padStart(16));
  console.log(`${r.padEnd(14)}${String(a.n).padStart(6)}  ${cells.join("")}`);
}
const tot = Object.fromEntries(FLAGS.map(([k]) => [k, { fixed: 0, introduced: 0 }]));
for (const a of routes.values()) for (const [k] of FLAGS) { tot[k].fixed += a[k].fixed; tot[k].introduced += a[k].introduced; }
console.log(`${"ALL".padEnd(14)}${String([...routes.values()].reduce((s, a) => s + a.n, 0)).padStart(6)}  ` +
  FLAGS.map(([k]) => `${tot[k].fixed}/${tot[k].introduced}`.padStart(16)).join(""));
