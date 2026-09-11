// Paired (off vs on) over the count replay's rows and rests, per day.
import fs from "node:fs";
const days = process.argv.slice(2);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const f0 = (x) => Number.isNaN(x) ? "-" : x.toFixed(0);
const row = (name, errs) => `${name.padEnd(24)} n=${String(errs.length).padStart(5)} medSigned=${f0(q(errs, .5)).padStart(5)} medAbs=${f0(q(errs.map(Math.abs), .5)).padStart(4)} p25=${f0(q(errs, .25)).padStart(5)} p75=${f0(q(errs, .75)).padStart(5)} busBeat>=120=${(100 * errs.filter((e) => e >= 120).length / Math.max(1, errs.length)).toFixed(1).padStart(4)}% waitsLonger>=120=${(100 * errs.filter((e) => e <= -120).length / Math.max(1, errs.length)).toFixed(1).padStart(4)}%`;
const tot = { off: { all: [], standing: [], s344: [] }, on: { all: [], standing: [], s344: [] }, rests: { off: [], on: [] } };
for (const d of days) {
  const off = JSON.parse(fs.readFileSync(`out-arch-${d}-off.json`, "utf8")), on = JSON.parse(fs.readFileSync(`out-arch-${d}-on.json`, "utf8"));
  const key = (r) => `${r.t}|${r.bus}|${r.stop}`;
  const m = new Map(on.rows.map((r) => [key(r), r]));
  const pairs = []; for (const r of off.rows) { const o = m.get(key(r)); if (o) pairs.push([r, o]); }
  console.log(`\n=== ${d}: paired rows ${pairs.length} (off rows ${off.rows.length}, on rows ${on.rows.length})`);
  for (const [name, f] of [["all", () => true], ["standing", (r) => r.standingAt >= 0], ["standing@344 (idx of 11)", (r) => r.standingAt >= 0 && r.s344], ["moving", (r) => r.standingAt < 0]]) {
    const A = pairs.filter(([a]) => f(a)).map(([a]) => a.err), B = pairs.filter(([a]) => f(a)).map(([, b]) => b.err);
    console.log(row(`off ${name}`, A)); console.log(row(`on  ${name}`, B));
    if (name === "all") { tot.off.all.push(...A); tot.on.all.push(...B); } if (name === "standing") { tot.off.standing.push(...A); tot.on.standing.push(...B); }
  }
  const ch = pairs.filter(([a, b]) => Math.abs(a.eta - b.eta) > 0.5);
  console.log(`rows where the shown number differs: ${ch.length} (${(100 * ch.length / pairs.length).toFixed(1)}%); on - off median ${f0(q(ch.map(([a, b]) => b.eta - a.eta), .5))} p10 ${f0(q(ch.map(([a, b]) => b.eta - a.eta), .1))} p90 ${f0(q(ch.map(([a, b]) => b.eta - a.eta), .9))}`);
  const lr = (s) => s.filter((x) => x.durSec >= 60);
  const ro = lr(off.sums), rn = lr(on.sums);
  console.log(`rests >= 60 s: off ${ro.length} rises/rest ${(ro.reduce((a, s) => a + s.rises, 0) / Math.max(1, ro.length)).toFixed(2)} | on ${rn.length} rises/rest ${(rn.reduce((a, s) => a + s.rises, 0) / Math.max(1, rn.length)).toFixed(2)}, rests with >1 rise ${rn.filter((s) => s.rises > 1).length}, max rise ${f0(Math.max(0, ...rn.map((s) => s.maxRise)))} s, rise >= 180 s on ${rn.filter((s) => s.maxRise >= 180).length} rests, rise >= 60 s on ${rn.filter((s) => s.maxRise >= 60).length}`);
  tot.rests.off.push(...ro); tot.rests.on.push(...rn);
}
console.log(`\n=== ALL DAYS`);
console.log(row("off all", tot.off.all)); console.log(row("on  all", tot.on.all)); console.log(row("off standing", tot.off.standing)); console.log(row("on  standing", tot.on.standing));
const rn = tot.rests.on; console.log(`rests >= 60 s: ${rn.length}; on: rises/rest ${(rn.reduce((a, s) => a + s.rises, 0) / Math.max(1, rn.length)).toFixed(2)}, >1 rise ${rn.filter((s) => s.rises > 1).length}, rise>=180 ${rn.filter((s) => s.maxRise >= 180).length}, rise>=60 ${rn.filter((s) => s.maxRise >= 60).length}; off: rises/rest ${(tot.rests.off.reduce((a, s) => a + s.rises, 0) / Math.max(1, tot.rests.off.length)).toFixed(2)}`);
