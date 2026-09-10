/**
 * The paired reading of the two belief arms, per route.
 *
 * `pair-by-route.mjs` is THE GATE and is left exactly as it is: strand,
 * jump>=180, reversal, dropped, fixed/introduced, per route. This adds the
 * supporting splits the gate has no flag for — the largest lurches, which is
 * where a cold belief's cost was expected to live — on the same paired
 * population, so nothing here can be read as a substitute for the gate.
 */
import fs from "node:fs";

const [fa, fb] = process.argv.slice(2);
const load = (f) => new Map(fs.readFileSync(f, "utf8").split("\n").filter(Boolean)
  .map((l) => { const w = JSON.parse(l); return [w.id, w]; }));
const A = load(fa), B = load(fb);

const FLAGS = [
  ["jump>=300", (w) => (w.worstDriftSec ?? 0) >= 300],
  ["jump>=600", (w) => (w.worstDriftSec ?? 0) >= 600],
  ["overshoot", (w) => (w.overshoot ?? 0) > 0],
  ["pin wrong", (w) => w.pinCorrect === false],
  ["first-sight |miss|>120", (w) => Math.abs(w.firstSightMissSec ?? 0) > 120],
];
const byRoute = new Map();
const drift = { a: [], b: [] };
for (const [id, a] of A) {
  const b = B.get(id);
  if (!b) continue;
  const r = a.label ?? "?";
  let acc = byRoute.get(r);
  if (!acc) byRoute.set(r, acc = { n: 0, f: FLAGS.map(() => ({ fixed: 0, intro: 0 })) });
  acc.n++;
  FLAGS.forEach(([, fn], i) => {
    const x = fn(a), y = fn(b);
    if (x && !y) acc.f[i].fixed++;
    else if (!x && y) acc.f[i].intro++;
  });
  drift.a.push(a.worstDriftSec ?? 0);
  drift.b.push(b.worstDriftSec ?? 0);
}
const pct = (xs, q) => { const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
console.log(`paired waits ${drift.a.length}   (${fa.split("/").pop()} -> ${fb.split("/").pop()})\n`);
console.log(["route".padEnd(9), "n".padStart(6), ...FLAGS.map(([k]) => k.padStart(24))].join(""));
console.log(" ".repeat(15) + FLAGS.map(() => "fixed/intro".padStart(24)).join(""));
for (const [r, acc] of [...byRoute].sort()) {
  console.log([r.padEnd(9), String(acc.n).padStart(6),
    ...acc.f.map((c) => `${c.fixed}/${c.intro}`.padStart(24))].join(""));
}
const tot = { n: 0, f: FLAGS.map(() => ({ fixed: 0, intro: 0 })) };
for (const acc of byRoute.values()) { tot.n += acc.n; acc.f.forEach((c, i) => { tot.f[i].fixed += c.fixed; tot.f[i].intro += c.intro; }); }
console.log(["ALL".padEnd(9), String(tot.n).padStart(6), ...tot.f.map((c) => `${c.fixed}/${c.intro}`.padStart(24))].join(""));
console.log(`\nworst drift per wait, s:  A p50 ${pct(drift.a, .5)} p90 ${pct(drift.a, .9)} max ${Math.max(...drift.a)}`);
console.log(`                          B p50 ${pct(drift.b, .5)} p90 ${pct(drift.b, .9)} max ${Math.max(...drift.b)}`);
