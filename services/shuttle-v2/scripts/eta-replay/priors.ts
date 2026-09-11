/**
 * Run:  cd services/shuttle-v2 && TZ=America/New_York REPLAY_DB=./store/snap2.db npx tsx scripts/eta-replay/priors.ts
 * Reads every ~/shuttle-captures/positions-*.jsonl (deduplicated across files). See docs/eta-estimator-design.md.
 */
// PRIORS FOR THE ESTIMATOR, from the corpus with the production detector only (no ETA replay):
//  1. last_stop_id confusion vs the detector's nearest index (a likelihood table, split fresh/frozen fix)
//  2. P(stops | stop): share of passes with >=15 s within 75 m
//  3. running-speed distribution per route on fresh fixes; mid-leg hold share
import fs from "node:fs"; import os from "node:os";
import { loadNet } from "./common.js";
import { planTracks, stepMany, type BusObservation, type BusState } from "../../src/collector/detector.js";
import { distanceMeters } from "../../src/network/geo.js";
const net = loadNet(); const { network } = net;
const dir = `${os.homedir()}/shuttle-captures`; const rows: any[] = []; const seen = new Set<string>();
for (const f of fs.readdirSync(dir).filter((f) => /^positions-\d{8}\.jsonl$/.test(f)).sort()) for (const l of fs.readFileSync(`${dir}/${f}`, "utf8").split("\n")) { if (!l) continue; let r: any; try { r = JSON.parse(l); } catch { continue; } const k = `${r.collected_at}|${r.bus_id}`; if (seen.has(k)) continue; seen.add(k); rows.push(r); }
rows.sort((a, b) => a.collected_at - b.collected_at || a.bus_id - b.bus_id);
const polls: BusObservation[][] = []; { let cur: BusObservation[] = [], at = -1; for (const r of rows) { if (r.collected_at !== at) { if (cur.length) polls.push(cur); cur = []; at = r.collected_at; } cur.push({ busId: r.bus_id, busName: r.bus_name, routeId: r.route_id, lat: r.lat, lon: r.lon, heading: r.heading, lastStopId: r.last_stop_id ?? null, collectedAt: r.collected_at }); } if (cur.length) polls.push(cur); }
console.log(`rows ${rows.length} polls ${polls.length}`);
const states = new Map<string, BusState>(); const prevObs = new Map<string, BusObservation>();
const conf = { fresh: {} as Record<string, number>, frozen: {} as Record<string, number> };
const passes = new Map<string, { n: number; stopped: number }>(); const open = new Map<string, { key: string; idx: number; enteredAt: number; stopped: boolean }>();
const speeds = new Map<string, number[]>(); let midLegPolls = 0, midLegFrozen = 0;
for (const poll of polls) {
  const plan = planTracks(poll); stepMany(network, states, poll, plan);
  for (const o of poll) {
    const key = plan.keys.get(o.busId) ?? o.busName; const st = states.get(key); if (!st) continue;
    const route = net.routeById.get(o.routeId); if (!route) continue; const N = route.stops.length;
    const p = prevObs.get(key); prevObs.set(key, o);
    const dt = p ? (o.collectedAt - p.collectedAt) / 1000 : 0; const moved = p ? distanceMeters(p, o) : 0;
    const frozen = p ? moved < 1e-9 : false;
    // 1. confusion: where is last_stop_id relative to the detector's nearest index?
    if (p && dt <= 20) {
      let cat = "null"; if (o.lastStopId != null) { const li = route.stops.indexOf(o.lastStopId); if (li < 0) cat = "not on route"; else { const d = ((li - st.nearestIndex) % N + N) % N; cat = d === 0 ? "= nearest" : d === N - 1 ? "nearest-1 (lag)" : d === 1 ? "nearest+1 (lead)" : d <= N / 2 ? `lead ${d}` : `lag ${N - d}`; } }
      const b = frozen ? conf.frozen : conf.fresh; b[cat] = (b[cat] ?? 0) + 1;
    }
    // 2. passes
    const dStop = distanceMeters(o, net.stopById.get(st.nearestStopId)!);
    const cur = open.get(key); const pk = `${o.routeId}|${st.nearestStopId}`;
    if (cur && cur.enteredAt === st.enteredAt && cur.idx === st.nearestIndex) { if (o.collectedAt - st.enteredAt >= 15_000 && dStop <= 75) cur.stopped = true; }
    else { if (cur) { const ps = passes.get(cur.key) ?? { n: 0, stopped: 0 }; ps.n++; if (cur.stopped) ps.stopped++; passes.set(cur.key, ps); } open.set(key, { key: pk, idx: st.nearestIndex, enteredAt: st.enteredAt, stopped: false }); }
    // 3. speed on fresh fixes; hold share mid-leg (> 75 m from the nearest stop)
    if (p && dt > 0 && dt <= 20) { if (!frozen) { const l = speeds.get(String(o.routeId)) ?? []; l.push(moved / dt); speeds.set(String(o.routeId), l); } if (dStop > 75) { midLegPolls++; if (frozen) midLegFrozen++; } }
  }
}
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo]! + (s[hi]! - s[lo]!) * (i - lo); };
for (const k of ["fresh", "frozen"] as const) { const b = conf[k]; const tot = Object.values(b).reduce((x, y) => x + y, 0); console.log(`\n== last_stop_id vs detector nearest index, ${k} fix (n=${tot}) ==`); for (const [c, n] of Object.entries(b).sort((x, y) => y[1] - x[1]).slice(0, 8)) console.log(`  ${c.padEnd(18)} ${(100 * n / tot).toFixed(1)}%`); }
const allP = [...passes.values()]; const totN = allP.reduce((a, b) => a + b.n, 0), totS = allP.reduce((a, b) => a + b.stopped, 0);
console.log(`\n== P(stops | pass): ${totS}/${totN} = ${(100 * totS / totN).toFixed(1)}% of passes stop >=15 s within 75 m ==`);
const perStop = [...passes.entries()].filter(([, v]) => v.n >= 20).map(([k, v]) => ({ k, p: v.stopped / v.n, n: v.n }));
console.log(`  stops with n>=20 passes: ${perStop.length}; P(stop) p10/p50/p90 = ${q(perStop.map((x) => x.p), .1).toFixed(2)}/${q(perStop.map((x) => x.p), .5).toFixed(2)}/${q(perStop.map((x) => x.p), .9).toFixed(2)}; share of stops with P<0.5: ${(100 * perStop.filter((x) => x.p < .5).length / perStop.length).toFixed(0)}%`);
for (const x of perStop.sort((a, b) => a.p - b.p).slice(0, 6)) { const [r, s] = x.k.split("|"); console.log(`  most skipped: route ${r} ${net.stopById.get(Number(s))?.name}  P=${x.p.toFixed(2)} n=${x.n}`); }
console.log(`\n== running speed on fresh fixes, m/s p10/p50/p90 per route ==`);
for (const [r, l] of [...speeds.entries()].sort((a, b) => b[1].length - a[1].length)) console.log(`  route ${r.padStart(2)} n=${String(l.length).padStart(6)}  ${q(l, .1).toFixed(1)} / ${q(l, .5).toFixed(1)} / ${q(l, .9).toFixed(1)}`);
console.log(`\n== mid-leg (>75 m from nearest stop) polls frozen: ${midLegFrozen}/${midLegPolls} = ${(100 * midLegFrozen / midLegPolls).toFixed(1)}% (the hold share, by poll) ==`);
