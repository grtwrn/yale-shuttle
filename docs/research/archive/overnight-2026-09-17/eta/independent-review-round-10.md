# Independent review 10: cycle-11 executable pickup projection

Verdict: **research_only**, with no blocking findings in this prototype. This is controller round 7's research slice, not a production approval. There is no application candidate diff. Both independently verified HEAD and supplied base are `d5a392f533e8684320259ff0d323a3b0da75cc50`; checkout and index remain clean.

The concrete ETA patch is suitable for the next combined ETA/UX implementation. It deliberately leaves the existing rider-facing defects visible. Do not release the unused metadata half or treat this research verdict as approval of future UI code.

## What was independently verified

I read the actual three-file artifact patch, its full source overlays, exact shell extraction, paired replay, boundary tests, compiler/Vite harness, browser fixtures, evidence verifier, retained initial failures and prior independent review. The patch adds a type-only TripOption field, a pure projection helper and explicit clearing/population at the live options sites. It receives the current option's actual `picked.match`/`picked.boardable`, or the actual raw override's selected vehicle. It neither selects another bus nor consults the target forecast or any future observation to construct identity.

Within one selection, normalized bus/stop/hops distinguish a different vehicle from a later visit by the same vehicle. Equal ETA values do not collapse separate occurrences. Hops remain relative to the snapshot, not a persistent visit identifier; selectedAtMs is client computation time, not server receipt time. The raw branch remains raw evidence, even without a compatible modeled pickup. Existing pinned walking tolerance is preserved: selected metadata is not a physical boarding guarantee.

Fresh reviewer copies regenerated and executed the prototype without editing application files or overwriting builder evidence:

- All **9,376** paired option, trace, ranking and metadata checks pass. All 4,688 historical decisions equal the earlier production outcomes exactly after removing only the additive field.
- My direct-selector audit separately reconstructs visits from the actual wire, applies the production picker/raw gate, and compares projection fields without importing the generated shell or either research projection helper. All **6,464 forecast + 2,912 raw selections** pass across 1,172 source frames.
- All **17** helper/lifecycle boundary groups pass, including equal-time separate occurrences, normalization, missing destination, folded-route changes, null/departed clearing, exact future threshold and pinned walking tolerance.
- All 100 multi-option batches / 500 options equal their isolated evaluations. I strengthened the diversity check to exclude walking options: all 100 batches still have heterogeneous shuttle projections, and 87 contain at least two distinct selected boarding identities among defined shuttle selections. Thus diversity is not merely the walking option's absent field.
- Backend and frontend TypeScript programs compile with the exact virtual overlay; Vite independently builds 128 modules. Sourcemap checks establish that all **82** repository sources in the bundle equal the proposed overlay or unchanged checkout. The backend has no new runtime import: planner/helper links are type-only and the helper is frontend-only. This does not substitute for final integration/Docker gates.
- The regenerated patch, three sources, generated wrappers, extraction report and numerical output files are byte-identical to the builder's corresponding artifacts (11 checked files). All 75 builder files and all 20 original web/dist assets remain unchanged.

The current local `origin/master` ref is `7e29064475315c2d621b77cdca130c05737d1ab8`. I independently confirmed its entire numerical options memo and seven relevant modules match this experiment's d5 baseline. I did not fetch, deploy or verify remote production. The newer presentation was not part of this isolated build; recheck the integrated base explicitly.

## Actual browser behavior and additional lifecycle checks

The independently built SPA passes the builder's 12 states on both mobile (390×844) and desktop (1280×900), including missing/recovered destination, different bus, same-bus later visit, raw caution, stale/fresh and departed/recovery. Existing countdown and destination numerical values remain exact. The old display defects intentionally remain; this is evidence for the next consumer change, not a claim that riders already receive corrected labels.

I added and independently executed browser checks on both viewports for polling failure, missing server ETA and their recoveries. Both unavailable paths clear the projection. Each extended run records 16 live states, then enters a real future plan through the public departure UI and verifies computed metadata is absent. Returning to Now restores the live projection. Explicit boarding of #309 stores only the existing physical-ride fields, without this metadata, and actual page reload retains that physical vehicle. Trip draft/local/session storage never acquire livePickupSelection. These tests use the actual compiled application, tester identity helper and fully intercepted network traffic. All four successful browser runs have zero page errors, no horizontal overflow in captured states and closed pages/contexts/browsers. No screenshots were taken.

My first extended invocation failed on a harness navigation mistake: it sought the departure control while the route detail page was expanded. The preserved accessibility snapshot shows the control belongs behind “All routes.” Adding that real navigation step to the test resolves it; no prototype code or assertion was weakened. The first run also closed its resources and had no page errors. `browser-lifecycle.mjs.first`, `browser-review-mobile.json.first` and `extra-browser.log.first` preserve that failure. Builder failures likewise remain preserved: backend import assertion, undefined JSON representation, accessible-name selector, pinned-tolerance fixture and non-diverse first multi-option fixture.

## Evidence and statistical limits

All **1,400** existing connected outcomes retain their exact total and destination availability. All **38** raw selections without a compatible modeled pickup remain unknown (24 before and 14 after retrospective departure). The source63523 **+442.82701916224846-second** earlier ordered-join regression is retained exactly. It is an old comparison, not a loss or gain introduced by this projection.

The historical census is still 2,490 same-visit, 1,456 raw-current and 742 different-bus decisions, repeated within 40 selected sessions / ten source visits / two reused dates. The missing-target arm is synthetic sensitivity, not 742 observed outages. Same-bus later-visit behavior is established by synthetic fixtures, not observed incidence in this selected cohort. The folded-route boundary correctly shows that destination missingness can alter the existing pickup selection; universal selection invariance is not claimed.

There is no new fit, fresh holdout, accuracy improvement, calibrated probability, normality or nominal coverage claim. Previous neighbor/service-role screens remain exploratory and score-/weighting-dependent; small log-loss gains, flat/worse Brier and date-confounded groups do not authorize production coefficients. No valid outcome was excluded, no cap was introduced and no future neighbor trajectory was used.

## Commands actually executed

Application-dependent commands used this checkout's `services/shuttle-v2` working directory. `O` below abbreviates `/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-10`; all scripts are preserved there.

1. `bash $O/reproduce-light.sh` — exit 0. Regenerates source, then executes audit, boundaries and multi-option checks: 9,376 paired comparisons, 17 groups and 100 batches pass.
2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash $O/reproduce-heavy.sh` — exit 0. Both virtual TypeScript programs, isolated Vite build and mobile/desktop 12-state browsers pass. Log: reproduce-heavy.log.
3. `./node_modules/.bin/tsx $O/direct-selector-audit.mts` — exit 0, 9,376 direct picker/raw-gate checks pass.
4. `python3 $O/verify_evidence.py` — exit 0, nine frozen input hashes, 29 prior cycle10 files, 82 built sources, 1,400 outcomes, 38 unknowns and exact older regression preserved.
5. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash $O/extra-browser.sh` — initial exit 1 from the route-detail navigation setup described above; corrected harness invocation exits 0 on both viewports, 16 states each plus actual future planning and physical-ride persistence/reload.
6. `./node_modules/.bin/tsx $O/multi-option-review.mts` — exit 0, 100 heterogeneous shuttle batches / 87 with distinct defined boarding identities.
7. `python3 $O/final-integrity.py` — exit 0, exact head/base, clean checkout/index, patch applies, 75 builder files and 20 original assets unchanged, 11 byte-identical reproductions, all browser resources closed. Combined team image census: 215 files / 9,445,149 bytes, under 100 MiB.
8. `git diff --check && git diff --exit-code && git diff --cached --exit-code && git status --porcelain` — exit 0, no tracked/index/untracked checkout changes.

No full Vitest suite, normal npm-script typecheck, staging/API smoke, Docker image build, CI or deployment was run or claimed. Virtual type compilation and isolated application execution validate this artifact; normal release gates remain necessary for combined code. Read-only inspection briefly requested nonexistent REPORT.md/savedTrips.ts/build-provenance.json before using the actual files; those were not application failures.

## Next coherent slice

Controller should scope one combined implementation using cycle-11/INTEGRATION.md and eta-projection.patch. ETA owns the selected-pickup projection/type and numerical call sites; UX consumes the selected boarding identity even when destination data is missing, uses the selected wait for a later visit by the same bus, and keeps only one manual physical-bus action for that same-bus case. Different vehicle permits two explicitly named manual actions. Preserve countdowns, both arrivals, missing-destination unknownness, walking caution, pinned tolerance and focus when actions appear/disappear. Never persist snapshot-relative hops or infer guaranteed catchability from selection metadata.

Port substantive tests into the repository, replace the prototype browser's intentionally old label expectations, test both manual actions and focus lifecycle on the final UI, and run normal final code gates and fresh independent review. Current UX progress/requests through 03:59 ET were read: alert controls have their separate independent approval and UX is ready for this coordinated next slice. No completed model screen/census needs restarting. Remaining raw tracking cases and cache determinism stay separate.

All owned command sessions completed; no browser, server, process or lock remains owned by this review. Existing watcher, historical records, other-team files, application source, Git state, controller files and publication were untouched. No dependencies, external contacts or private-data access were needed.
