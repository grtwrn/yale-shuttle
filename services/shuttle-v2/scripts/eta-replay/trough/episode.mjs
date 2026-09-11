// Paired off/on shown-number sequence through the longest 344 Winchester rests.
import fs from "node:fs";
const day = process.argv[2];
const dir = process.env.DATA ?? ".";
const off = JSON.parse(fs.readFileSync(`${dir}/out-arch-${day}-off.json`, "utf8"));
const on  = JSON.parse(fs.readFileSync(`${dir}/out-arch-${day}-on.json`, "utf8"));
const k = (r) => `${r.t}|${r.bus}|${r.stop}`;
const M = new Map(on.rows.map((r) => [k(r), r]));
const et = (t) => new Date(t - 4 * 3600e3).toISOString().slice(11, 19);
// Rows the rider would see at Division/Prospect (48) while the pinned bus rests at 344.
const rows = off.rows.filter((r) => r.stop === 48 && r.s344 && r.standingAt >= 0).sort((a, b) => a.bus.localeCompare(b.bus) || a.t - b.t);
const runs = [];
for (const r of rows) {
  const last = runs[runs.length - 1];
  if (last && last.bus === r.bus && r.t - last.rows[last.rows.length - 1].t <= 60000) last.rows.push(r);
  else runs.push({ bus: r.bus, rows: [r] });
}
const long = runs.map((x) => ({ ...x, dur: (x.rows[x.rows.length - 1].t - x.rows[0].t) / 1000 }))
  .filter((x) => x.dur >= 400).sort((a, b) => b.dur - a.dur).slice(0, 5);
console.log(`## ${day}: ${long.length} rests >= 400 s at 344 Winchester seen from stop 48\n`);
for (const r of long) {
  const first = r.rows[0], last = r.rows[r.rows.length - 1];
  console.log(`${r.bus} ${et(first.t)} -> ${et(last.t)} (${r.dur.toFixed(0)} s standing, ${r.rows.length} polls); truth ${first.actual.toFixed(0)} -> ${last.actual.toFixed(0)} s`);
  console.log(`   ET       off   on   truth   on-off`);
  const step = Math.max(1, Math.floor(r.rows.length / 10));
  for (let i = 0; i < r.rows.length; i += step) {
    const a = r.rows[i], b = M.get(k(a));
    console.log(`   ${et(a.t)} ${a.eta.toFixed(0).padStart(5)} ${(b ? b.eta.toFixed(0) : "-").padStart(5)} ${a.actual.toFixed(0).padStart(6)} ${(b ? (b.eta - a.eta).toFixed(0) : "-").padStart(7)}`);
  }
  const errOff = r.rows.map((x) => x.err), errOn = r.rows.map((x) => (M.get(k(x)) ?? x).err);
  const med = (z) => { const s = [...z].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
  console.log(`   median signed error over the rest: off ${med(errOff).toFixed(0)} s, on ${med(errOn).toFixed(0)} s\n`);
}
