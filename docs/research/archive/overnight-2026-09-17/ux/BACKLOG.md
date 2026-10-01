# Overnight UX backlog

All findings initially source-inspected only. Reproduce before prioritizing a cosmetic change. Use one coherent item per builder/reviewer cycle.

| ID | Priority | Rider problem / proposed bounded work | Evidence / files | Acceptance |
|---|---|---|---|---|
| UX-01 | P1 | Distinguish deadline unknown, tight buffer, catch risk and possible late arrival; explain future estimates plainly | `ArriveBy.tsx`, `arriveBy.ts`, `TransitMap.tsx:3151–3206`; see FIRST_TASK | Truthful headlines for fresh, missing, stale, future, buffer-only and caution-only states; calculations unchanged |
| UX-02 | P1 | Keyboard/screen-reader access to core navigation and place entry | `TransitMap.tsx:2898,3040,7640`, `PlaceList.tsx` | From/To have names; aria-expanded matches rendered rows; selected view announced; existing combobox keyboard and draft restoration preserved |
| UX-03 | P1 | Feedback and issue replies usable without touch/mouse | `TransitMap.tsx:8340–8420`, `IssuesPanel.tsx` | Named textareas, keyboard-accessible attachment action, selected priority exposed, 44 px priority targets, recoverable errors/status announced; never submit to prod during testing |
| UX-04 | P1 | Historical information answers “how long have comparable trips taken?” without a lesson in fitting | `ArrivalHistory.tsx`, `ArrivalPlot.tsx`, `ArrivalDetails.tsx` | Origin→target and whether remaining wait is included stay prominent; sample count and snapshot date clear; recent summary plain; weighting method in existing disclosure; observed dots remain distinct from forecast |
| UX-05 | P1 | Minimap bus/wait labels stay attributable and compact under overlaps | `TransitMap.tsx:941–1412`, `mapLabels.ts`, `chipCluster.ts`, `MinimapReview.tsx` | Same-route two buses, two-route same stop, viewport edge, long time range and long names checked; X/~Y beside correct bus; no new numeric ETA or extra text burden |
| UX-06 | P2 | Expanded trip is actionable: get to pickup, catch correct bus, get off, final walk | `TripPlanner` detail region, `BerthDisclosure.tsx`, `BerthInset.tsx`, `arrivalDetails.ts` | One obvious next action, full stop/direction names discoverable, pickup vs destination timings explicit, back preserves plan, no nested interactive trap |
| UX-07 | P2 | Route cards and system map stay useful when no buses/hidden routes/off-hours | `AllRoutesMap`, `StopList`, map section near 7810–8010 | One filter remains authoritative; concise explanation and recovery for all-hidden vs selected-idle; forecast unavailable not rendered as service-off; mobile card order readable |
| UX-08 | P2 | Alerts and on-board tracking explain status and recovery | `OnBusBanner`, `RideStopList`, `RideRouteMap`, `RideFinish.tsx`, alert controls | Upcoming exit and route/bus identity dominate; permission denied has useful in-app behavior; stale bus not mistaken for arrived; final walk retained; dialog focus returns |
| UX-09 | P2 | Crash/offline recovery gives useful action before technical details | `main.tsx`, `liveUpdates.ts`, `web/public/sw.js`, banners | Reload first; reset's actual local-data loss explained; raw stack under disclosure; stale estimates never presented as live; no automatic clearing |
| UX-10 | P2 | Saved places, recents, location and weather preferences remain easy to use | `TripPlanner`, `PlaceList`, `NearbyStopsPicker`, weather controls | Save/rename/delete targets and names; location denied permits typed origin; blocked storage graceful; units toggle stays separate from weather expansion |
| UX-11 | P3 | About and operator views consistency/accessibility audit | `public/about.html`, `public/stats.html`, `stop-data/*` | Phone reflow, keyboard, selected filters, loading/error/empty, data-source distinctions; do not add operator screens to rider navigation |

## Not automatic work

* Do not remove valid historical outliers, alter age/cohort selection or flatten ETA ranges for aesthetics.
* Do not replace windows with a normal curve or label modeled dots “past buses.”
* Do not change route rankings by UI sorting; send concrete walk/ride dominance counterexamples to ETA team/root.
* Do not build new Settings/History/Favorites tabs from legacy types; the current workflow is contextual.
* Do not refresh/rewrite every CSS style or all of TransitMap. Prefer targeted components when extraction has a clear benefit.
* Small text is an audit lead, not proof of a defect. Evaluate actual readability, contrast, hierarchy and zoom behavior before changing.

## Worker updates

Append cycle outcomes here with commit/PR/deploy state and reviewer. Keep failed or deferred ideas with reasons so the next cycle does not restart the same work.

### UX-01 — builder complete, awaiting independent review (2026-09-17 22:34 ET)

Implemented truthful deadline states, partial-availability handling, clear future departure note, 44px departure buttons and no empty bus suffix on future plans. Evidence: `ux-01/REPORT.md`, `ux-01/final-verify.log`, 13-state component browser and built-SPA phone/desktop/keyboard checks. 22 targeted tests + backend/frontend typecheck + Vite build passed. No calculation or recommendation changes. No commit/PR/deploy by builder; controller/reviewer pending. Next item: UX-02.

### UX-01 — reviewer correction complete, fresh review pending (2026-09-17 22:57 ET)

Resolved the supported second-route mismatch: buffer/conditional advice now includes that route's window, bus and trip action, including a fourth-ranked route. A reproduced missing map on direct hidden-route selection is also corrected; Back keeps the original collapsed list and deadline. Evidence: `ux-01-fix/REPORT.md`, `final-verify.log`, `supplemental-verify.log`, rendered regressions and browser before/after. 58 tests, both typechecks, Vite and bounded component/full-shell checks passed. No ETA or ranking changes. HEAD `b7c44c0...` preserved; no publication by builder. Independent review and controller CI/deploy remain. UX-02 remains next.

### UX-02 — builder complete, independent review pending (2026-09-17 23:24 ET)

Stable endpoint/list names, selected navigation state, announced search errors and displayed-place focus restoration implemented. Reproduced/fixed pending blur closing a rapidly reopened origin editor. `ux-02/REPORT.md` documents baseline, real failure, correction and exact checks: 87 tests, types/build, built-SPA keyboard/touch/mobile/reflow/pending/empty/failure/recovery/draft and ordinary blur resolution. HEAD948712e preserved; no builder commit/PR/deploy. Expanded-state mismatch was not demonstrated because current To rows map results one-for-one. Full suite/staging/publication remain controller gates. Next UX-03. UX-10 retains empty-editor cancel/async Enter-before-results focus and saved-place/Swap controls; no blanket keyboard-completeness claim.

### UX-03 — builder complete, independent review pending (2026-09-18 00:02 ET)

Reproduced/fixed invisible feedback-send errors and keyboard-skipped screenshot actions. Named fields,44px selected priorities, native keyboard chooser, persistent error/status, image replacement/removal and guarded close/success focus implemented; reply focus waits for refresh. `ux-03/REPORT.md`, `final-verify.log`, `touch-final.log`:40 tests, types/build, mobile+desktop+touch/reflow/loading/error/empty/retry/attachment/focus pass. HEADcff3b2a6/index preserved; no publication. No claim that all cancel/reopen-in-flight races or native assistive technologies are audited. Next UX-04, preserving underlying match/weight/sample semantics. UX-01/02 deployed per controller PR282/283; do not restart them.

### UX-04 — builder complete, independent review pending (2026-09-18 00:29 ET)

Historical summary/snapshot/count/date range now precede the plot; method remains under About these records. Reproduced/fixed keyboard focus loss on Refresh, with guarded pending action and loading/error semantics. `ux-04/REPORT.md`, `date-verify.log`:26 tests, both types/build, actual-component mobile+desktop keyboard/touch/reflow/loading/error/timeout/race and1–100-trip fixtures pass. Midnight service-start date range and weighted sparse suppression covered. No historical selection/weight/threshold/ETA/planner change. HEAD e436041/index preserved; controller review/publication pending. UX-01/02/03 deployed per handoff PR282/283/284; next UX-05. Full-shell entry and native assistive technology remain scope limits.


### UX-05 — builder complete, independent review pending (2026-09-18 01:05 ET)

Browser-reproduced ambiguous Blue/Brown (B) tags and unnamed bus markers. Colliding initials now expand to route names; compact waiting labels include the existing bus number, and active/passed markers have explicit accessible names. Times, positions, layout geometry, planner/wire and both occurrences are unchanged. `ux-05/REPORT.md`: 65 tests, both types/build, mobile/desktop/long-window/edge/keyboard/zoom/poll-focus and full-SPA identity/following-arrival/stale-removal checks pass. One first full-SPA assertion ran before Leaflet's invisible fade nodes were removed; corrected clock advancement passes, evidence retained. HEAD 6220b860a69f/index preserved; no publication. UX-01–04 deployed per controller; next UX-06.

UX-06 follow-up from UX-05: fullscreen Back closes but focus falls to BODY in both frozen baseline and candidate (`baseline-expanded` and `supplemental` JSON). Escape with focus on the fullscreen toggle retains focus. Address Back focus alongside the expanded-trip/berth/final-walk audit; no whole-map keyboard-completeness claim from UX-05.


### UX-06 — fullscreen-return slice complete; independent review pending (2026-09-18 01:52 ET)

Reproduced Back/Escape-from-Back→BODY on overview, walking map and pickup inset; shared close handler now restores the persistent expand toggle while preserving external focus on Escape. `ux-06/REPORT.md`:51tests, both types/build, actual-component mobile/desktop/reflow/touch/keyboard/missing/empty/cleanup and built-SPA berth/directions/draft/both-arrival/stale checks pass. HEAD8de0eed/index preserved; no publication. Existing source assertion updated for extraction; harness setup and first failure retained. Fullscreen modal/focus-trap audit, whole-map removal focus, next-action/correct-bus/exit/final-walk acceptance remain open; do not mark the entire UX06 complete.

Next numerical coordination lead: ETA01:44 research-only ordered-existing-pickup join, pending its independent review. Read eta/cycle-6/RESULTS.md and REVIEW_REQUEST.md before any shared shell change; preserve raw countdown versus catchable journey identity and documented regressions. No ETA integration in this proposal.

### UX06 — distinct trip-bus identity slice complete; independent review pending (2026-09-18 02:30 ET)

Reproduced actual-shell pickup307/journey309 misattribution. Expanded ride/wait now use existing journey; explicit actions track either physically boarded bus, with guarded focus when extra action disappears. ux-06-trip/REPORT.md:131tests, types/build, actual built-SPA mobile/desktop/keyboard/touch/reflow/both-arrival/stale/missing/recovery/back/draft/exit/final-walk pass. Numerical options/ETA/planner/wire unchanged; HEAD/index preserved. Full suite/staging/publication remain controller gates. Same-bus later pickup and absent destination identity need ETA contract before UX changes; broader alerts/whole-view focus remain UX08. Next bounded builder after review: UX07 empty/off-hours/missing feed.

### UX-07 — builder complete, awaiting independent review (2026-09-18 03:00 ET)

Tested proposal distinguishes loading/unavailable snapshots from fresh empty reporting, preserves current counts when only ETA rows are missing, keeps schedules/walking available, and gives single all-hidden/selected-idle explanations with explicit keyboard/touch recovery. Show all clears both modes; Show selected preserves manual choices; focus returns to persistent mode control. Shared map/card filter and ETA math unchanged.158tests, both typechecks, Vite and actual mobile/desktop state/reflow/both-arrival checks pass. Evidence `ux-07/REPORT.md`, `verified.log`, `verified/` and integrity.json. HEAD/index preserved; controller review/publication next. UX07's bounded empty/feed/filter slice is complete; no blanket every-map accessibility claim.

UX09 follow-up: first fake-clock browser run exposed a Leaflet zoom timer during immediate tab switching; smaller baseline rapid-switch experiment did not reproduce. Final settled-animation checks pass, map implementation is unchanged. Reproduce with normal-clock rapid zoom/filter/unmount before classifying or fixing; do not restart the completed empty/feed baseline. UX08 alert/on-board coverage and same-bus pickup occurrence contract remain separate.

### UX-07 review corrections — builder complete, fresh review pending (2026-09-18 03:24 ET)

Both independent-review-round-9 findings corrected with actual built-SPA regressions. Guarded automatic recovery focus covers ordinary polls, external focus, view unmount/remount and newly running selection; off-route reporting snapshot retains 2/2 bus counts/warning while text explains Running now.158tests/types/build/mobile+desktop plus unchanged reviewer acceptance pass. Evidence `ux-07-fix/REPORT.md`; HEAD/index unchanged, no publication or fresh approval yet. UX08 remains next after independent review; broader view work is not complete.

### UX08 — stop-alert setup slice complete; independent review pending (2026-09-18 03:50 ET)

Browser-proved and fixed Escape leaving setup open and Cancel/Arm losing keyboard focus. Named route/stop groups, attached permission hint and expanded/armed semantics preserve same-stop attribution. ux-08/REPORT.md records126tests/types/build/mobile+desktop4permission checks, keyboard/touch/reflow/poll/navigation ownership and stale/missing/failed/empty→fresh notification behavior. Numerical/timing/delivery/storage unchanged; HEAD/index preserved. Remaining UX08: on-board missing/stale/arriving state, get-off dialog and finish focus; global alert-strip/banner removal/announcement. Those are not marked complete by this setup slice.

## Coordination addendum — 2026-09-18 03:51 ET

Read ETA03:49REQUESTS and cycle-11/INTEGRATION.md. The concrete eta-projection.patch is now available, still artifact-only pending independent prototype review. After this alert candidate's review, prioritize one combined pickup-selection identity/wait/action proposal using that patch plus the UX consumer: preserve current production with explicit patch/parity checks, missing-destination unknownness, selected bus despite missing target, same-bus later-visit wait with only one manual action, both arrivals, caution and focus. Do not publish unused metadata or treat the selected pickup as a boarding guarantee. If prototype review is not complete, continue the separate on-board recovery audit. This arrival does not expand the present two-file alert candidate.

### UX-06 coordinated pickup identity follow-up — builder complete, 2026-09-18 04:16 ET

Destination-independent selected bus/visit implemented using exact independently reviewed ETAcycle11projection; later same-vehicle pickup now uses selected wait with one action. Distinct bus retains two explicit choices and focus despite destination loss. Evidence ux-pickup/REPORT.md;147tests/types/build/four mobile+desktop browser runs,9376exact paired states and source/bundle integrity pass. HEAD8aa67bd/index preserved; independent review/controller gates pending. Existing duration/clock fallback and broader on-board/get-off/finish remain separate; next builderUX08recovery.

### UX08 — on-board prompt and ride-finish slice complete, 2026-09-18 04:39 ET

Reproduced/fixed open get-off prompt reverting to obsolete instructions on stale/missing/empty/farther position; current evidence now controls the title without changing notifications. Restored dialog,Done,Dismiss,replan and automatic end preserve useful keyboard focus. ux-08-ride/REPORT.md:62tests,types,Vite,final mobile+desktop14state44poll suites with actual touch,keyboard,reflow and final destination pass. Initial test-selector failure preserved/corrected;source/bundle/numerical/engine integrity passes. HEAD7f681d92/index preserved;independent review/controller gates pending. This bounded slice is complete;global alert-strip focus/announcement and broader off-route ride audit remain open. Next main itemUX09crash/offline recovery.

### UX09 — crash recovery slice complete; map lifecycle defect now reproduced (2026-09-18 05:13 ET)

Tested three-file candidate on deployedPR292: useful Reload first, explicit reset consequences (including Your reports linkage), guarded heading focus, independent technical disclosure and wrapping stack. ux-09/REPORT.md:46tests/types/Vite129modules,mobile+desktop keyboard/touch/reflow/reset/blocked-storage and full-SPA feed checks pass. Real cached offline shell/API-cache exclusion/reconnect independently exercised with bounded local8093fixtures; no offline code fix needed. HEAD/index preserved; independent review/controller publication pending.

Highest next builder: **UX09 map zoom teardown**, now positively reproduced with normal clock on BOTH current and frozen baseline. Two _leaflet_pos errors/one iteration; original long probe59errors/click timeout. See ux-09/NEXT_MAP.md and map-diagnostic.json. Existing map.stop cleanup does not prevent delayed _onZoomTransitionEnd on removed pane. No map fix in this candidate and no passing-map claim. After that, UX10. Broader SW-update/background/native-device and earlier UX08/fullscreen audits remain separate.

### UX09 map zoom teardown — tested candidate complete (2026-09-18 05:38 ET)

Preserved prior paired system-map failures and additionally reproduced ride-map zoom+Done on entry build. AllRoutesMap and RideRouteMap now use the existing trip-map zoomAnimation:false setting. ux-09-map/REPORT.md:77tests/types/Vite,seven successful browser reports,original3-cycle repro,24final mobile/desktop cycles,touch pinch/wheel/reflow/focus/final-walk checks pass. New meaningful built-SPA regression included. First setup and fixture-focus assertion failures preserved with corrections; runtime source unchanged after types/build. Source/bundle and exact two-option scope verified; HEAD/index preserved. Independent review/controller publication pending. NearbyStopsPicker is unreachable declaration-only and remains unmodified. Next bounded main itemUX10; no restart of completed recovery/offline/ETA work.

### UX09 map held-pinch review correction — builder complete, 2026-09-18 06:15 ET

Review15 blocker addressed with map-specific gesture/frame/document-listener cancellation before the two reviewed maps remove. ux-09-pinch/REPORT.md:77tests/types/Vite,8touchcases with listener0→1→0,unchangedreviewerDone/expiry,24lifecyclecycles,originalzoom/feed/fullscreen checks pass;8browserreportsclosed/errorfree. New unchangedentry systemfilter/nav pairs positively fail and candidatepasses. Initial type/fixture failures preserved with corrections. ExactHEAD/index/3files/source-bundle parity verified. This correction awaits fresh independent review/controller release; prior changes are not claimed deployed. NextUX10saved-list keyboard/edit/delete reproduction per NEXT_UX10.md; broader map/AT/Safari audits stay open.

### UX10 saved destinations and recents — builder complete, fresh review pending (2026-09-18 06:41 ET)

Selection,rename/delete,promotion/dedup and focus slice implemented after baseline browser reproduction.96tests/types/Vite,fourfinalbrowserreports and exactscope/sourcebundleintegrity pass; see ux-10/REPORT.md. EntryHEAD/indexa5966b1 preserved; prior recovery/map candidate remains intact. No builder publication. Weather/location preferences and UX11 remain unfinished; resume ux-10/NEXT_UX10.md after review.

### UX10 weather disclosure — builder complete, fresh review pending (2026-09-18 07:15 ET)

Native weather disclosure, explicit expanded/controlled state, named keyboard-scrollable hours, single-hour Tab skip and guarded refresh-removal focus implemented after frozen baseline reproduction.84tests/types/Vite plus mobile/desktop weather and search regression pass. Evidence ux-10-weather/REPORT.md. Weather text/numbers/arithmetic, units storage, ETA/planner/wire and prior PR293 behavior unchanged; HEAD/index preserved. Location denial typed-origin negative finding is supported; remaining supplemental scenarios are recorded separately, not part of this runtime change. UX11 and untested pending-location/Enter-before-results/Swap leads remain open.

UX10 final supplemental (07:19 ET): denied/unavailable/timeout explicit location requests and typed From recovery all pass; no GPS runtime fix supported for these cases. Ordinary weather refresh/selected-To fallback/navigation ownership pass. Four candidate browser reports are complete with zero errors and closed resources. Initial fixture mistakes retained, final evidence supplemental-verified/report.json. Next UX11 bounded operator Retry/filter audit; never-calling GPS/async Enter/Swap remain separate leads.
