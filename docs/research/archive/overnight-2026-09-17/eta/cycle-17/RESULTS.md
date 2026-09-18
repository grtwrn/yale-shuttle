# Cycle 17 — evening fleet continuation and rider decisions

**Research only; no additional estimator change is supported.** Continued the frozen current/canonical cache diagnostic from poll6000 through8999 without restarting the prefix. Across70,162 connected arrival rows, mean error changes234.831558→234.851763sec. Across4,088 identical recorded rider trips, error changes369.240206→369.112271sec. These small mixed changes do not demonstrate a useful ETA or rider-choice improvement.

## Baseline, chronology and capture

Supplied/current HEAD is56a5258bd4c6a4869667a99d3b480b12a3ce61c9. The frozen baseline is98e535b; core ETA/server/planner/arrival modules, twelve runtime imports and the complete numerical options memo are exactly unchanged at current HEAD. `PLAN.json`, `adapter-provenance.json` and `shell-head-diff.patch` record this. Application files, index and HEAD are unchanged by this round.

The two frozen bundles and matching native checkpoint6000 files were copied and SHA256-verified. Original global first-caller cache state, fleet ordering, calibration and fixed canonical-mean diagnostic remain intact. No fit, new coefficient, model search or future neighbor feature was introduced. Current release behavior including prior overnight fixes remains enabled in both arms.

The new range is2026-09-16 15:25:54.049–19:35:51.305 ET:3,000 polls/250 minute samples per arm,12 routes including evening services,1,670,421 current/1,670,415 diagnostic wire rows. No fleet gap occurred. All9,000 completed polls remain separate durable captures;11,199 of the20,199 prepared polls remain. This is reused history, not a fresh holdout. Collector clocks are reconstructed, not original publication receipts.

`capture-verification.json` verifies every new poll timestamp against saved input, ordering, sample flags, row totals, checkpoint counters, nonempty kernel caches and zero server failures. Both native checkpoint9000 files persist. Original poll5999 seeds only stability/tracking comparisons so the chunk boundary is retained; it is not rescored. No old prefix forecast or planner session was rerun.

## Arrival outcomes and uncertainty

| Metric | Current | Diagnostic |
| --- | ---: | ---: |
| Connected scored rows |70,162|70,162|
| Mean absolute error, sec |234.831558|234.851763|
| Median absolute error, sec |169.876|169.929|
| p90 absolute error, sec |533.7178|533.7098|
| WIS |162.554030|162.565363|
| Mean interval width, sec |992.702446|992.725165|
| Bus before lower bound |5,996|5,996|
| Bus after upper bound |4,287|4,286|

Both occurrences remain:48,251 first and21,911 following connected rows. They reuse1,293 source/1,609 target visits and are not independent trips. Exact structural checks traverse34,066 paths/734,613 leg uses; these counts do not certify every provisional identity.

Corrected lagged-rest attribution independently checks2,795 wire records per arm across64 bus-polls/61 prior visits, including2,790 nonzero-hop records.1,752 resolve and1,043 retain unresolved targets. No nearest-time joins, caps, exclusions or outcome-dependent label changes were added.

The new slice retains19 provisional scored zero-hop keys per arm:8different tracked-rest positions and11without an exact pin. All have identical arms. Their exploratory complementary MAE234.641299→234.661509sec has the same small worsening, but this complement is not certified or substituted for inclusive results. The previous57/58uncertainties and poll508 sign sensitivity remain unchanged in review15. Unknown minute rows, broken/skipped chains, warmup and1,083post-arrival transitions remain explicitly counted in `score.json` and separate streams.

## Tails, availability and genuine regressions

All1,771 raw interval changes over60sec remain, including unresolved and post-arrival contexts. Largest raw change is5,494sec at Green#122/poll7682, repeated physical index11(stop127): current[4193,3,5494,24] versus diagnostic[0,0,0,0]. Its historical source/target identity is unresolved; it is not a measured accuracy improvement. Full raw wires and `large-tail-changes.jsonl` preserve it.

Largest scored point regression is64sec at Blue Day#46/poll6698, following stop98: recorded remaining2690.307sec, current3257sec, diagnostic3321sec,31exact connected physical hops. Blue West#300/poll8341 retains a62sec regression at following stop98. `largest-regression-context.json` preserves all25 largest rows with source/target/leg records. Older69sec fleet,442.827sec pickup and audited Red regressions remain in original evidence; this slice does not newly certify cases outside its dates/windows.

There are35current-only/29diagnostic-only physical occurrence keys; all remain in `unpaired-arrivals.jsonl`. Row totals are not a claim that every old identity stays available. Raw negative lower bounds6101/6111 remain. Both arms have the same12backward numerical-lead event identities. Absolute-arrival jumps over60sec are current/diagnostic upward5051/5044, downward14884/14896; route-specific differences remain in `score.json`. No clipping or forward-position rule was introduced.

## Connected rider decisions

The three previously fixed sessions60836,61538,61907 begin and end wholly inside this chunk. With two destinations/two access offsets they produce12contexts/1,836paired decisions. The actual unchanged numerical shell/planner/ranker consumes each arm's saved wire.4,088selected option-polls connect to the same vehicle, pickup visit, destination visit and ride legs;2,600remain unresolved. Independent checks verify42,224ride-leg uses per arm. Walking/access is modeled, not observed boarding.

No chosen physical bus or journey availability differs. There are20pickup-metadata differences, one visible order difference, one caution difference and four synthetic point-deadline differences. All are audited in `decision-case-audit.json`:

- The four30minute flips are Brown1801→1800sec at two polls/two access offsets. All four lack a proved pickup chain; no class-arrival improvement can be inferred.
- The Blue Day#44caution flips when pickup lower bound418→426sec crosses modeled walk424.780sec. The same connected pickup/target is retained; recorded departure leaves modeled access about80sec spare in both arms. This is not observed boarding or calibrated catchability.
- The sole visible-order difference lasts one poll. Replaying all3,672saved decision rows through current ranking/visibility exactly reproduces every saved order. The diagnostic's existing30sec persistence timer starts5,043ms later; both converge at the next poll. `ranking-state-audit.json` retains the ±45sec state trace. No ranking threshold change is justified by this slice.

Matched rider mean error improves0.128sec while its median218.292→218.3345sec slightly worsens. The preceding6,000poll rider mean slightly worsened. Neither provides a useful/generalized rider gain or on-time probability.

## Executed checks and remaining work

`commands.md` lists exact commands. Locked replay and full analysis scripts finish exit0: capture, corrected scorer, actual selector, connected rider matching, decision accounting, every new lagged-origin proof, structural SQL truth, actual wire/cumulative occurrence semantics, and zero-hop inventory. Light decision-case/ranking/sensitivity audits also pass. No application tests, typecheck, Vite/browser/staging/CI/deployment were run or claimed for this empty app diff.

Harness/reporting corrections are explicit: a pre-scoring adapter assertion caught an old canonical filename; and the copied decision verifier's inherited prose incorrectly said zero differences. Corrected note/source/output provenance is preserved; numerical assertions, actual decisions and forecasts did not change. The initial report draft also asserted incorrect manually totaled unmatched counts; the assertion caught this before report output, and the corrected35/29totals match the saved availability ledger. Original draft source/log are preserved. No substantive check failure was suppressed.

Independent review should audit source/bundle provenance, native continuation, corrected identity scope, both occurrences, retained large tails and exact rider-change cases. The fixed diagnostic remains artifact-only. If further coverage is useful after review, continue9000:12000from these exact bundles and arm-matched checkpoint9000files in a sibling directory. Do not cold-start, rebuild a new baseline silently or repeat negative model screens. No code publication is requested.

All owned command sessions59606/82470/26063have completed; no owned browser/server/process/lock remains. Zero new screenshots/dependencies, no private feedback, historical DB writes, watcher changes, other-team/controller mutations or Git/publication actions. Final preservation evidence is `final-integrity.json`.
