# Cycle 16 — correct lagged-rest replay attribution

**Research only.** All 11 current-stop and eight following-arrival cases established by independent review 14 now match the proved historical visits. Another 216 rows become resolvable. No application code, forecast, historical record, model coefficient or planner decision changes. HEAD remains `98e535b99649e74ca599d2e33bcfdc46df83d30d`. Fresh independent review remains required.

## Correction and scope

The historical detector can advance to the next anchor while the estimator still prices the previous rest. Joining from that newer anchor incorrectly moved current and following forecasts into later laps.

The correction requires a unique physical pricing origin inferred from **all** served hop rows, an active tracked rest at that origin, one exact recorded pin-clock match, and an exact reached-leg path from that prior visit to the latest historical source. Both arms must identify the same prior visit. Each target then uses its actual wire hop distance from that origin, including nonzero rows and both occurrences. Ambiguous arms, skipped targets and incomplete paths stay explicit. No nearest-time substitution, blanket zero-row exclusion, arbitrary cap or new forecast input is introduced.

These are reconstructed replay clocks, not recovered publication timestamps or proof of physical boarding. The plan was frozen before rescoring. Original cycle 15 and review 14 files remain unchanged; new outputs here supersede only the affected labels.

## Complete row accounting

| Change from the prior scored cohort | Rows |
| --- | ---: |
| Unchanged records | 177,564 |
| Same target, correct earlier chain origin | 5,335 |
| Following arrival assigned its first return | 8 |
| Already-arrived current rows retained as explicit transitions | 11 |
| Previously unresolved rows now connected | 216 |

The scored cohort changes from 182,918 to **183,123**. Every prior row is accounted for; none becomes silently unavailable. All 11 proved current rows remain in `post-arrival-transitions.jsonl` with negative remaining time. Newly resolved truths span 0–4,652.771 seconds and retain actual point errors up to **1,574.321 seconds**.

The exact alignment proof covers 186 bus-polls / 176 prior visits and 8,228 affected rows per arm, including 8,211 nonzero-hop rows. Of these affected rows, 5,878 have a connected target and 2,350 retain unresolved target identity/path status; sample and warmup gates are separate.

All 5,021 large interval changes, 206 unpaired physical keys, raw negative lower bounds (16,825 / 16,826), availability, stability and the 16 identical backward numerical-lead events are preserved. The largest genuine scored point regression remains **69 seconds**; the largest raw upper-bound increase remains **5,791 seconds**. `prior-regressions-retained.json` keeps all 25 previous largest point regressions side by side.

## Descriptive outcome comparison

| Inclusive metric | Current | Canonical diagnostic |
| --- | ---: | ---: |
| Mean absolute error, seconds | 269.082823 | 269.072812 |
| Median absolute error, seconds | 181.943000 | 182.074000 |
| p90 absolute error, seconds | 625.932200 | 626.022200 |
| WIS | 176.714426 | 176.713101 |
| Bus before displayed lower bound | 22,069 | 22,079 |
| Bus after displayed upper bound | 9,699 | 9,693 |

The tiny mixed changes do not establish rider ETA improvement or calibrated coverage. The inclusive aggregate remains **provisional**: 57 current / 58 diagnostic scored zero-hop rows lack this exact identity proof. Of those, 29 / 30 have a different tracked-rest index and 28 per arm lack an exact pin match. They remain included and individually catalogued; a zero forecast alone does not justify deleting a bad forecast. Unknown minute-row accounting also retains 8,927 legacy same-source cases and 2,322 lagged-origin cases without a matching target. These categories are not blanket physical-identity validation.

The prior selected rider comparison is unchanged: 2,036 paired decisions and 4,925 connected trips per arm; mean error slightly worsens **352.172350 → 352.216208 seconds**. This round rechecks every rider path, without rerunning the planner or claiming new rider observations. Walking/access is modelled, not observed boarding. The older 38 pickup unknowns, 442.827-second regression and separately audited Red cases remain unchanged and are not newly certified outside this slice.

## Verification actually completed

- Locked saved-wire rescoring: all 6,000 polls, no forecasts regenerated.
- Final locked `verify.sh`: all 19 reviewer acceptance cases; both-arm checks of 8,228 affected wire rows; 183,123 structural truth records, 86,270 distinct connected paths and 1,911,868 leg uses; full raw-wire/cumulative-hop checks; 4,925 rider trips and 48,072 ride-leg uses per arm.
- `compare_labels.py`, `zero_hop_inventory.py`, `audit_cases.py` and `report.py`: exit 0. Full commands and logs are in `commands.md`; final preservation checks are in `final-integrity.json`.

The first uncached verifier was intentionally interrupted with exit 143 because it repeated identical SQL queries. Its source and empty log are preserved. Caching the exact read-only query results changed no rule, input or forecast; the complete rerun passed. No application tests, typecheck, Vite build, browser, staging, CI or deployment were run or claimed. No dependency installation, screenshots, private feedback, historical writes, watcher changes or publication actions occurred.

## Next bounded task

Independently audit `REVIEW_REQUEST.md`, all 19 prior reviewer cases, affected nonzero rows, newly connected cases and remaining zero-hop uncertainty. After acceptance, resume the frozen current/canonical poll-6000 checkpoints to poll 9000 in a new sibling directory under the shared lock. `RESUME.md` gives the exact mechanics. Preserve the global cache, original fleet order, chronology, both occurrences, tails and connected rider checks.

No continuation ran before corrected-label review. This remains the reused September 16 daytime prefix: eight routes and 6,000 of 20,199 polls, with shared causal calibration and one fixed diagnostic. Night routes and the later date remain unfinished. Do not restart completed captures/model screens or publish the cache one-line change from these negligible mixed results.
