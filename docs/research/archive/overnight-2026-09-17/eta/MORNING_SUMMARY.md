# ETA morning update — September 18, 07:28 ET

The final evening experiment supports **no additional ETA change**. We resumed the fixed cache diagnostic for 3,000 new polls across 12 routes. Mean arrival error slightly worsened from 234.832 to 234.852 seconds. Across 4,088 matched rider trips, mean error improved by only 0.128 seconds. These are small, mixed differences on previously used history.

The cache mechanism explains why forecasts can change after restart, but correcting it has not demonstrated a useful rider benefit. The evening slice retains a genuine 64-second point regression and a 5,494-second interval shift whose repeated-stop identity remains unresolved. All 19 new uncertain zero-hop cases remain included, alongside the earlier uncertainties and regressions.

The selected rider decisions change no chosen bus or forecast availability. Four synthetic deadline changes are one-second threshold crossings with incomplete pickup chains. One walking caution changes when a pickup bound crosses modeled walking time. One route-order difference lasts one poll because the existing persistence timer starts five seconds later. This evidence supports no new ranking or catchability rule.

The capture, SQL, arrival-occurrence, connected-trip and ranking checks pass. Final integrity verifies 912 tracked files, 241 prior artifacts and eight frozen inputs unchanged. Application files, HEAD and index remain untouched. No screenshots, watcher changes or publication actions occurred; no owned process or lock remains.

Evidence: `cycle-17/RESULTS.md`, `commands.md`, `REVIEW_REQUEST.md` and `final-integrity.json`. Independent research review is next. Of 20,199 prepared fleet polls, 9,000 are now captured; any further coverage should resume the saved checkpoint at poll 9000. Earlier controller-merged pickup/display improvements remain separate; deployment status belongs to the controller's ledger.

Earlier entries below are historical.

# Latest ETA morning update — September 18, 06:55 ET

Corrected the replay's visit identities when the historical detector advanced beyond a rest that the estimator still priced. All 11 current-stop and eight following-arrival cases proved by the reviewer now match the right visits. Another 216 rows become resolvable, including a genuine 26-minute point error. Original forecasts and regressions remain intact.

No new ETA release is supported. Inclusive arrival error changes only **269.083 → 269.073 seconds**; the previously verified connected rider comparison slightly worsens **352.172 → 352.216 seconds**. The remaining 57 / 58 zero-hop identities stay included as provisional. Older pickup uncertainties and legitimate regressions are unchanged.

Evidence is in `cycle-16/RESULTS.md` and `REVIEW_REQUEST.md`. Checks pass for 183,123 structural arrival records and 4,925 connected rider trips per arm. Application files, HEAD and index are unchanged. Independent review comes next, followed by the saved chronological 6000:9000 fleet continuation if time allows. No completed replay or model screen needs restarting.

Earlier entries below are historical. Review 14 and this bounded correction supersede cycle 15's blanket occurrence-validation claim.

# Latest ETA handoff — 2026-09-18 02:17 ET

**Ready for independent review:** restore destination forecasts when GPS reports a shuttle at pickup. Four-file proposal in the ETA worktree over77c32b8; no commit or deployment by this builder. It joins an existing same-bus pickup forecast to its first destination, preserving raw countdowns, repeated-stop safety and connection warnings. See cycle-7/RESULTS.md and REVIEW_REQUEST.md.

The implementation reproduces all4688 previously reviewed prototype decisions:30 destination forecasts restored, none lost, no measured bus/ranking changes.119 application tests, both typechecks, Vite,223 actual mobile numerical comparisons and extra keyboard/touch/class/freshness/nonzero-walk checks pass. Full-suite/staging/publication remain controller gates.

The restored30 cases span eight visits on two already-inspected dates. Selected MAE880.88→396.87sec is descriptive; retain the443sec regression on63523 and worsening61907. No new holdout, nominal coverage or general accuracy claim. The earlier smoothing repair remains independently approved and separately identifiable in suppliedHEAD; deployment status is controller-owned.

Next: independent code review, then controller publication gates. Remaining38 outgoing/next-lap cases,742 countdown/catchable identity distinctions and movement-cache determinism need separate work. Earlier negative model screens are complete and should not be restarted. Existing watcher/data untouched; all owned browsers/processes closed; no screenshots added.

---

Earlier reports retained below as historical entries; their initial status statements reflect their own round.

# ETA overnight findings — through round3,23:50 ET

No ETA production change is proposed. Three completed research slices produced reproducible negative or diagnostic results. This builder preserved the controller-supplied PR282 base948712e153cea1017e9471ce84851a41fae4508a with clean application files; ETA comparator code is unchanged from40af3c0. The first two slices passed independent research review; round3 is ready for it.

The causal neighbor remaining-wait screen covered535 real holds. Gains were too small or inconsistent to justify integration and changed interpretation with visit versus checkpoint weighting. All genuine short/long cases remain. See `cycle-1/RESULTS.md` and `independent-review-round-1.md`.

The clock/component trace reproduced242 saved release-ON forecasts and localized ten difficult cases to different causes: long intermediate delays before Winchester on some trips, overestimated travel or future Winchester waits on others. No common source-clock correction is supported. Both occurrences were audited:20 first and eight second connected destinations,12 incomplete second chains and14 absent checkpoint forecasts retained. Those contexts share actual target visits; they are dependent selected cases. Five saved warm snapshots and separate server/component checks support the diagnosis. See `cycle-2/TRACE_REPORT.md` and `independent-review-round-2.md`.

The new same-day service-role state discounts older confirmed departures, shrinks uncertain phase and resets on gaps/route/phase changes. It adds almost nothing beyond a matched two-departure state. At Union, recursive versus two-history MAE is101.74 versus101.82 seconds, WIS64.12 versus64.22; incremental WIS improves on only one of four dates. Winchester recursive MAE/WIS74.10/46.33 is worse than the current-code component71.72/44.52, with more upper-bound misses. No tuning or integration is justified. This is a bounded negative family result, not proof that operating behavior has no structure. See `cycle-3/RESULTS.md`.

Round3 checks include4,332 forecasts,1,070 future-event invariance comparisons, exact baseline/fallback checks, six contract tests and ten retained regression audits. Union62056's genuine15-second pinned hold remains; six regressions have new raw-coordinate checks, four lack coverage. No record was excluded or relabeled. The two latency contracts select identical histories, so their identical results are not independent confirmation.

All estimates here use inspected historical development data, not a fresh holdout or calibrated on-time percentages. Recorded coordinates and reconstructed collector clocks remain different evidence; first publication timing is unresolved. Round3 scores conditional known-rest components, not live pooled ETAs, catchability or complete rider outcomes. No production improvement is claimed from them.

Next: independently review cycle3, then measure Red-versus-walking decisions through real wait/departure transitions. The input inventory found the existing12,654-frame archive contains only Red; it cannot establish all-route rankings. Existing code already filters weak walking savings and stabilizes rankings using destination windows. `cycle-4/INPUTS.md` identifies the exact warm-state/live-planner output needed next, avoiding a repeat of completed experiments or an artificial cold-fleet comparison.

Historical inputs, existing watcher and publication state were untouched. No browser/server, screenshots, commits, PRs or deployments were created by this builder. No app typecheck/full suite/Vite build/staging is claimed for the unchanged-source round. Commands, evidence, limits and reviewer instructions are durable in PROGRESS.md, CHECKPOINT.md and each cycle report.

Independent review update, 00:04 ET: round 3 now passed independent research review with no blocking findings; it still supports no ETA deployment. Independently reconstructed states, fits, forecasts, all score rows, paired regressions and raw-coordinate evidence; all checks passed and source stayed unchanged. The matched two-history arm shares recursive reset eligibility, so the negative finding concerns longer phase averaging within this bounded design. Next measure Red versus modeled walking with the actual shell's persistent trip choices, both countdown/catchable bus identities and exact target occurrences; no all-route or general catchability claim from the present Red-only, exact-stop slice.

## Round4: actionable source defect, no release yet

The Red-versus-walking audit now covers40 hypothetical sessions and4,688 selected poll decisions using all warm Red buses. Two whole sessions (156 polls) match the built app. Ranking changes satisfy existing persistence; no new threshold is supported. A concrete estimator defect emerged: pooling can transfer a future-lap forecast onto an already-arrived zero-hop stop.101 affected rows were found; one pickup reads30min while its downstream destination is4min. Six whole-lap transitions match the current pooling equation. Next work is a narrow occurrence-identity repair, preserving both arrivals and forward tracking, followed by full paired validation and independent review.

Connected observed bus chains label1,420 decisions/20 contexts;3,268 other choices remain explicitly unmatched. Walking and riders are hypothetical, dates already inspected. No production improvement is claimed. Saved warm state reproduces in-process but diverges in a fresh process; that limitation must be resolved or bypassed with continuous-prefix replay before candidate scoring. See cycle-4/RESULTS.md and REVIEW_REQUEST.md. Application/HEAD remain unchanged atcff3b2a6.

## Independent round4 review

Research-only findings confirmed; no ETA code deployed from this round. Pooling can mix a next-lap forecast into an already-arrived pickup:101 affected zero-hop rows in selected windows,including11 at ordinary stop146. Independent decision replay/browser checks agree. Next task is a bounded pooling identity repair that preserves both upcoming occurrences; no new ranking rule, time cap or coefficient is supported.

The reported fresh-process checkpoint discrepancy now has an isolated cause for its78-frame fixture: movement kernels are cached under rounded keys but computed from first-seen unrounded means. Restoring only21 cache means learned before the window makes the original unmodified modules reproduce all78 complete wire payloads/10,592 rows and distributions exactly. This is diagnostic evidence, not a production fix or proof all restarts match. Keep continuous-prefix comparisons and handle any tracking-cache repair separately with all-route validation. Details and reproduction commands: `independent-review-round-4.md`; evidence: `review-round-4/`.

## 01:05 ET — pickup smoothing candidate ready for review

Found and fixed a concrete pickup defect: smoothing could turn an already-arrived stop into a30–50min wait by mixing in another lap. The final traversal guard fixes all101 recorded zero-hop overwrites and restores149 full destination journeys, preserving both upcoming arrivals. All150,020 broader Division/Rosenkranz forecasts and46,790 position beliefs remain identical to current production.2755 tests, both typechecks, build and156 actual-shell browser checks passed; no new screenshot/watcher/production mutation.

This is **not yet merged/deployed**; controller independent review and staging/CI/publication remain. It is a correctness/availability fix, not an accuracy-gain claim: some restored full forecasts have worse actual error than the old planned-ride fallback, with all regressions retained. The initial exact-hop guard caused new jumps and was rejected; final traversal guard preserves those baseline endpoint forecasts.68 separate raw-at-stop missing journeys and primary countdown/catchable shuttle identity need a coordinated follow-up. See `cycle-5/RESULTS.md` and `cycle-5/traversal-guard/FINAL_STATUS.md`; do not use the rejected root-cycle5 guard.

## 2026-09-18 01:23 ET — independently approved pickup repair (publication pending controller)

Approved candidateb574a1c800654544685a8d9f1097ad3484ac13fc against6220b860a69f5567557926f41de59ed1af72d2f8; no blockers. The fix prevents a future-lap estimate from overwriting an already-arrived pickup and protects the following occurrence while keeping normal forward smoothing. Independent replay confirms101 repaired rows/149 newly available journeys/no losses, with150020 destination forecasts unchanged. Selected complete-trip MAE is316.20→319.06sec; this is a pickup consistency and forecast-availability improvement, not improved destination accuracy. Largest fallback-to-full regression remains documented.

Independent2755 tests, backend/frontend types, build,188 mobile browser numerical checks plus arrived/following/stale/recovery transitions,11081-poll native replay/32081 full-belief comparisons/143 boundaries and legacy checkpoint check passed. Checkout/builder evidence unchanged; no deploy by reviewer. Review `independent-review-round-5.md`; next work is the68 separate missing-board cases and coordinated chosen-bus identity, with cache determinism kept separate.

## Round6: why some complete journeys still disappear

Research fully accounts for68 missing journeys left after the approved pickup smoothing repair. They are34 bus-polls, not68 riders. Thirty have a valid modeled pickup4–12sec ahead that the raw-at-stop branch discards when joining a destination; the other38 offer only a next-lap pickup, including14 after recorded departure. Retained rest metadata cannot safely turn them all into board-now.

A temporary, separately built browser prototype restores the30 correctly ordered existing joins, changes no bus/rank/wire, and reduces large total-arrival jumps117→83. On those selected30 connected outcomes, MAE880.88→396.87sec; six source means improve and two worsen. The largest legitimate regression remains+442.83sec (source63523). No calibrated probability, new model coefficient, fresh-holdout or general rider-accuracy claim. Both upcoming wire occurrences remain unchanged; all2344 nonzero-access decisions unchanged.407 actual browser numerical checks plus keyboard/touch/stale/missing recovery passed;11081-poll native replay exactly matched160496 rows and observed all34 missing-case states.

This is research with a concrete shared-shell prototype, **not a shipped or submitted application change**. Next: independent research review, then controller/UX coordinate only the ordered-pickup journey join with repeated-stop and folded-route tests. Preserve remaining38 cases and avoid broad raw-at-stop/tracker changes. Evidence and reproduction: `cycle-6/RESULTS.md`, `REVIEW_REQUEST.md`, `verification.json`. Source HEAD remainsb574a1c; controller owns publication of the separately approved round5 candidate.

## 01:59 ET independent research review

The remaining missing-journey diagnosis and ordered-pickup prototype independently reproduce:30 of68 full forecasts can be recovered from existing rows without changing shuttle choices or ranking;38 remain unresolved. All1400 matched outcomes retain exact connected identities. Typical selected-case error improves, but source63523 worsens by443seconds and remains included. Two reused dates and distribution-free old fallbacks do not establish calibration or a coverage improvement.

The merged checkout passed164 targeted application tests, both typechecks/build,210 actual-browser comparisons and18 occurrence/catchability boundary checks. No new app proposal was added; the supplied diff is the earlier approved smoothing repair unchanged over the current UX base. Review verdict research_only. Controller can next coordinate a small tested shell/helper integration with UX; broad fallthrough and tracking/cache changes remain separate. Details: independent-review-round-6.md. Checkout/index, watcher and frozen builder evidence unchanged; no publication action.

## 02:27 ET independent review update

Ordered pickup join restores30historical destination windows as reported, but is **not approved yet**: a bus shown at pickup can lose its walking connection warning when the estimator's pickup lower bound is still positive. Built-SPA boundary reproduces this; exact-base comparison isolates the new join. Request a narrow catchRisk correction for nonzero walks, preserving the useful destination window and all bus/occurrence semantics.167app tests,types/build,223browser comparisons and connected-outcome/provenance checks otherwise pass. The443sec retained regression remains documented; no fresh-holdout or calibrated-probability claim. Prior smoothing repair is unchanged from independent approval. No review publication or tracked edits. Details: independent-review-round-7.md.

## 02:39 ET — walking warning corrected, ready for rereview

Fixed the review blocker: when a shuttle is already at pickup, someone still walking to it now keeps the connection warning, even if the estimator's approaching pickup forecast has a later lower bound. Destination times and both arrivals stay unchanged. The class window can still fit the deadline, but the risky shuttle is not recommended without connection caution. Ordinary approaching buses and riders already at the stop behave as before.

The four-file correction passes173targeted tests, both typechecks, Vite,4688unchanged historical decisions,223browser comparisons and additional mobile walking-boundary checks. Original reviewer failure now passes; exact GPS walk/lower-bound equality is tested. Prior30restored journeys and443sec regression remain. No new ETA accuracy, calibrated probability or observed walking-success claim. Ready for independent rereview; controller full-suite/staging/integration/publication still pending. No deployment by this builder. See cycle-8/RESULTS.md and REVIEW_REQUEST.md.

## 02:51 ET integration handoff

The walking-caution correction now combines cleanly with production PR288's trip-bus identity controls. Builder resolved one import conflict, retained both teams' source, and left the pending merge commit to the controller. Combined validation passes221targeted tests, both typechecks, Vite,4688identical decision states,223browser comparisons,all caution/dwell boundaries and mobile/desktop both-bus boarding/final directions.147prior evidence files and all1400connected outcomes are preserved, including the443sec legitimate regression. No new accuracy/model gain or deployment is claimed. Independent correction rereview plus controller full-suite/staging/CI/publication are next; cycle-9/RESULTS.md has exact commands and source state.

## 03:02 ET independent review: walking caution ready for controller gates

Approved exact53b4076b against production373505d5, with no blocking findings. A rider still walking to a shuttle reported already at pickup now retains “Connection uncertain”, even if the estimator's approaching pickup lower bound exceeds that walk. This preserves the restored destination forecast and both pickup occurrences; PR288's correct-bus ride/boarding presentation is intact.

Independent285distinct application tests, both typechecks, Vite build,4688prior decision comparisons,223built-browser comparisons, walking boundaries and11additional same-page failure/recovery states plus reload pass. Exact source/proposal and183builder-artifact hashes verified; checkout unchanged. Fullsuite/staging/CI/publication/production verification remain controller-owned and are not claimed here.

The30ordered-join restorations remain a selected historical comparison after smoothing, with the legitimate443sec error regression retained. The caution fix adds no forecast-accuracy,probability-calibration or freshholdout claim. Next separately address chosen boardable pickup occurrence identity and38outgoing unknown cases; preserve completed negative model findings. See independent-review-round-8.md and review-round-8 evidence.

## 2026-09-18 03:24 ET — selected pickup identity: research ready for review

Production at supplied handoff is PR289/d5a392f. This round leaves application files and HEAD unchanged and identifies the next concrete rider-facing repair. The planner knows which pickup prices the trip, but the displayed bus is recovered from the destination forecast. When that forecast disappears, a known later bus loses its identity; a later visit by the same bus is also treated like its first visit.

All4,688current historical decisions/rankings stayed exact. In a controlled destination-row removal, all pickup choices/waits stayed exact, but742distinct-bus choices lost display attribution (18sessions/9sources/two reused dates; NOT742observed outages). Actual built-SPA reproduction shows a roughly18-minute wait for#309 becoming“#307 / now–2min”, and a42-minute same-bus-return wait also labeled“now–2min”. Eight browser states and13direct boundaries pass as defect reproducers; no fix or new accuracy gain is claimed. Same-bus-later occurrence is synthetic evidence, absent in the selected Red census.

cycle-10/CONTRACT.md supplies the bounded repair: preserve existing countdown and selected boarding evidence independently of destination availability, distinguish vehicles from visits, and never treat relative hops as permanent visit IDs. All1,400connected outcomes and38raw-unlinked cases, including legitimate prior regressions, remain. Next independent review then coordinated ETA metadata + UX wait/identity implementation. Current UX focus/off-route copy correction can proceed separately. Watcher untouched; no new screenshots or running owned resources.

## Independently reviewed pickup-identity research — 2026-09-18 03:34 ET

Research-only; no application change. Independent review confirms that losing destination forecasts can misattribute an already-selected boarding bus and its wait; a later pickup by the same vehicle can display the first visit's much shorter wait. Current-production census4688decisions retained exactly.742different-bus selections lose display attribution under synthetic destination removal;that is not an observed outage count. Same-bus-later examples are synthetic only in this selected two-date Red cohort.

Reviewer ran101application tests,directly verified9376historical/ablation selections,and reproduced the actual mobile/desktop DOM and focus transitions. All passed with no research blockers; all1400connected outcomes,38rawunknowns and443sec older regression remain. No new coefficient,accuracy,coverage or calibration claim. Next supported work is one coordinated ETA/UX pickup metadata and presentation repair preserving countdown,both visits,unknown windows and numerical selection. Evidence:independent-review-round-9.md and review-round-9/. Exact head/base d5a392f533e8684320259ff0d323a3b0da75cc50; controller retains publication.

## 03:55 ET — pickup contract implemented and verified in an isolated build

The ETA half of the reviewed pickup identity fix is now executable: it retains the selected bus and visit even without a destination forecast. All9,376paired numerical/trace/ranking states remain exact.17boundary groups,100mixed-option batches,backend/frontend virtual types,Vite and mobile/desktop12-state tests pass.1,400connected outcomes,the38unresolved raw-stop cases and earlier443-second regression remain unchanged. Evidence: cycle-11/RESULTS.md.

This is **research/integration material, not deployed code**. Application and HEAD remain untouched; cycle-11/eta-projection.patch must be combined with UX wait/identity/manual-action consumption before release. Current display defects intentionally persist in this prototype. INTEGRATION.md makes the next change concrete; no further model search/census is needed. Current origin/masterPR290 numerical code matches the frozen baseline; newer UX integration/full release gates remain controller work. No new screenshots; watcher untouched and every owned resource closed.


## Pickup projection prototype independently verified — 2026-09-18 04:04 ET

Cycle-11 is research-only and ready for a combined ETA/UX implementation; it is not deployed and has no application diff. Independent review10 finds no blocker: 9,376 paired decisions and direct selector checks remain exact; virtual types/build, boundary/multi-option tests and mobile/desktop browsers pass. Reviewer also verified failed/missing-feed recovery, actual future-plan clearing and physical-ride storage/reload without transient metadata. All 1,400 connected outcomes, 38 unresolved raw cases and the old442.827sec regression remain.

Next useful work is UX consumption of chosen pickup bus/visit for wait labels and manual actions, followed by normal final source gates and fresh review. No new model coefficient, calibrated probability or incidence claim. Details and limits: independent-review-round-10.md; reproducible reviewer artifacts: review-round-10/.


## 04:23 ET — avoid gaining an ETA by switching to a worse trip

The broad diagnostic for38uncertain raw-current pickups now has correctly attributed alternative-bus outcomes:32decisions connect to7alternative source visits;6remain unknown. In18matched decisions before the original recorded departure, from3original source visits, the other bus reaches the target16–33minutes later. Recorded departure alone does not prove a rider could board the original bus. All32alternative trips also exceed the unchanged modeled walking time. This supports keeping uncertainty visible rather than switching buses just to fill a destination estimate. No new ETA/coverage/calibration gain or app release is claimed.

Exact currentPR291/diagnostic76options and76traces match prior saved evidence. Independent ID/time checks verify1410historical leg uses;both occurrences and all1400previous outcomes remain,including the legitimate442.827second regression. The six alternatives fail specific historical links and remain unresolved. The38original live unknowns are not repaired by this research. Evidence and independent-review request:cycle-12/RESULTS.md and REVIEW_REQUEST.md.

The separate pickup-identity fix has progressed: UX04:16 reports one combined projection+wait/identity/actions candidate ready for review onPR291. ETA confirmed baseline parity and supplied9passing supplemental tests plus both virtual typechecks;UX already ported equivalent cases. Controller owns final review/publication. This ETA round leaves checkout,HEAD,index,watcher and allhistorical data unchanged;no new browser/screenshots/build/deploy.

## Cycle13 — a concrete restart issue, still research-only

Actual watcher data confirms that raw stop proximity can persist during motion and after recorded departure.487samples were verified, but four source windows have no recorded samples and the watcher stores no server ETA; the38unresolved pickup cases remain unresolved. No boarding guarantee or blanket switch is supported.

The earlier checkpoint discrepancy now has a reproducible cause: movement-kernel caching uses the first unrounded speed in a rounded bucket. An artifact-only repair makes all78restartpolls/10592rows and complete belief states identical in fresh processes. Current code differs on1817rows, with median changes up to21seconds and upper bounds up to3768seconds when a mixture threshold flips. This is not yet a shipping fix: the repair also changes warm forecasts, and full route/outcome/tail validation is outstanding. All app files andHEAD8aa67bdremain unchanged. Evidence:cycle-13/RESULTS.md and cache/RESULTS.md.


## Independent review — 04:58 ET

Cycle13's cache diagnosis and receipt limits independently reproduced; research only, no code release. Current movement kernels depend on the first caller in a rounded cache bucket. The fixed rounding diagnostic restores exact 78poll/10592row restart parity and complete per-vehicle modelstate parity; it also changes warm forecast tails, so complete allroute/rider outcome validation is still necessary. Receipt audit confirms487samples but no exact capture of38problemdecision timestamps; all38 remain unresolved. No coefficients, exclusions or caps authorized. Review: independent-review-round-12.md. Checkout/head/index and58builder artifacts preserved; no active ownedresources or new screenshots.

## Cache outcome follow-up — 2026-09-18T09:19:37.533470+00:00

The fixed cache diagnostic now reproduces all60polls after threefresh-process restarts across an eight-route fixture, including repeated-stop routes; current code reproduces none. Complete Red replay retains150020forecasts and bothoccurrences. Its3309connected checkpoint errors and miss counts barely change, so there is no useful ETAaccuracygain to claim. Larger forecast-tail changes remain visible around already-recorded arrivals, and some downward countdown jumps increase. No application change is proposed.

The next evaluation is ready:20199reconstructed full-fleet polls from197354exactly verified recorded busrows across12routes, with originalDB untouched. Use the savedexport/currentcode/fixeddiagnostic to test connected outcomes and riderchoices across allroutes; do not publish solely on restart parity. Evidence and exact commands:cycle-14/RESULTS.md;independent review requested. HEAD98e535b/index/watcher preserved;no new screenshots or ownedprocesses.

## Independent cycle-14 review — 2026-09-18T09:32:28.343540+00:00

Research only; no application change or release. Independent tests reproduced complete Red forecasts, connected outcomes and the 12-route raw export. The diagnostic makes restarts repeatable; Red accuracy is essentially unchanged, with mixed small score changes and retained large tails.

One evidence defect was found: the builder fixture saved live model references, so its apparent per-poll states were final states. Reviewer immutable snapshots independently verify the intended 60/60 restart matches while current code matches 0/60. Adopt that capture method for future gates and preserve the old evidence.

Next evaluate full-fleet connected outcomes and walk/pickup/deadline/ranking choices using the existing export, repaired repeated-stop positions and fixed diagnostic. Exact head/base 98e535b; 90 builder files and seven inputs unchanged; zero screenshots. Full review: independent-review-round-13.md.

## Latest ETA result — 2026-09-18T10:18:32.201262+00:00

The fixed cache diagnostic has no demonstrated rider accuracy gain in the first 6,000 fleet polls. Corrected 182,918-row mean error is 269.463 → 269.453 seconds; 4,925 same-trip option comparisons slightly worsen (352.172 → 352.216 seconds). Occurrence labels are corrected and original scores preserved. Research only; application files, HEAD and index unchanged. The diagnostic remains artifact-only: largest final scored regression69seconds and a raw upper-bound change5791seconds remain. No code from this round is ready to deploy. Restart reproducibility is established separately; full remaining-route validation is unfinished. Final evidence:cycle-15/RESULTS.md, semantic-verification.json and rider-outcome-summary.json.

## 2026-09-18T10:34:48.276623+00:00 — independent fleet review: repair labels before extending

The cache experiment remains research only. Independent execution reproduced the saved fleet calculations and all2,036rider decisions, with no changes in shuttle choice, ranking or walking caution. But a new audit found11current-stop forecasts and8following forecasts assigned to the wrong future lap when the detector advanced before the model. The apparent tiny aggregate accuracy changes must remain provisional until those labels are corrected; no production ETAchange is approved.

The fix belongs in the research matcher, preserving all forecasts and genuine regressions. Existing native checkpoints reproduce100polls per arm and allow the next chunk to resume at6000without repeating the completed capture. Review:independent-review-round-14.md. Application files,head/base98e535b,builder evidence and historical inputs unchanged; watcher kept running.

## 2026-09-18T11:09:31.079657+00:00 — independent measurement review

Cycle16's11current-arrival and8following-arrival corrections independently pass. All183,123score records reproduce,216additional outcomes resolve,and large tails/legitimate regressions remain. No source or production change. The diagnostic still has no demonstrated useful ETA gain: the negligible mean improvement depends on one unresolved full-lap-versus-zero-hop identity; connected rider error slightly worsens. All57/58uncertain zero-hop rows remain explicit. Research-only continuation may resume at poll6000 using frozen checkpoints; do not replay the completed prefix or publish the cache change. Full evidence: `independent-review-round-15.md`.
