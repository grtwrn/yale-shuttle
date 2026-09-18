# Independent review — round 5

**Verdict: approve. No blocking findings.** Final independent replay and integrity checks passed. Exact HEAD is `b574a1c800654544685a8d9f1097ad3484ac13fc`; independently verified parent/base is `6220b860a69f5567557926f41de59ed1af72d2f8`. No tracked files or publication state were changed.

## Code and rider assessment

The candidate is a narrowly supported pickup-row repair. `eta/index.ts` extracts the existing pooling loop and requires positive hop distance, nonincreasing hops and the same future-traversal bucket before applying the existing 30-second smoothing. A raw zero-hop arrival remains zero. The next occurrence cannot inherit a two-lap forecast after changing to one future lap. When identity is ambiguous, the fresh estimate seeds memory; legitimate increases remain possible. Ordinary within-traversal forward progress retains the previous smoothing. This is conservative occurrence protection, not a complete unwrapped route-position identity model.

The only other changes are eight substantive regression tests and release documentation. No fitted parameters, forecast horizon, outcome labels, tracking, planner, wire shape or runtime imports change. Red/Winchester/support/active-rest gating remains the existing gating. Docker shared-import closure passed in the independently executed full suite. The checkpoint schema and serialized Map/row shape remain unchanged. Legacy checkpoint behavior is checked separately below; the pre-existing process-global movement-kernel cache issue remains outside this change.

The prior reviewer explicitly required protecting both occurrences, preserving valid forward progress and retaining ordinary stop146. Those corrections landed in the actual diff. The initial exact-hop guard is rejected and remains in cycle-5 root; it is not the reviewed candidate. Use only `cycle-5/traversal-guard` for final evidence.

## Independently checked evidence

Reviewer-authored `review-round-5/verify_evidence.py` exited0:

- All15 frozen input hashes match. Native index matches its saved candidate snapshot and declared SHA256. All three generated baseline modules exactly equal the supplied base's Git sources after only the declared import rewriting. Both replay arms have release ON and identical historical calibration. The native paired replay imports those exact baseline modules and the unmodified candidate.
- All1,172 selected frames and160,496 rows pair by bus/stop/hops, with identical bus inputs, warmup and served position fields.454 rows change. All1,734 zero-hop rows are exact zero point/bounds/50 quantiles; all101 former corrupt rows are fixed (90 Winchester,11 ordinary stop146). Both arms retain61,142 two-arrival pairs without point-order inversion. All11,234 selected Division/Rosenkranz wire rows and their full distributions are unchanged.
- All150,020 broad endpoint forecast dictionaries are exactly equal across candidate/current baseline and the archived prior release-ON arm, paired by(time,bus,target,hops). All177 selected endpoint checkpoints and3,124 adjacent-poll jump values are equal. This audits the saved full paired replay; it does not claim independently reexecuting the entire16,253-frame broad target replay.
- All4,688 decisions are accounted for:4,471 full journeys present in both arms,149 gained, none lost,68 absent in both. Historical comparison retains1,420 baseline and1,400 candidate matched outcomes, with1,382 exact common(session,time,source,target,bus) identities; paired leg IDs/truth agree. All1,240 already-available paired full-journey points are unchanged. Independently traversed12,874 connected-leg uses for all1,400 candidate matched outcomes against read-only SQLite, including source/target/route-index/arrival/departure continuity and error/bound flags.
- Paired MAE316.1967→319.0557sec is confirmed. The largest increase is228.5065sec absolute error for65347→65406 at recorded departure: old planned-ride fallback283.3245sec, restored forecast565sec, actual309.909sec. It is preserved, as are the other four reported source/alight regressions. This is an availability/invariant repair, not improved full-trip accuracy. The modest aggregate cost does not warrant retaining a demonstrably corrupted pickup row.
- Countdown/catchable-journey bus differences remain676→742 decisions. These are explicitly recorded rather than attaching the focal bus's truth to an alternative. Their rider-facing treatment and the68 raw-at-stop/no-modeled-zero-board cases remain coordinated follow-ups.

A separate nested score audit confirms unchanged first-occurrence scoring across1,908 development and600 reused-afternoon checkpoints, and second-occurrence scoring across801 paired checkpoints/318 both absent. All checked score groups are identical, including WIS, tails/width, stopped targets, date groups and jump scores. Existing ambiguous h=N and missing/uncertain chains remain visible. Regression coverage retains64318,58224,65347,67957,68304;48550 is outside this raw archive and has no newly claimed audit.

These are deliberately selected historical Red windows, reconstructed collector clocks, hypothetical access/direct walking and repeatedly evaluated dates. They are neither prospective nor independent rider trials. The earlier follower/service-role evidence remains mixed by score/date/weighting and authorizes no coefficients. No future neighbor observations enter this candidate. No new exclusions, probability calibration, nominal coverage or normality claims are supported or made.

## Independently executed application and browser checks

All heavy commands acquired `/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock`; TS/browser commands ran in this checkout's `services/shuttle-v2`. Outputs are exclusively `review-round-5` and this team's report notes.

- Locked `bash review-round-5/verify.sh`: `npm test` passed127 files/2,755 tests in43.85sec, `npm run typecheck` passed backend and frontend, and `(cd web && npx vite build)` passed124 modules in4.61sec. The script then exited1 on a reviewer output-path quoting typo before launching the browser. The passing application phases are independently executed, not builder claims. No need to repeat them after correcting only the reviewer script.
- Locked `node review-round-5/browser_parity.mjs` exited0:156 actual built-shell numerical/order comparisons over both complete58224→48 sessions; zero page errors. The script is the inspected builder browser harness with only reviewer output paths changed.
- Locked `node review-round-5/browser-transition.mjs` exited0:32 numerical/order comparisons through the repaired timestamp1789567342286, followed by actual rendered pickup-dialog, keyboard and freshness transitions. Dialog says “At your stop,” shuttle#309, zero stops to pickup and following shuttle#308/about28min later. Enter opens, Escape closes and restores trigger focus; close target is44×44; phone page does not overflow. Stale and missing wire remove arrival details and show “ETA unavailable”; restored wire returns the arrived pickup. History is explicitly unavailable in the intercepted fixture, not invented. Zero page errors.
- Locked `tsx review-round-5/legacy-checkpoint.mts` exited0: unchanged legacy checkpoint restores three beliefs, serves78 frames/10,592 rows and keeps all79 zero-hop rows exactly zero including all50 quantiles.19 frames appropriately differ from legacy output. It primes only21 cache means captured before the fixture window; this is a scoped checkpoint compatibility check, not a claim that cold-cache restart determinism was fixed.
- Locked `tsx review-round-5/native-replay.mts` exited0: independently stepped11,081 actual polls, exactly reproduced all1,172 saved candidate windows/160,496 serialized wire rows/distributions, and checked32,081 full belief objects against the exact-base server. All143 independently specified boundary cases passed, including N=2/3/29/37, zero/current/future changes, N+1→N, ordinary forward progression, hop increases, dt=0/5/15/15.001/negative and legacy contaminated zero-hop memory. No numeric tolerance is used for serialized wires or beliefs; the scalar formula checks use1e-9 for floating arithmetic only.

No screenshot, production request, report write, external network fixture data, extra server, persistent watcher or dependency installation was needed. Browser resources close in finally blocks and use the existing tester-identity helper. No physical phone, native screen reader, full staging, Docker image build or deployment was executed. Full staging/CI/merge/deployment remain controller gates.

## Preserved reviewer harness failures

1. Output-path substitution in the first browser copy misplaced a quote. Syntax failed before browser launch; original script and aggregate log are retained. Corrected browser-only rerun passed.
2. Initial archived full-row comparison assumed row-array order was stable between old release-OFF/ON generation and current ON/ON generation. It is not. Corrected comparison requires exact(time,bus,target,hops) identity, complete key-set equality and exact full forecast dictionary equality. No case or tolerance was changed; original script/log retained.
3. The first continuous replay stopped at timestamp1789593039874 because strict in-memory comparison distinguishes JavaScript -0 from the JSON fixture's0. The actual transport serializes -0 as0. Final comparison uses exact complete serialized wire JSON, retaining strict full-belief comparison. Original failed script/log retained. This is not a forecast mismatch or a loosened numeric tolerance.

## Controller handoff

**Approved for controller integration; not deployed by this reviewer.** Controller retains PR/CI/staging/publication authority. The next builder should investigate the68 separate raw-at-stop/no-zero-board cases, coordinate countdown versus catchable-journey identity with UX, and keep the movement-cache determinism issue separately scoped. Do not repeat completed negative model screens or change ranking thresholds based on these selected counts.

For reproducibility, use the saved baseline modules verified against6220b860. `prepare_full_pair.py` originally ran while that base was HEAD; rerunning it unchanged after the controller's candidate commit would copy the candidate as baseline. Pin the supplied base explicitly before any future regeneration.

## Final integrity and exact reproduction commands

HEAD/parent/merge-base independently remain b574a1c800654544685a8d9f1097ad3484ac13fc /6220b860a69f5567557926f41de59ed1af72d2f8. Worktree/index are clean and all53 pre-review builder files have unchanged SHA256. All owned command sessions finished, all browser resources closed and no owned heavy lock/server remains. No controller file, other-team artifact, watcher, source, historical DB, credential or GitHub state was modified.

Exact successful commands (TS/browser cwd: services/shuttle-v2):

```bash
python /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-5/verify_evidence.py
flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock ./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-5/native-replay.mts
flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-5/browser_parity.mjs
flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-5/browser-transition.mjs
flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock ./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-5/legacy-checkpoint.mts
git diff --check 6220b860a69f5567557926f41de59ed1af72d2f8 HEAD && git diff --exit-code && git diff --cached --exit-code && git status --porcelain && git rev-parse HEAD && git rev-parse HEAD^
```

The locked aggregate `bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-5/verify.sh` exited1 only after independently passing npm test, npm run typecheck and Vite build, for the first reviewer browser syntax error documented above. First failed evidence/native runs likewise remain in `.first` / `-first` artifacts; their corrected executions exited0. `scoring-parity.json` records the additional successful inline nested-score audit. No application assertion failed.
