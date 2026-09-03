// Renders report.md + report.json from replay-postfix.json, replay-21d.json and gps.json.
import fs from "node:fs";

const DIR = process.env.REPLAY_OUT ?? "./scripts/.eta-replay";
const post = JSON.parse(fs.readFileSync(`${DIR}/replay-postfix.json`, "utf8"));
const full = JSON.parse(fs.readFileSync(`${DIR}/replay-21d.json`, "utf8"));
const gps = JSON.parse(fs.readFileSync(`${DIR}/gps.json`, "utf8"));

const f1 = (x) => (x === null || x === undefined || Number.isNaN(x) ? "–" : (Math.round(x * 10) / 10).toString());
const row = (cells) => `| ${cells.join(" | ")} |`;
const table = (header, rows) => [row(header), row(header.map(() => "---")), ...rows.map(row)].join("\n");
const m = (x) => [x.n, f1(x.medianAbsSec), f1(x.p90AbsSec), f1(x.meanSignedSec), f1(x.medianSignedSec), f1(x.within60), f1(x.within120)];
const MH = ["n", "median abs (s)", "p90 abs (s)", "mean signed (s)", "median signed (s)", "within 60 s %", "within 120 s %"];
const short = (n) => n.split(" (")[0];

const L = [];
L.push(`# ETA accuracy replay — what riders see vs what actually happened`);
L.push(``);
L.push(`Generated ${new Date().toISOString()} from the read-only production snapshot (2026-09-02 20:16 ET). Scripts: \`${DIR}/eta-replay.ts\` (arrivals replay), \`${DIR}/gps-replay.ts\` (GPS replay), \`${DIR}/common.ts\` (time-travelled calibration engine). Nothing in the repository was modified.`);
L.push(``);
L.push(`Error convention everywhere: **error = predicted − actual, in seconds; negative = the app was optimistic (bus came later than promised).**`);
L.push(``);
L.push(`## 1. Headline`);
L.push(``);
const b = post.baseline;
L.push(`- **Calibration is near the floor of what per-segment history can give.** Replaying the exact client arithmetic against ${post.counts.pairs.toLocaleString()} (prediction, actual) pairs in the clean window: median |error| **${b.overall.medianAbsSec} s** over 1–10 stops ahead, **${b.k1to5.medianAbsSec} s** for 1–5 stops ahead, **${b.byHops[1].medianAbsSec} s** for the next stop (${b.byHops[1].within60}% within 60 s). Twenty-eight alternative estimators (hour-only / weekday-weekend windows, 7-day prior, shrinkage k 2–16, window medians, recent-traffic shrink, route drift, own-bus pace) move the median by at most **−1.9 s** (recent-traffic) and most make it worse; no calibration change is worth shipping on its own.`);
L.push(`- **The bias is real but small at the segment level**: mean signed ${b.overall.meanSignedSec} s (median ${b.overall.medianSignedSec} s) in the clean window, growing from ${b.byHops[1].meanSignedSec} s at 1 stop to ${b.byHops[10].meanSignedSec} s at 10 stops (≈ −6 s per hop). This window is the first three days of the semester, when buses ran slower than the 30-day summer history; the 21-day window shows the opposite sign (+${full.baseline.overall.meanSignedSec} s).`);
const g = gps.truths.prox;
L.push(`- **The rider-visible error is dominated by the client's live-state handling, not by calibration.** Replaying every raw GPS position (${gps.counts.obs.toLocaleString()} positions, 7 h) through the real \`computeUpcomingArrivals\`: median |error| **${g.chord.overall.medianAbsSec} s** for the next 1–5 stops, mean signed **${g.chord.overall.meanSignedSec} s**. Two mechanisms explain most of it:`);
L.push(`  1. **Stall credit over-corrects.** A bus dwelling at a stop (${gps.atStopShare}% of all positions) has every elapsed second subtracted from its first hop, so the longer it sits the more optimistic the promise: median signed error for the next stop goes from ${g.k1ByDwellElapsed.chord["0-30s"].medianSignedSec} s (dwelling < 30 s) to ${g.k1ByDwellElapsed.chord["120-300s"].medianSignedSec} s (2–5 min) to **${g.k1ByDwellElapsed.chord["300s+"].medianSignedSec} s** (> 5 min). Capping the credit at half the segment's calibrated time cuts the at-stop next-stop median |error| from **${g.chord.atStopK1.medianAbsSec} s to ${g.cappedStallHalfSeg.atStopK1.medianAbsSec} s** and the median bias from ${g.chord.atStopK1.medianSignedSec} s to ${g.cappedStallHalfSeg.atStopK1.medianSignedSec} s; overall GPS median ${g.chord.overall.medianAbsSec} → ${g.cappedStallHalfSeg.overall.medianAbsSec} s (quarter-segment cap: ${g.cappedStallQuarterSeg.overall.medianAbsSec} s, bias ${g.cappedStallQuarterSeg.overall.meanSignedSec} s). This is the "wait leg 20–25% optimistic" the live harness reported.`);
L.push(`  2. **Anchor failures on long-leg routes.** Where the client's anchor disagrees with the detector's position (${f1((100 * g.chord.anchorDisagrees.n) / (g.chord.anchorDisagrees.n + g.chord.anchorAgrees.n))}% of pairs; Green ${g.anchorDisagreeShareByRoute["Green (Green - West Campus)"]}%, Purple ${g.anchorDisagreeShareByRoute["Purple (Purple - West Campus)"]}%, Orange East ${g.anchorDisagreeShareByRoute["Orange East (Orange East)"]}%, Pink ${g.anchorDisagreeShareByRoute["Pink (Pink - VA Hospital / Med School)"]}%) the median |error| is **${g.chord.anchorDisagrees.medianAbsSec} s** vs ${g.chord.anchorAgrees.medianAbsSec} s when they agree. Anchoring the bus where the detector has it (an upper bound) takes the overall GPS median from ${g.chord.overall.medianAbsSec} to ${g.oracleAnchor.overall.medianAbsSec} s and the mean bias from ${g.chord.overall.meanSignedSec} to ${g.oracleAnchor.overall.meanSignedSec} s.`);
L.push(`- **Own-bus "live pace" (rider report #64) makes things worse**: +${post.variants.find((v) => v.name === "V6 livePace").paired.deltaMedianAbsSec} s median at full strength, +${post.variants.find((v) => v.name === "V6b livePace sqrt").paired.deltaMedianAbsSec} s at half strength, in the clean window (and +${full.variants.find((v) => v.name === "V6 livePace").paired.deltaMedianAbsSec} / +${full.variants.find((v) => v.name === "V6b livePace sqrt").paired.deltaMedianAbsSec} s over 21 days). Three hops of one bus are too noisy to extrapolate.`);
L.push(`- **Road-path proration is no better than the chord** (${g.path.overall.medianAbsSec} vs ${g.chord.overall.medianAbsSec} s); removing proration is much worse (${g.none.overall.medianAbsSec} s). Keep the chord.`);
L.push(``);

L.push(`## 2. Method`);
L.push(``);
L.push(`**Arrivals replay (\`eta-replay.ts\`).** For every detector arrival of bus *B* (keyed on \`bus_name\`, per route) at route position *i* at time *t0*, the chain of its subsequent arrivals is walked by POSITION in the route's stop sequence (repeated stops on routes 9/10 resolved by the smallest forward hop, preferring hops ≤ 2 = the detector's lookahead; a forward hop must also be the shorter way round the loop). Pairs are (origin *i*, target *i+k*, k = 1..10) with the actual = the bus's real arrival at that position. The prediction is the client's exact arithmetic for a bus standing at a stop (stall credit 0, proration 1): Σ over hops of \`seg.avg\` when the payload's \`n ≥ 1\`, else the client's \`avgSeg\` / distance-at-6 m/s fallback (\`web/src/arrivals.ts\`). The payload is what \`buildBusesPayload\` would have served at the **start of t0's ET hour**: the real \`computeSegmentStats\` (with the real \`TransitNetwork\`, so the 22 m/s plausibility filter applies) fed from segment rows that had **completed** before that instant (stricter than \`started_at <\` — a sample still in flight is not in the DB yet), 30-day window, dow + hour±1 slice, k = 8, distance prior for omitted pairs, \`round1\` rounding. ${post.counts.buckets + full.counts.buckets} hour buckets were calibrated; a from-scratch replica of the calibrator agreed with the real function on **every** group in every bucket (max |diff| 0), and the replica is what the variants are built on. Every variant scores the **same** pairs. No sampling: every origin was evaluated (${post.counts.origins.toLocaleString()} origins in the clean window, ${full.counts.origins.toLocaleString()} in 21 days).`);
L.push(``);
L.push(`**Two windows.** The detector was rewritten and deployed in the 08-31 13:00 ET hour (lookahead-bounded anchoring, \`bus_name\` keying): the share of consecutive arrivals that jump backwards/flicker drops from ~30% to ~6% at that hour. Before it, the arrivals table (the ground truth here) is polluted by (N)/(S) twin-stop flicker, so the **clean window 2026-08-31 14:00 → 09-02 20:15 (${post.counts.pairs.toLocaleString()} pairs)** is the primary evaluation and the **21-day window 08-12 → 09-02 (${full.counts.pairs.toLocaleString()} pairs)** is reported for breadth with that caveat. The calibration a rider sees today is built from the same mixed-quality 30 days, so the replay is faithful to production either way.`);
L.push(``);
L.push(`**GPS replay (\`gps-replay.ts\`).** Every raw position in the 7 h retained (${gps.window.start} → ${gps.window.end} ET) is turned into the exact \`BusData\` the payload would carry (\`at_stop_id\`/\`at_stop_since\` reconstructed by running the real detector \`stepMany\` and the collector's 15 s / 75 m rule), route paths registered via \`registerRoutePaths\`, and the REAL \`findRouteAnchor\` + \`computeUpcomingArrivals\` called with the time-travelled payload (segments and, for the stall-cap variant, dwells). A replica of the loop reproduced the real function's ETAs exactly (max diff 0) and is used for the proration/stall variants. Targets are the next 1–5 positions after the client's anchor. Two ground truths: **detector** (the arrivals table — fires at the midpoint before the stop, median 25 s before the bus is physically there) and **proximity** (first entry within 50 m of the stop on the bus's own GPS track, 120 m hysteresis; the pass is identified from the detector's sequence so twin stops, repeated stops and a lagging client anchor are matched to the right pass; ${gps.counts.noProximity.toLocaleString()} of ${(gps.counts.scored + gps.counts.noDetector).toLocaleString()} targets had no 50 m pass and are scored on the detector truth only). Proximity is the primary truth (it is what a rider at the stop experiences).`);
L.push(``);

L.push(`## 3. Baseline — the estimator riders see today`);
L.push(``);
L.push(`### 3.1 Clean window (${post.window.start} → ${post.window.end} ET), arrivals replay`);
L.push(``);
L.push(table(["slice", ...MH], [["all pairs (k = 1..10)", ...m(b.overall)], ["k = 1..5", ...m(b.k1to5)], ["clean chains only (no bus_id reissue / re-anchor between origin and target)", ...m(b.cleanOnly)]]));
L.push(``);
L.push(`Relative error (k ≤ 5, % of actual, actual floored at 30 s): median |rel| ${b.relativePctK1to5.medianAbsSec}%, mean signed ${b.relativePctK1to5.meanSignedSec}%, median signed ${b.relativePctK1to5.medianSignedSec}%.`);
L.push(``);
L.push(`**By stops ahead (k):**`);
L.push(``);
L.push(table(["k", ...MH], Object.entries(b.byHops).map(([k, v]) => [k, ...m(v)])));
L.push(``);
L.push(`**By how far out the promise was (actual time to arrival):**`);
L.push(``);
L.push(table(["horizon", ...MH], Object.entries(b.byHorizon).map(([k, v]) => [k, ...m(v)])));
L.push(``);
L.push(`**By route** (all k; k1 and k5 medians/bias):`);
L.push(``);
L.push(table(["route", "n", "median abs", "mean signed", "median signed", "k1 median", "k1 bias", "k5 median", "k5 bias"], Object.entries(b.byRoute).map(([r, v]) => [r, v.n, f1(v.medianAbsSec), f1(v.meanSignedSec), f1(v.medianSignedSec), f1(v.k1.medianAbsSec), f1(v.k1.meanSignedSec), f1(v.k5.medianAbsSec), f1(v.k5.meanSignedSec)])));
L.push(``);
L.push(`**By ET hour of prediction** (n / median abs / mean signed): ${Object.entries(b.byHour).map(([h, v]) => `${h}h ${v.n}/${f1(v.medianAbsSec)}/${f1(v.meanSignedSec)}`).join(" · ")}`);
L.push(``);
L.push(`Payload \`n\` seen by the client for the next 5 hops (share of hops): n = 0: ${post.discards.servedNShareK1to5.n0pct}% (client used avgSeg ${post.discards.servedNShareK1to5.n0_usedAvgSegPct}%, distance ${post.discards.servedNShareK1to5.n0_usedDistancePct}%), n = 1: ${post.discards.servedNShareK1to5.n1pct}%, n ≥ 2: ${post.discards.servedNShareK1to5.n2pluspct}%. Over 21 days n = 0 was ${full.discards.servedNShareK1to5.n0pct}% (mid-August had thin same-weekday history).`);
L.push(``);
L.push(`### 3.2 21-day window (${full.window.start} → ${full.window.end} ET) — old-detector ground truth before 08-31 13:00`);
L.push(``);
const fb = full.baseline;
L.push(table(["slice", ...MH], [["all pairs (k = 1..10)", ...m(fb.overall)], ["k = 1..5", ...m(fb.k1to5)], ["clean chains only", ...m(fb.cleanOnly)]]));
L.push(``);
L.push(table(["k", ...MH], Object.entries(fb.byHops).map(([k, v]) => [k, ...m(v)])));
L.push(``);
L.push(table(["route", "n", "median abs", "mean signed", "median signed", "k1 median", "k1 bias", "k5 median", "k5 bias"], Object.entries(fb.byRoute).map(([r, v]) => [r, v.n, f1(v.medianAbsSec), f1(v.meanSignedSec), f1(v.medianSignedSec), f1(v.k1.medianAbsSec), f1(v.k1.meanSignedSec), f1(v.k5.medianAbsSec), f1(v.k5.meanSignedSec)])));
L.push(``);
L.push(`Routes with large positive multi-hop bias here (Blue Night, Brown, Orange East, the grocery routes) are the twin-stop flicker of the old detector creating early "arrivals" in the ground truth; the same routes look ordinary in the clean window.`);
L.push(``);

L.push(`## 4. Variants — same pairs, different estimator`);
L.push(``);
L.push(`"paired Δ median" = change in overall median |error| vs baseline (negative = better); "better/worse" = share of pairs whose |error| moved by more than 1 s in each direction.`);
L.push(``);
const vrow = (v) => [v.name, f1(v.overall.medianAbsSec), f1(v.overall.p90AbsSec), f1(v.overall.meanSignedSec), f1(v.overall.medianSignedSec), f1(v.overall.within120), f1(v.k1to5.medianAbsSec), f1(v.k1to5.meanSignedSec), f1(v.paired.deltaMedianAbsSec), `${v.paired.pctPairsBetter}/${v.paired.pctPairsWorse}`];
const VH = ["variant", "median abs", "p90 abs", "mean signed", "median signed", "within 120 s %", "k≤5 median", "k≤5 bias", "paired Δ median", "better/worse %"];
L.push(`### 4.1 Clean window (n = ${post.counts.pairs.toLocaleString()})`);
L.push(``);
L.push(table(VH, [["baseline", f1(b.overall.medianAbsSec), f1(b.overall.p90AbsSec), f1(b.overall.meanSignedSec), f1(b.overall.medianSignedSec), f1(b.overall.within120), f1(b.k1to5.medianAbsSec), f1(b.k1to5.meanSignedSec), "0", "–"], ...post.variants.map(vrow)]));
L.push(``);
L.push(`### 4.2 21-day window (n = ${full.counts.pairs.toLocaleString()})`);
L.push(``);
L.push(table(VH, [["baseline", f1(fb.overall.medianAbsSec), f1(fb.overall.p90AbsSec), f1(fb.overall.meanSignedSec), f1(fb.overall.medianSignedSec), f1(fb.overall.within120), f1(fb.k1to5.medianAbsSec), f1(fb.k1to5.meanSignedSec), "0", "–"], ...full.variants.map(vrow)]));
L.push(``);
L.push(`**Variant definitions.**`);
L.push(``);
for (const v of post.variants) L.push(`- **${v.name}** — ${v.description}`);
L.push(``);
L.push(`Reading: window shape (V2/V3) and shrinkage strength (V5) are within ±1 s of each other; the mean-of-window estimator is the right choice for bias (window/30-day medians V7/V0/V2c cut the median |error| by 2–5 s over 21 days but are 30–60 s optimistic, and lose in the clean window); recency (V4 7-day prior, V8 recent-traffic shrink, V11 both) is the only calibration-side change that is consistently ≥ 1 s better in both windows, and it is worth at most ~2 s. Live pace (V6) and route drift (V10) trade a little bias for a lot of variance.`);
L.push(``);

L.push(`## 5. GPS replay — the real client on every logged position (${gps.window.start} → ${gps.window.end} ET, ${gps.counts.obs.toLocaleString()} positions, ${gps.counts.scored.toLocaleString()} scored (position, target) pairs, next 1–5 stops)`);
L.push(``);
L.push(`Modes: **chord** = what ships (chord proration, full stall credit); **none** = no proration; **path** = proration by fraction of the road polyline covered; **chordNoStall** = no stall credit; **cappedStallDwell** = credit ≤ the served dwell median (2×: twice it); **cappedStallHalfSeg / QuarterSeg** = credit ≤ 0.5 / 0.25 of the hop's \`seg.avg\`; **oracleAnchor** = chord + full stall but the bus anchored where the detector has it (an upper bound on anchor fixes; its target set differs slightly, n = ${g.oracleAnchor.overall.n.toLocaleString()}).`);
L.push(``);
for (const truth of ["prox", "det"]) {
  const t = gps.truths[truth];
  L.push(`### 5.${truth === "prox" ? 1 : 2} ${truth === "prox" ? "Proximity truth (bus physically within 50 m)" : "Detector truth (arrivals table)"}`);
  L.push(``);
  const modes = Object.keys(t).filter((k) => t[k].overall && t[k].atStopK1);
  L.push(table(["mode", "n", "median abs", "p90 abs", "mean signed", "median signed", "within 120 s %", "at-stop k1 median / mean / median signed", "moving k1 median / mean / median signed", "non-West-Campus median / bias", "West Campus (Green+Purple) median / bias"],
    [...modes.map((md) => { const x = t[md]; return [md, x.overall.n, f1(x.overall.medianAbsSec), f1(x.overall.p90AbsSec), f1(x.overall.meanSignedSec), f1(x.overall.medianSignedSec), f1(x.overall.within120), `${f1(x.atStopK1.medianAbsSec)} / ${f1(x.atStopK1.meanSignedSec)} / ${f1(x.atStopK1.medianSignedSec)}`, `${f1(x.movingK1.medianAbsSec)} / ${f1(x.movingK1.meanSignedSec)} / ${f1(x.movingK1.medianSignedSec)}`, `${f1(x.otherRoutes.medianAbsSec)} / ${f1(x.otherRoutes.meanSignedSec)}`, `${f1(x.westCampusRoutes.medianAbsSec)} / ${f1(x.westCampusRoutes.meanSignedSec)}`]; }),
      ["oracleAnchor", t.oracleAnchor.overall.n, f1(t.oracleAnchor.overall.medianAbsSec), f1(t.oracleAnchor.overall.p90AbsSec), f1(t.oracleAnchor.overall.meanSignedSec), f1(t.oracleAnchor.overall.medianSignedSec), f1(t.oracleAnchor.overall.within120), "–", "–", `${f1(t.oracleAnchor.otherRoutes.medianAbsSec)} / ${f1(t.oracleAnchor.otherRoutes.meanSignedSec)}`, `${f1(t.oracleAnchor.westCampusRoutes.medianAbsSec)} / ${f1(t.oracleAnchor.westCampusRoutes.meanSignedSec)}`]]));
  L.push(``);
  L.push(`By stops ahead, current client (chord): ` + Object.entries(t.chord.byHops).map(([k, v]) => `k${k}: n ${v.n}, median ${f1(v.medianAbsSec)} s, bias ${f1(v.meanSignedSec)} / med ${f1(v.medianSignedSec)} s`).join("; "));
  L.push(``);
  L.push(`Non-West-Campus routes by k (chord → cappedStallHalfSeg, median abs / mean signed): ` + Object.keys(t.chord.otherRoutesByHops).map((k) => `k${k}: ${f1(t.chord.otherRoutesByHops[k].medianAbsSec)}/${f1(t.chord.otherRoutesByHops[k].meanSignedSec)} → ${f1(t.cappedStallHalfSeg.otherRoutesByHops[k].medianAbsSec)}/${f1(t.cappedStallHalfSeg.otherRoutesByHops[k].meanSignedSec)}`).join("; "));
  L.push(``);
  L.push(`Anchor agreement with the detector: agrees n ${t.chord.anchorAgrees.n.toLocaleString()} median ${f1(t.chord.anchorAgrees.medianAbsSec)} s bias ${f1(t.chord.anchorAgrees.meanSignedSec)} s; disagrees n ${t.chord.anchorDisagrees.n.toLocaleString()} median ${f1(t.chord.anchorDisagrees.medianAbsSec)} s bias ${f1(t.chord.anchorDisagrees.meanSignedSec)} s.`);
  L.push(``);
  L.push(`**Next-stop error by how long the bus has been dwelling** (n / median abs / mean signed / median signed):`);
  L.push(``);
  const bins = Object.keys(t.k1ByDwellElapsed.chord);
  L.push(table(["mode", ...bins], ["chord", "chordNoStall", "cappedStallDwell", "cappedStallHalfSeg", "cappedStallQuarterSeg"].map((md) => [md, ...bins.map((bn) => { const v = t.k1ByDwellElapsed[md][bn]; return `${v.n} / ${f1(v.medianAbsSec)} / ${f1(v.meanSignedSec)} / ${f1(v.medianSignedSec)}`; })])));
  L.push(``);
  L.push(`**By route** (median abs / mean signed):`);
  L.push(``);
  L.push(table(["route", "n", "chord", "cappedStallHalfSeg", "chordNoStall", "oracleAnchor", "anchor disagrees % (k1)"], Object.entries(t.byRouteByMode.chord).map(([r, v]) => [short(r), v.n, `${f1(v.medianAbsSec)} / ${f1(v.meanSignedSec)}`, `${f1(t.byRouteByMode.cappedStallHalfSeg[r].medianAbsSec)} / ${f1(t.byRouteByMode.cappedStallHalfSeg[r].meanSignedSec)}`, `${f1(t.byRouteByMode.chordNoStall[r].medianAbsSec)} / ${f1(t.byRouteByMode.chordNoStall[r].meanSignedSec)}`, t.oracleAnchor.byRoute[r] ? `${f1(t.oracleAnchor.byRoute[r].medianAbsSec)} / ${f1(t.oracleAnchor.byRoute[r].meanSignedSec)}` : "–", f1(t.anchorDisagreeShareByRoute[r])])));
  L.push(``);
}
L.push(`Relative next-stop error by k (proximity, chord; % of actual): ` + Object.entries(g.chord.relativePctByHops).map(([k, v]) => `k${k}: median |rel| ${f1(v.medianAbsSec)}%, mean ${f1(v.meanSignedSec)}%, median signed ${f1(v.medianSignedSec)}%`).join("; "));
L.push(``);

L.push(`## 6. Recommendations (ranked by measured gain)`);
L.push(``);
const recs = [
  {
    change: `Cap the stall credit in \`computeUpcomingArrivals\` at a fraction of the hop's calibrated time (0.5 × \`seg.avg\`; 0.25 × is also good), instead of subtracting the whole elapsed dwell. Mirror in \`planner.ts\` if it uses the same board-stop wait.`,
    gain: `GPS replay, proximity truth: at-stop next-stop median |error| ${g.chord.atStopK1.medianAbsSec} → ${g.cappedStallHalfSeg.atStopK1.medianAbsSec} s (quarter: ${g.cappedStallQuarterSeg.atStopK1.medianAbsSec} s), median bias ${g.chord.atStopK1.medianSignedSec} → ${g.cappedStallHalfSeg.atStopK1.medianSignedSec} s (quarter: ${g.cappedStallQuarterSeg.atStopK1.medianSignedSec} s), mean bias ${g.chord.atStopK1.meanSignedSec} → ${g.cappedStallHalfSeg.atStopK1.meanSignedSec} s; all next-1–5-stop pairs median ${g.chord.overall.medianAbsSec} → ${g.cappedStallHalfSeg.overall.medianAbsSec} s (quarter ${g.cappedStallQuarterSeg.overall.medianAbsSec} s), mean bias ${g.chord.overall.meanSignedSec} → ${g.cappedStallHalfSeg.overall.meanSignedSec} s (quarter ${g.cappedStallQuarterSeg.overall.meanSignedSec} s). Detector truth agrees: at-stop k1 ${gps.truths.det.chord.atStopK1.medianAbsSec} → ${gps.truths.det.cappedStallHalfSeg.atStopK1.medianAbsSec} s. For a bus that has sat > 5 min the median next-stop error drops from ${g.k1ByDwellElapsed.chord["300s+"].medianAbsSec} s to ${g.k1ByDwellElapsed.cappedStallHalfSeg["300s+"].medianAbsSec} s.`,
    risk: `Low. A bus that really is about to leave after a long dwell will read up to ~half a hop pessimistic instead of "0 min" — a rider who then sees it pull in early is not harmed. Pure client change; covered by arrivals.test.ts.`,
    files: ["services/shuttle-v2/web/src/arrivals.ts", "services/shuttle-v2/web/src/arrivals.test.ts", "services/shuttle-v2/web/src/planner.ts"],
    effort: "small (one clamp + tests)",
  },
  {
    change: `Fix \`findRouteAnchor\` on routes with long stopless legs and the West Campus spur: measure segment distance against the served route polyline slice for each leg (traceStopLegs) rather than the stop-to-stop chord, and on Green/Purple/Orange East/Pink prefer the candidate consistent with \`last_stop_id\` when several legs are within 150 m. Verify against the detector's index in the GPS replay (script provided).`,
    gain: `Upper bound (oracle anchor, proximity truth): overall GPS median ${g.chord.overall.medianAbsSec} → ${g.oracleAnchor.overall.medianAbsSec} s, mean bias ${g.chord.overall.meanSignedSec} → ${g.oracleAnchor.overall.meanSignedSec} s, non-West-Campus median ${g.chord.otherRoutes.medianAbsSec} → ${g.oracleAnchor.otherRoutes.medianAbsSec} s; the ${f1((100 * g.chord.anchorDisagrees.n) / (g.chord.anchorDisagrees.n + g.chord.anchorAgrees.n))}% of pairs where the anchor disagrees have median |error| ${g.chord.anchorDisagrees.medianAbsSec} s (bias ${g.chord.anchorDisagrees.meanSignedSec} s) vs ${g.chord.anchorAgrees.medianAbsSec} s otherwise. Green stays bad even with the oracle (${f1(g.oracleAnchor.byRoute["Green (Green - West Campus)"].medianAbsSec)} s) — its stop sequence/path model needs its own look.`,
    risk: `Medium. This is the most bug-prone code in the app (reports #27/#32/#37/#38 all landed here); every change must be replayed against the detector index before shipping. Gains are concentrated on Purple/Green/Orange East/Pink.`,
    files: ["services/shuttle-v2/web/src/anchor.ts", "services/shuttle-v2/web/src/anchor.test.ts", "services/shuttle-v2/web/src/geo.ts"],
    effort: "medium",
  },
  {
    change: `Recency on the server: prior = 7-day median when ≥ 5 samples (else 30-day), and shrink each hop toward the last hour's completed samples on that segment (k = 2); let the client trust the served avg when n = 0 (drop the avgSeg/distance fallback; the server already serves the 30-day median or a distance prior).`,
    gain: `Arrivals replay: median |error| ${b.overall.medianAbsSec} → ${post.variants.find((v) => v.name.startsWith("V11")).overall.medianAbsSec} s clean window (${fb.overall.medianAbsSec} → ${full.variants.find((v) => v.name.startsWith("V11")).overall.medianAbsSec} s over 21 days), paired Δ ${post.variants.find((v) => v.name.startsWith("V11")).paired.deltaMedianAbsSec} / ${full.variants.find((v) => v.name.startsWith("V11")).paired.deltaMedianAbsSec} s; bias ${b.overall.meanSignedSec} → ${post.variants.find((v) => v.name.startsWith("V11")).overall.meanSignedSec} s. V1 alone (client trusts served prior): ${full.variants[0].paired.deltaMedianAbsSec} s over 21 days, ${post.variants[0].paired.deltaMedianAbsSec} s clean. Small but consistent (better on ${post.variants.find((v) => v.name.startsWith("V11")).paired.pctPairsBetter}% of pairs vs worse on ${post.variants.find((v) => v.name.startsWith("V11")).paired.pctPairsWorse}%).`,
    risk: `Low–medium. The recent-hour shrink needs a per-segment recent index in the calibrator (every 5 min is fine) and a second payload field or a different \`avg\`; the 7-day prior is a one-line change in computeSegmentStats. Gain is ~2 s — do it after 1 and 2, not instead.`,
    files: ["services/shuttle-v2/src/calibrator/calibrator.ts", "services/shuttle-v2/src/calibrator/calibrator.test.ts", "services/shuttle-v2/web/src/arrivals.ts", "services/shuttle-v2/web/src/planner.ts"],
    effort: "small–medium",
  },
  {
    change: `Do NOT build: own-bus live pace (report #64), route-level drift factors, window/30-day medians, road-path proration, hour-only or weekday/weekend windows, other shrinkage k.`,
    gain: `Measured losses or no gain: live pace +${post.variants.find((v) => v.name === "V6 livePace").paired.deltaMedianAbsSec} s (half-strength +${post.variants.find((v) => v.name === "V6b livePace sqrt").paired.deltaMedianAbsSec} s); route drift +${post.variants.find((v) => v.name === "V10 routeDrift 2h").paired.deltaMedianAbsSec} s; medians −${Math.abs(post.variants.find((v) => v.name === "V7 windowMedian").paired.deltaMedianAbsSec)}…+${post.variants.find((v) => v.name === "V0 medianOnly+servedPrior").paired.deltaMedianAbsSec} s with 30–60 s optimistic bias; path proration ${g.path.overall.medianAbsSec} vs ${g.chord.overall.medianAbsSec} s; hour-only ${post.variants.find((v) => v.name === "V2 hourOnly").paired.deltaMedianAbsSec} s clean / ${full.variants.find((v) => v.name === "V2 hourOnly").paired.deltaMedianAbsSec} s 21-day; k = 2/4/16 within ±1 s.`,
    risk: `–`,
    files: [],
    effort: "none",
  },
  {
    change: `Log predictions (\`predictions_log\` is empty) or, cheaper, keep this replay as a script under \`scripts/\` and run it after any calibrator/anchor change; it takes ~90 s for 21 days and 15 s for the GPS replay on the Pi.`,
    gain: `Not an accuracy gain; it is what makes the next change measurable. The live harness (eta-accuracy.mjs) yields ~10 pairs per run; this yields 98k.`,
    risk: `Low.`,
    files: ["services/shuttle-v2/scripts/"],
    effort: "small",
  },
];
recs.forEach((r, i) => {
  L.push(`### ${i + 1}. ${r.change}`);
  L.push(``);
  L.push(`- **Measured gain:** ${r.gain}`);
  L.push(`- **Risk:** ${r.risk}`);
  L.push(`- **Files:** ${r.files.length ? r.files.map((f) => `\`${f}\``).join(", ") : "–"}`);
  L.push(`- **Effort:** ${r.effort}`);
  L.push(``);
});

L.push(`## 7. Could not measure / limitations`);
L.push(``);
const limits = [
  `Ground truth is the detector's own "nearest stop changed" event, which fires at the midpoint before a stop (median 25 s, p75 60 s before the bus is physically within 50 m). The arrivals replay is self-consistent (calibration samples are defined the same way) so its bias numbers are estimator bias, but its absolute errors are about midpoint-to-midpoint times, not curb-to-curb. The GPS replay's proximity truth is curb-level but covers only 7 h of one weekday afternoon/evening (13:14–20:16 ET) — no morning peak, no weekend.`,
  `Arrivals before the 08-31 13:00 detector deploy carry twin-stop flicker; the 21-day tables are contaminated on Blue Night, Brown, Orange East, Pink and the grocery routes (a 5-stop loop cannot even distinguish a 2-stop backward flicker from a 3-hop advance without the shorter-way-round rule added here). ${full.discards.hopTooFar.toLocaleString()} of ${full.counts.arrivalsLoaded.toLocaleString()} 21-day arrivals broke a chain for this reason (${post.discards.hopTooFar.toLocaleString()} of ${post.counts.arrivalsLoaded.toLocaleString()} in the clean window).`,
  `Time-travel is at hour granularity: the production calibrator runs every 5 min, so production is 0–60 min fresher than the replay. This slightly understates the baseline's (and V8's) use of very recent samples.`,
  `The live-pace variant has no lookahead leakage (it uses only hops completed before t0 and the calibration in force at t0), but it applies the ratio to the whole remaining horizon; a version restricted to the next hop was not tried. Given it loses even at half strength, unlikely to flip.`,
  `Segments with hops ≥ 2 are stored under non-adjacent (from,to) keys and never served — except six 3–5-hop keys on routes 9/10 that coincide with an adjacent pair on the out-and-back (9:25→23, 9:23→24, 10:25→24, 10:24→23, 10:24→25, 10:23→24). Those groups are polluted in production and in this replay alike; not quantified.`,
  `Dwell calibration in the GPS replay was reconstructed (14-day window, median) from \`arrivals.dwell_sec\`; the \`cappedStallDwell\` variant depends on it. The half/quarter-segment caps need no new data.`,
  `Green (route 9) stays at ~200 s median even with a perfect anchor: either its published stop sequence does not match how buses drive the West Campus spur, or the detector's sequence (the truth) is itself unreliable there. Not resolved here.`,
  `Trip-planner wait/ride totals were not replayed end-to-end (planTrip sums the same seg.avg and adds a walk model); the ride-leg estimator is the same arithmetic as the arrivals replay, the wait leg is the GPS replay's k=1 at-stop/moving case.`,
  `The eta-accuracy.mjs harness's headline (1.26 min median) is not directly comparable: it scores the planner's fastest option at one board stop from a browser, ~10 pairs a run; these replays score 98k–447k pairs but are not what a rider literally read on screen.`,
  `No sampling was needed (every origin evaluated). Discards, clean window: ${JSON.stringify(post.discards, null, 0)}. 21-day: ${JSON.stringify(full.discards, null, 0)}.`,
];
for (const l of limits) L.push(`- ${l}`);
L.push(``);
L.push(`## 8. Files`);
L.push(``);
L.push(`- \`${DIR}/report.md\`, \`${DIR}/report.json\` — this report`);
L.push(`- \`${DIR}/replay-postfix.json\`, \`${DIR}/replay-21d.json\` — full arrivals-replay output (by k / route / hour / horizon, all variants)`);
L.push(`- \`${DIR}/gps.json\` — GPS replay output`);
L.push(`- \`${DIR}/eta-replay.ts\`, \`${DIR}/gps-replay.ts\`, \`${DIR}/common.ts\` — run with \`cd services/shuttle-v2 && TZ=America/New_York npx tsx <file>\` (env: EVAL_DAYS, EVAL_START="YYYY-MM-DD HH:MM", OUT_NAME, DEBUG_ROUTE; DIAG=1 for the GPS one)`);

fs.writeFileSync(`${DIR}/report.md`, L.join("\n"));

const out = {
  generatedAt: new Date().toISOString(),
  windows: { clean: post.window, full: full.window, gps: gps.window },
  counts: { clean: post.counts, full: full.counts, gps: gps.counts },
  discards: { clean: post.discards, full: full.discards },
  replicaChecks: { calibrator: { clean: post.discards.replicaCheck, full: full.discards.replicaCheck }, client: gps.replicaCheck },
  baseline: { clean: post.baseline, full: full.baseline },
  variants: { clean: post.variants, full: full.variants },
  gps: gps.truths,
  gpsAtStopShare: gps.atStopShare,
  recommendations: recs,
  limitations: limits,
};
fs.writeFileSync(`${DIR}/report.json`, JSON.stringify(out, null, 1));
console.log(`wrote report.md (${L.length} lines) and report.json`);
