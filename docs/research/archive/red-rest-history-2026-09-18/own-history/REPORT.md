# Own previous rests and Red Winchester release

**Follow-up completed:** the [full pickup replay](../full-pickup/REPORT.md) found a smaller rider-facing gain: supported Division pickup MAE79.22→76.90seconds, with window width473.38→471.19seconds overall and slightly wider windows today. The component result below remains valid, but it is not a comparable percentage gain in the complete arrival forecast. This new predictor was not deployed.

**Later input-quality finding:** independent full-path regression review identified prior Winchester66622 as a partial wait with an unknown start after a650.113-second tracking gap/provider-ID change. The subsequent current hold67062 is valid and remains scored. Unlike the Union-duration defects discussed below, this finding affects the simpler previous-Winchester input too. Original frozen fits/scores are retained; systematic prior-start continuity handling is required before deployment.

**Result: the previous Winchester wait is a useful research lead and merits one bounded full pickup-ETA replay. It does not yet justify a production change. Longer previous Winchester waits predict slightly longer current waits after controlling for lap and clock: persistence, rather than clear evidence of compensation for a bathroom break.**

All feature families, penalties and timing contracts were declared before fitting. The simpler previous-Winchester arm improves current-wait accuracy on three of four older evaluation dates, the earlier September 18 sample, and five newly completed September 18 holds read only after coefficients were frozen. Its recent gains come mainly from correcting overly early departure predictions; the recent windows become slightly wider. Cedar and previous-Union history do not show consistent additional benefit in this screen.

## Scope and exact hypothesis

The canonical Red sequence contains **117 Gilbert/Cedar** and **13 Amistad/Cedar**, followed by **14 Amistad/Church St South** and **121 Union Station**.344Winchester is stop11. Other stops named Cedar are not on Red. The two Red Cedar locations were kept separate; stop14 was not silently included as Cedar.

The ordinary nine-feature release hazard uses elapsed wait, lap fixed at pin and15-minute clock phase. Every new history arm adds to the previously tested **own-Union-departure-age** version of that baseline. Therefore the simpler candidate here has both Union-age and prior-Winchester-duration inputs; “prior Winchester alone added directly to the nine-feature runtime” was not a separate fitted arm. The paired increment isolates prior Winchester relative to the matched Union-age baseline.

There are160 training holds on six dates before September14,113 older evaluation holds,12 initially available September18 holds, and5 later holds. Runtime lap support leaves100/9/5 evaluation holds respectively. Training uses one event-history likelihood per visit,15-second bins and fixedL2=4. No feature/penalty tuning, recalibration, residual trimming, or removal of valid short/long outcomes occurred.

Prior duration means modern recorded **stand_sec**, measured from arrival/rest onset to final resting departure, including the measurement convention around shuffles; it is not legacy anchor residence and not evidence of a personal break. The duration feature is `log1p(stand_sec/60)` plus a missing indicator. The simple prior-Winchester coefficient is−0.22612 per unit of that log-duration: increasing the previous wait from1 to5minutes multiplies fitted15-second departure odds by about0.78, holding other inputs fixed. This association does not identify a driver, a causal instruction or a deterministic schedule.

Current-lap history separately counts completed recorded waits at117/13/121 after the previous Winchester departure; it excludes the prior Winchester wait itself. Missing coverage is explicit and is never silently zero. No current target-hold outcome or future neighbor path enters any predictor.

## Every prespecified arm

Visit-balanced descriptive scores in seconds. Each visit has equal total weight across eligible0/60/180/300/480-second landmarks. These are not calibrated live per-poll probabilities; repeated landmarks are not independent trips. Early means departure before the lower bound; late means after the upper bound.

| Sample | Arm | Visits/checkpoints | MAE | WIS80 | Width80 | Early checkpoints | Late checkpoints |
|---|---|---:|---:|---:|---:|---:|---:|
| Sep14_17 | lap_elapsed_clock | 100/343 | 69.45 | 44.26 | 298.1 | 21 | 8 |
| Sep14_17 | plus_own_union_age | 100/343 | 69.18 | 43.85 | 292.6 | 23 | 8 |
| Sep14_17 | plus_previous_winchester_hold | 100/343 | 67.64 | 43.07 | 289.4 | 21 | 7 |
| Sep14_17 | plus_previous_union_hold | 100/343 | 69.88 | 44.06 | 291.8 | 21 | 8 |
| Sep14_17 | plus_cedar_holds | 100/343 | 68.60 | 43.45 | 289.2 | 23 | 10 |
| Sep14_17 | plus_current_lap_rest | 100/343 | 67.97 | 43.22 | 289.6 | 23 | 8 |
| Sep14_17 | plus_all_own_history | 100/343 | 66.52 | 42.30 | 283.6 | 22 | 8 |
| Sep18_original | lap_elapsed_clock | 9/41 | 85.13 | 58.46 | 377.8 | 1 | 8 |
| Sep18_original | plus_own_union_age | 9/41 | 80.51 | 57.35 | 373.5 | 1 | 9 |
| Sep18_original | plus_previous_winchester_hold | 9/41 | 72.89 | 53.20 | 378.6 | 1 | 5 |
| Sep18_original | plus_previous_union_hold | 9/41 | 84.51 | 59.36 | 372.4 | 1 | 9 |
| Sep18_original | plus_cedar_holds | 9/41 | 81.12 | 57.01 | 369.7 | 1 | 9 |
| Sep18_original | plus_current_lap_rest | 9/41 | 80.05 | 57.05 | 371.0 | 1 | 9 |
| Sep18_original | plus_all_own_history | 9/41 | 70.88 | 51.96 | 374.2 | 1 | 5 |
| Sep18_fresh | lap_elapsed_clock | 5/23 | 90.47 | 55.35 | 314.7 | 0 | 6 |
| Sep18_fresh | plus_own_union_age | 5/23 | 88.89 | 54.74 | 311.0 | 0 | 8 |
| Sep18_fresh | plus_previous_winchester_hold | 5/23 | 81.32 | 49.47 | 317.5 | 0 | 3 |
| Sep18_fresh | plus_previous_union_hold | 5/23 | 91.38 | 56.31 | 308.3 | 0 | 8 |
| Sep18_fresh | plus_cedar_holds | 5/23 | 91.61 | 56.43 | 307.3 | 0 | 10 |
| Sep18_fresh | plus_current_lap_rest | 5/23 | 89.32 | 55.59 | 309.4 | 0 | 8 |
| Sep18_fresh | plus_all_own_history | 5/23 | 80.86 | 49.02 | 313.9 | 0 | 3 |

The previous-Winchester increment reduces WIS43.85→43.07 on the older dates (1.8%),57.35→53.20 on the original supported September18 sample (7.2%), and54.74→49.47 on the five later holds (9.6%). The new five-hold MAE changes88.9→81.3seconds; its width311→317seconds **widens**, while late checkpoints8→3 improve. No early misses occur in either arm on those five holds. Five holds from the same date are a useful extension, not a new independent-day validation.

Combined history has somewhat better aggregate WIS but adds fragile Union/Cedar measurements and little extra benefit on the later five holds. This screen does not select the combined arm for production. The simpler previous-Winchester arm has fewer inputs and clearer measurement provenance.

## By date and fixed elapsed age

| Date | Supported visits | Union-age WIS | +previous Winchester WIS | +all history WIS | +previous Winchester MAE |
|---|---:|---:|---:|---:|---:|
| 2026-09-14 | 23 | 57.08 | 56.24 | 55.14 | 93.30 |
| 2026-09-15 | 19 | 34.03 | 34.11 | 33.37 | 47.67 |
| 2026-09-16 | 30 | 38.48 | 37.25 | 35.63 | 55.63 |
| 2026-09-17 | 28 | 45.40 | 44.57 | 44.98 | 72.98 |
| 2026-09-18 | 9 | 57.35 | 53.20 | 51.96 | 72.89 |

September15 is a small real regression for the simple prior-Winchester increment (WIS34.03→34.11). Full equal-visit fixed-age results, all arms, unsupported-lap strata and every timing sensitivity remain in `scores.json` and `extension-scores.json`. At each fixed age use `weighting=checkpoint` for equal surviving visits; the visit-weighted aggregate serves a different descriptive population.

## Runtime gate and deployment boundary

The same-code runtime loader independently matches all160 training visits. Supported-lap baseline quantiles match to within0.000176seconds. Below, actual runtime marginal/lap fallback is unchanged for every unsupported case; the experimental history hazard only enters within the existing support gate.

| Sample | Arm | Visits/checkpoints | MAE | WIS80 | Width80 | Early checkpoints | Late checkpoints |
|---|---|---:|---:|---:|---:|---:|---:|
| Sep14_17 | runtime_component | 113/398 | 75.80 | 47.57 | 317.2 | 23 | 9 |
| Sep14_17 | plus_own_union_age | 113/398 | 75.56 | 47.21 | 312.3 | 25 | 9 |
| Sep14_17 | plus_previous_winchester_hold | 113/398 | 74.20 | 46.52 | 309.5 | 23 | 8 |
| Sep18_original | runtime_component | 12/55 | 134.81 | 91.28 | 395.4 | 1 | 18 |
| Sep18_original | plus_own_union_age | 12/55 | 131.35 | 90.46 | 392.2 | 1 | 19 |
| Sep18_original | plus_previous_winchester_hold | 12/55 | 125.63 | 87.34 | 396.0 | 1 | 15 |
| Sep18_fresh | runtime_component | 5/23 | 90.47 | 55.35 | 314.7 | 0 | 6 |
| Sep18_fresh | plus_own_union_age | 5/23 | 88.89 | 54.74 | 311.0 | 0 | 8 |
| Sep18_fresh | plus_previous_winchester_hold | 5/23 | 81.32 | 49.47 | 317.5 | 0 | 3 |

These remain current-wait **component** comparisons with frozen pre-September14 fitting/tables. They do not include live rest/movement mixtures,30-second quantile pooling, approach/departure recognition, Division pickup endpoints, route-ranking changes, later target occurrences, or six-hour model refresh. Full rider gains cannot be inferred directly from these numbers.

## Measurement and availability checks

Every prior visit must already be observable on this route, on the same day and within90minutes at focal pin. More recent unknown or invalid-duration visits are kept missing rather than replaced with an older convenient wait. Already-observed other-route assignments reset this history. The known restart-truncated source65237 keeps its verified departure clock but has missing duration. Focal outcomes and all valid long/short prior durations remain.

Primary known-time is the conservative proxy `max(departure+120s, departure+confirmSec+15s, firstMoved+confirmSec)`. `firstMoved+confirmSec` alone is not exact publication after shuffles: firstMoved is the first-ever motion, while confirmSec references the final departure candidate. The original120-second proxy gives identical features. The stricter `departure+600s+confirmSec` sensitivity, motivated by the current10-minute maximum accepted gap, changes only focal48783; it changes no training features. Its scores are preserved. Neither proxy is called recovered exact receipt time.

Only a few long Cedar pauses occur in the fitted history:

| Prior stop | Known durations /160 focal training holds | At least120s | At least180s |
|---|---:|---:|---:|
| 344 Winchester | 140 | 125 | 103 |
| Union | 149 | 124 | 115 |
| Gilbert/Cedar117 | 143 | 2 | 0 |
| Amistad/Cedar13 | 140 | 1 | 1 |

Thus weak Cedar coefficients do not rule out a policy specifically after multi-minute Cedar pauses. Independent raw checks confirm real long Cedar pauses58174 (~310seconds) and64797 (~235seconds), followed by genuine Winchester waits465 and660seconds; these counterexamples show that a long Cedar stop does not deterministically eliminate the next Winchester wait.

The independent reviewer also found a **real prior-history defect**: Union60020 reports4.946seconds after a provider-ID change, but raw fixes show320seconds continuous standing before its late re-anchor on exit. Focal Winchester60263 remains valid. Training Union24868 has a similar suspicious ID/open-visit pattern but lacks the same raw proof. Original coefficients/results remain intact. This caveat particularly affects prior-Union/current-lap/combined families; the simpler previous-Winchester candidate does not use their duration inputs. A provenance-based sensitivity for combined history must preserve original results and focal outcomes.

## Genuine regressions are retained

The new early-bound crossing for the simpler candidate is **67621 (#309, September17, +180seconds)**: actual65.342seconds remaining, lower62.595→69.866, creating4.524seconds shortfall. Its245.342-second focal wait and previous Winchester67188 (~640seconds standing) have independently verified raw continuity/rest plateaus and onward movement. They are genuine; neither is excluded.

Two previously audited difficult cases remain difficult. At64318 +60seconds, lower-bound shortfall35.14→38.96seconds worsens; at65347 +480seconds it changes31.15→37.94seconds. Prior wait memory does not solve every early departure. The five largest visit-WIS regressions for the simpler candidate are61306,48370,65347,47054 and67621; their paired forecasts and prior source records are preserved.

`all-bound-regressions.json` contains **every increased early or late shortfall**, including already-outside intervals, for every history arm; `all-visit-comparisons.json` contains all paired visit changes. `focal-and-prior-record-audit.json` retains the exact focal/source evidence for every simpler-candidate tail regression and its largest WIS regressions. The independent source/raw audit is `../own-history-measurement-review.json` and its companion script. No residual-based exclusion or duration cap was introduced.

## Next bounded implementation/replay task

Carry forward the frozen **lap/clock + own Union age + previous Winchester duration** candidate for an isolated full pickup-ETA replay, with a matched current-production arm. Adding only previous Winchester directly to the nine-feature runtime is an untested ablation and must be named/frozen separately if chosen.

No route-position filter or GPS projection change is required. The runtime needs two historically warm, pin-latched own-bus inputs: last confirmed Union departure and last valid completed Winchester recorded stand, including explicit missingness and provenance. Load history from the server DB at startup, update only on confirmed completed events, and latch values for the entire current wait. The release-fit payload gains the fitted coefficients; server state/checkpoints carry the per-bus inputs. Preserve the stable bus_name identity, route/service-day resets, runtime lap gate, duration quarantine, stale-history fallback and topology-refresh behavior. Do not make browsers learn these histories from scratch.

Replay actual continuous raw observations, preserve identical forward route-position beliefs, and evaluate Winchester→Division48 and Rosenkranz4 first and second occurrences, arrival-window proper scores, early pickup misses/catchability, departure+0/+15/+60 behavior, availability, >60-second absolute-arrival jumps, and route ranking. Use real historical as-of fitting/receipt boundaries, not eventual source outcomes. Explicitly retain64318/65347/67621 and the largest current regressions. A useful component gain can still disappear in the full wait/movement mixture. Require independent review before any production proposal; this task makes no deployment claim.

## Reproduction

Run `screen.py`, then `extend.py` only after `fits.json` exists; run `runtime-comparator.mts` from the v2 app cwd, then `report.py`. All computational runs used `overnight-2026-09-17/heavy.lock` and one BLAS thread. Plans, timestamps, source/input hashes, every coefficient and all predictions remain in this directory. No app, production database, watcher or deployment was modified.
