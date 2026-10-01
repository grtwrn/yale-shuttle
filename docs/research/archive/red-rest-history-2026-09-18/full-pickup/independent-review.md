# Independent full-pickup experiment review

## Scope and current verdict

**Final verdict: retain this as a modest research signal; do not integrate it into production as a window-tightening fix.** The frozen plan and adapter support a retrospective intervention experiment. Typical pickup errors improve slightly, but widths barely change, and the newer-day windows get wider. No material new departure-risk or upward-jump failure appears in the scored sample. An additional left-censored prior-duration input was found in the largest Division regression and needs a general quality rule before any live implementation. This is not evidence of prospective treatment availability or a safe-to-leave-later guarantee.

This reviewer inspected the plan, `history-release.ts`, build/replay adapters, causal raw-feed reconstruction, and coefficient-fold verification. No production source, fit, database, or replay output was modified. The local application checkout has committed HEAD `9d92b802a3ebb4841381a8a78e0f15bb0309422b`, tree `2784f37d5d954ffd578139b2ba1fc930f6b20dc9`; only dependency directories are untracked.

## No current outcome enters the numeric history adjustment

The adapter reads only pin timestamp, prior Union departure age, previous Winchester recorded standing/missingness, and the frozen model coefficients. It checks that prior Union departure precedes the current pin by at least120seconds and that any usable previous Winchester duration has a declared known-time at or before pin and an earlier departure.65237's incomplete previous duration is explicitly required to remain missing. Current hold length, actual departure, target arrival, and the cohort's recorded lap are not substituted into the runtime calculation.

There is nevertheless **retrospective selection**: intervention eligibility is an exact lookup in a cohort of completed, later-validated visits. A real online predictor would not yet know that a visit will complete or qualify. Applying the same core to all unmatched pins makes a fair diagnostic of the numeric intervention on these selected episodes; it does not establish its availability rate or average effect on every live ride. Report matched/overridden/unsupported/unmatched unique visits and pins, not only successful forecast calls. Passing this experiment would still require an as-of online history loader and validation without completed-cohort treatment gating.

## Algebra, support and cache behavior

The coefficient folding is correct. For known prior Union age `A`, the new term is `beta9*(A + t − referenceUnionAge)/600`: adding its constant part to the intercept and `beta9` to the existing `t/600` coefficient preserves the hazard exactly. Missing Union age adds only its missingness coefficient. Previous Winchester log-duration and missingness add only constant intercept terms. All other age splines, lap and clock coefficients come from the corresponding frozen arm.

The adapter first checks that every incoming runtime fit is the same frozen160-hold, six-date core with reference lap3231.6625. Original runtime lap support is checked before applying a folded fit; actual runtime lap remains an input and is not replaced by its historical cohort counterpart. Unmatched pins retain the common core; unsupported laps retain the original marginal fallback. Distinct arm/pin fits are memoized as distinct objects, matching the runtime's fit-object cache key. The recursion guard prevents double folding.

The saved independent fold check covers8,547 quantiles against the frozen component forecasts, maximum difference6.82e−13seconds. It also exercises core/unmatched/unsupported behavior, recursion and a changed actual runtime lap. This establishes algebraic component parity, not rider-level accuracy or equality to today's refreshed production coefficients.

## Pin identity and replay mechanics

The hook is keyed only by pin timestamp. That needs a bus-identity invariant because uniqueness among completed cohort rows alone would not prevent an unmatched second bus sharing the same collector poll. I independently streamed both saved frame files and checked every raw Winchester `at_stop_since` against the history row's bus name:

-83 distinct raw Winchester pin timestamps were observed.
-81 match a cohort/extension history ID.
-No matched pin belongs to the wrong bus; no raw pin timestamp is shared by multiple buses.

Thus this dataset has no observed cross-bus timestamp collision. An online implementation should use explicit bus/episode identity rather than rely on this incidental uniqueness.

Today's input uses actual collector reducers, legacy departure events for lap clocks, and the live-position serialization rules, without future history seeds. The ETA replay has a ten-minute per-bus warm eligibility requirement and resets after declared observation gaps. These are causally reconstructed feeds; they are not a capture of every historical server publication. Red-only replay does not establish all-route reassignment fidelity or production six-hour fit-refresh parity.

All arms use the same frozen travel/dwell tables and parameter set, and the same current pricing/tracking source. The build adapter now preserves the actual route occurrence field; it does not label every following arrival occurrence0. Pairing must continue to assert exact row identity and availability, with full belief hashes equal. Periodic full-server parity checks validate the optimized target-scoped calculation against the same reconstructed warmed state.

The completed three-arm replay contains20,531 frames and190,157 forecast rows per arm. Identity-based pairing within each poll succeeds (presentation order may change with ETA), with full serialized belief hashes identical across all arms. The history arm changes22,300 rows relative to the core, while preserving forecast availability. Its runtime audit records80 matched pins, two unmatched pins, and72 distinct supported overridden visits. The earlier81 wire-matched histories count includes a pin that never reaches this runtime release intervention; the two counts measure different stages and should not be conflated.

## Required interpretation of the eventual scores

Compare history against both the nine-feature core and the Union-age control. Keep chronological dates, physical target occurrences and all valid early/long visits separate. Retain source67621 and the existing64318/65347 early-tail cases; their observations were independently audited. Quantify shortfall severity and distinct affected rides alongside checkpoint counts.

One label correction was required before scoring: source65237's stored pin is independently proved truncated, so its approach and pin-elapsed standing checkpoints cannot represent those phases. The scorer now marks `sourcePinValid=false` and skips those checkpoints while retaining its valid departure and exact target chain; the continuous waiting audit excludes that invalid-origin timeline rather than inventing a repaired pin. This is a previously established measurement correction applied before candidate outcomes, not residual-based removal. Other valid short and long visits stay included.

Window width alone is not a success criterion: the prior component gained accuracy partly by moving later and sometimes widening. For Division, score forecast lows against exact connected target arrival and observed departure, with stated boarding margins. A GPS departure label is not a doors-open guarantee. Include departure responsiveness, arrival-time jumps, missing forecasts, and following-occurrence errors; do not score a different lap as the forecast's target.

The Sep16–17 dates are reused development. The five later Sep18 holds were unseen when the component coefficients were frozen, but their component outcomes were inspected before this full-path replay; they are not an untouched full-ETA holdout. No nominal calibration, zero-stranding, driver-policy, production-readiness, or safe-to-leave-later claim follows from this experiment alone.

## Full pickup results

The visit-balanced supported/intervened Division comparison contains 68 source journeys. Core→history MAE is 79.22→76.90 seconds, WIS 58.25→57.14, and width 473.38→471.19 seconds. Against Union age alone, adding the previous Winchester duration changes MAE 78.46→76.90 and WIS 57.87→57.14, while width increases slightly, 470.64→471.19. The previous-wait signal survives the full calculation, but it removes very little of the reported rider uncertainty.

Today's 14 supported journeys improve MAE 112.01→106.02 seconds while widening 505.35→511.47 seconds. The five later holds improve 118.74→113.14 while widening 459.89→466.46. These are small, dependent samples on one date. Rosenkranz first-arrival results are similarly modest: 66 intervened journeys, MAE 116.03→114.57 and width 641.99→640.21. Neither the number of polls nor repeated landmarks supplies thousands of independent validation trials.

The following-occurrence code independently traces both physical target visits through exact same-bus legs and intermediate departure clocks, refuses skipped target crossings, and uses only occurrence 1 forecasts at standing landmarks. Its 321 landmarks cover 42 source holds and 83 target visits. Aggregate MAE changes 165.81→165.42 seconds, with unchanged six early and ten late bound misses. History is slightly worse than Union age alone. Only 85 of 162 candidate paths are connected; 18 are censored and 59 unknown. This supports “little aggregate change in the observed subset,” not noninferiority or proven safety on the missing paths.

## Continuous pickup and jump interpretation

The continuous first-Division audit includes 77 valid-source journeys, 70 stopped targets. No arm's lower-bound timestamp exceeds the observed target departure. Among raised lower bounds, the closest candidate margin is about 10.1 seconds overall and 16.0 seconds for stopped targets. All-row minima include existing unchanged margins as small as 1.83 seconds overall and 11.97 seconds for stopped targets. These are GPS/detector clocks, not observed door closure or a real rider policy. The 0/15/30-second margins are retrospective reach-stop diagnostics, not proven boarding success.

The extra distinct arrival-bound crossing is source **64725→64741** on September 17: worst lower-arrival excess −0.666→+0.079 seconds versus core, and −0.015→+0.079 versus Union age. This tiny threshold crossing is below the roughly five-second observation spacing; it should remain counted without being portrayed as a newly established missed bus. The target remained recorded at the stop for 34.808 seconds after its arrival. Its source and target raw tracks are continuous, with exact connected legs. Previous Winchester 64206 has a 25.87-second internal raw gap, but its matching inbound pin and later plateau remain intact; that is not the same defect as an unobserved episode start.

The meaningful existing early case is **64318→64338**: worst lower-arrival excess 30.145→33.986 seconds, or 31.242→33.986 against Union age. This valid early departure remains a real regression; its lower still precedes the observed target departure by about 16 seconds. Small aggregate improvement does not justify raising the pickup minimum independently of the modeled tail.

Division downward arrival-time jumps over 60 seconds change 29→31, comprising **five new crossings and three avoided crossings**, not two newly created large discontinuities:

| Source | Core change (s) | History change (s) |
|---|---:|---:|
| 58956 | −60.000 | −61.133 |
| 66158 | −59.170 | −62.593 |
| 70927 | −54.337 | −68.288 |
| 71987 | −56.829 | −61.587 |
| 72447 | −57.602 | −62.265 |

The largest added drop among these is 13.95 seconds at 70927. Three crossings are avoided at 60375, 61907 and 66982. Division upward >60-second counts remain five; Rosenkranz upward counts remain eight. The very large pre-existing jumps are unchanged. These measurements do not show that the history feature solves general ETA stability.

## Largest regressions and a newly identified input-quality limit

Reproducible evidence is in `independent-case-audit.py` and `.json`. The script opens only the local outcome database read-only, checks exact leg/visit endpoint chains, and saves source/prior/target raw quality. It performs no fitting, removal or replay mutation.

- **71451, #309, September 18:** current pinned hold 740.117 seconds, 149 raw fixes, maximum within-episode gap 5.179 seconds, 650.077-second exact-coordinate plateau, and final movement 4.945 seconds after labeled departure. Previous Winchester **70927** is also complete: 749.888-second pinned span, 745.075-second recorded standing, exact inbound leg, maximum gap 5.424 seconds. Current departure reaches Division in 64.944 seconds and Rosenkranz in 304.966 seconds through exact connected legs. The Rosenkranz +180-second point error worsens by 41.77 seconds. This is a legitimate prediction regression despite two successive long waits; there is no measurement basis to remove it.
- **67062, #316, September 17:** current hold is valid: 530.054 seconds, 107 raw fixes, maximum gap 5.273 seconds, 415.029-second plateau, inbound leg 62143, final movement after 4.989 seconds. Division is reached in 100.050 seconds and Rosenkranz in 435.027 through exact chains. Division +60-second point error worsens by 32.33 seconds, so this outcome remains scored.
- **Its prior history 66622 is weaker than the feature's `reason=valid` suggests.** The stored standing is 105.065 seconds, but pin equals the first reacquired fix. The last preceding same-name raw observation is **650.113 seconds earlier**, and provider ID changes **66487→66508**. No inbound leg connects this new pin; no earlier raw fix exists for the new provider ID. The recorded segment has zone movements and only a 25.013-second longest exact-coordinate plateau. This proves that the episode start is unverified after a >10-minute observation gap; it does **not** establish the true earlier waiting duration. Calling the 105 seconds a complete prior wait is unsupported. The current 67062 hold and downstream outcome remain valid.

The 66622 finding was made after scoring and does not license deleting a bad prediction, retuning the frozen fit, or asserting that masking it would improve the result. Preserve these original results. Before any production history model, define a general causal quality rule for first/reacquired pins, missing inbound evidence, provider handoffs and observation gaps; an incomplete prior duration should become missing while its independently valid departure clock remains usable. Revalidate that rule across training and evaluation, including all affected visits, rather than patching one residual-selected ID. This extends the earlier 65237 duration quarantine without invalidating all its clocks or removing genuine short waits.

## Final recommendation

The strongest defensible finding remains an association between previous and current Winchester waiting, conditional on the existing inputs. It is not a deterministic driver-break rule, and driver identity is unavailable. Keep this candidate and its original artifacts offline. The present gain—roughly two seconds of aggregate pickup MAE and two seconds of width—does not warrant the added transport, quality, cache and refit complexity as a solution to multi-minute windows. A later evaluation should first use causal, quality-aware history availability and genuinely new dates; it should continue to retain legitimate early departures and all measured boarding-tail regressions.
