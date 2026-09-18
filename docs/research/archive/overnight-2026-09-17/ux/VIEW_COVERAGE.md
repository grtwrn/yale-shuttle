# Every-view coverage checklist

Bootstrap status: reachable surface inventory and relevant source inspected; **no browser verification yet**. Record dates, viewport, fixture/state and screenshot path for each later check. An unchanged but verified useful view counts as reviewed; a speculative redesign does not.

| Surface | Entry / owner | Rider question | Required states / checks | Status |
|---|---|---|---|---|
| First-open Trip | `TransitMap` → `TripPlanner` | Where am I going? | No location permission, loading GPS, blocked storage, no saved places, current location, typed origin, keyboard suggestions | Source inspected |
| Search and saved/recents | From/To `PlaceList`, saved destinations | Can I quickly find the right building/stop? | Idle suggestions, typed matches, none, pending/failure, long names, save/rename/delete, Enter/Escape/arrow behavior | Source inspected |
| Trip results | `TripPlanner` collapsed cards + overview | Walk or which shuttle? | Walk-only, multiple lines, two shuttle slots, missed bus, late/last bus, long walks, expanded more routes, reranking stability | Source inspected |
| Departure/future plan | “Leave” control | When am I leaving? | Now, future today/day, invalid/past, published hours, no live forecast, 16 px datetime input, 44 px controls | Changed and browser-verified 2026-09-17; see UX-01 report; independent review pending |
| Class deadline | `ArriveBy` | Can I get inside before class? | Fits, buffer only, late window, catch risk, missing/stale/future, walking fallback, clear deadline; target vs class time | Changed and browser-verified 2026-09-17; 18-state matrix + supporting-route cases, UX-01 fix report; fresh independent review pending |
| Trip details | Expanded route | What do I do next? | Back/draft preservation, wait/ride/walk stages, pickup direction, catchable bus identity, final walk, stale estimates | Source inspected |
| Combined minimap | Trip overview / expanded map | Where is my route and bus? | Overlapping buses/routes, long windows, wait marker X/~Y, viewport edge, route colors/names, fullscreen/back, keyboard equivalent | Source inspected |
| Pickup details dialog | Tap arrival | When should I reach pickup? | At stop, wide/narrow/missing window, next bus vs same bus next lap, hold location, open/close/Escape/backdrop/focus | Source inspected |
| Past-trip chart | Arrival dialog / destination disclosure | What did comparable trips actually take? | Zero/few/many, standing/departure match, recent weights, short real trip, fetching/error/refresh, dates/table, phone access | Source inspected |
| Forecast plot | Existing optional disclosure | What uncertainty remains? | Model vs observation, clock vs duration axis, class/target/walk markers, few points/no distribution, clear source | Source inspected |
| System Map | Map tab | Where is my line now? | One/all/none selected, selected idle, no fleet, stale feed, location denied, pan/zoom/locate, route identity | Source inspected |
| Route/stop cards | Under Map | When does my line reach this stop? | Selected stop, saved stop, both slots, standing bus, route off-hours, pickup direction, alert control, long names | Source inspected |
| Nearby stops | Stop picker | Where should I stand? | GPS unavailable, closest choices, manual choice, distance units, side/direction, keyboard/touch | Source inventory; deeper inspection pending |
| Berth guidance | `BerthDisclosure` / inset | Where does this bus actually pull up? | Published vs observed stop position, uncertain/no alternate, route-specific evidence, mobile map and words | Source inventory; deeper inspection pending |
| Departure/stop alerts | Contextual controls + global banner | When do I need to leave / watch for bus? | Permission undecided/denied/granted, armed/cancelled, background/foreground, ETA changes, banner action/dismiss | Source inventory; deeper inspection pending |
| On-board page | “I'm on this bus” | When do I get off? | Stops away, at exit, missing/off-route bus, feed interrupted, alert dialog focus, long destination, locate | Prompt changed/browser-verified 04:39 ET; missing/stale/recovery and focus covered; off-route/locate remain open |
| Ride finish | Done / tracking auto-end | How do I finish my trip? | Manual end, bus gone, off-bus, timeout, final walking destination present/absent, another shuttle | Focus changed/browser-verified 04:39 ET; manual/age/replan/final walk; other reasons/absent destination covered by targeted tests |
| Issues | Issues tab | Was my report addressed? | Empty, loading/error/retry, open/replied/resolved/archived, follow-up + screenshot, busy/rate-limit/failure, blocked browser identity | Source inspected |
| General feedback | Footer/report entry | Can I report the problem quickly? | Text, priority, screenshot picker/paste/drop/remove, attachment processing, busy/failure/success, preserve draft | Source inspected |
| Weather / contextual preferences | Trip weather line | Will rain affect my walk? | Available/missing/stale, collapsed/expanded, °F/°C saved/blocked, six-hour scroll, touch/keyboard | Source inspected via shell/docs |
| Header/footer/navigation | Global | Where am I and how do I recover? | Selected view announced, report badge, refresh clears planned trip as requested, contribution/about/feedback links, narrow viewport | Source inspected |
| Stale/offline/loading shell | Global updates notice / SW | Can I trust what I see? | First load fail, interrupted poll, no buses vs no feed, background resume, offline cached shell, recovery | Feed states verified in prior UX07; real cached shell/network offline/reconnect verified UX09. Native background/update races remain unverified |
| Crash recovery | `main.tsx` boundary / `CrashRecovery` | How do I get the app back? | Reload, reset consequences, optional technical details, keyboard and explicit-only reset | Changed and browser verified; UX09 independent review pending, ux-09/REPORT.md |
| About | `/about` | Who operates this? | Back link, phone text, dark mode, offline/simple page; preserve operator-authored personal story | Source inspected |
| Operator rider stats | `/stats` | What service usage is occurring? | Auth, loading/error, stale, ranges, tables/chart meaning, mobile/keyboard; no rider-nav link | Source inventory; deeper inspection pending |
| Operator stop studies | `/stats/stops` | What measured and predicted data explains a stop? | Auth/local study, route/date/bus/occurrence selection, no data, recording gaps, baseline/candidate/observed legend, import errors, keyboard | Source inspected |
| Isolated review previews | `?review=minimap`, `?review=berth` | Test fixtures only | Keep usable for review; do not expose as new rider screens | Source inspected |

## Per-surface acceptance columns for follow-up

For each surface record: 360/390/430 px and desktop; keyboard and focus; 200% zoom; key action and information hierarchy; touch sizes; visible/accessibility labels; fresh/loading/empty/stale/error; long route/stop names; color-independent route identity; reduced motion if applicable; screenshot/fixture; reviewer verdict. Mark not applicable explicitly rather than silently skipping.

## 2026-09-17 UX-01 browser coverage

Only Class deadline and Departure/future plan are claimed verified this round. Actual component and built-SPA browser checks at 360/390/430/1280px, 640 CSS-pixel equivalent desktop 200% reflow, keyboard/focus, control bounds and long names are documented in `ux-01/REPORT.md`. No separate screen reader/native zoom session. The empty fleet is a future-planning fixture, not a claim about overnight Red service. Adjacent map/history/ride/feedback views remain pending; no all-views claim.

## 2026-09-17 22:58 ET — UX-01 correction coverage

Class deadline: original 18-state matrix reverified, plus supporting buffer/connection/limited route behind actual top-three visibility; bus/window/action association, Tab/Enter/Space, no duplicates, interrupted/recovered feed, and named primary-route distribution (50 dots, Space) checked. Departure/future built SPA reverified unchanged. Evidence `ux-01-fix/REPORT.md`.

Trip details / combined map: **only the hidden-route direct-selection regression** newly browser-verified and changed. The actual shell with fixed candidate TripOptions opens Blue Day #410 and its route map; Back retains class time/buffer and original collapsed top-three overview. Details reflow at 360/390/430/1280/640px. This does not complete the broad map overlap, two-bus, fullscreen, alerts or full trip-details audit; those stay on UX-05/06. Fresh independent review pending.

## 2026-09-17 23:24 ET — UX-02 navigation and search

First-open Trip / From-To search / header navigation: changed and browser-verified in actual built SPA with intercepted empty-fleet/geocoder fixtures. Explicit endpoint/list names, navigation current-page state, arrow/Enter/Space/Tab/Escape, selected-summary focus, rapid origin reopening, ordinary blur auto-resolution, touch and non-stealing focus, pending/empty/failed/recovered queries, unavailable GPS and draft restoration covered. 360/390/430/1280px plus 640 CSS-pixel reflow, long accessible match name, 16px input, >=44px input heights/navigation targets. Evidence `ux-02/REPORT.md`, `after-browser.json`, passing verification logs. Independent review pending.

No claim of full saved-place controls, native screen reader, physical phone or native zoom verification. Cancellation of empty editors and Enter before results remain UX-10 focus follow-ups. Issues was opened by keyboard as a navigation check only; UX-03 form/reply audit remains next. Full map/ride/history views remain pending their existing backlog items.

## 2026-09-17 23:36 ET — UX-02 independent verification

Navigation and displayed-place search approved at55b20a7; `independent-review-round-3.md`. Candidate phone/touch/keyboard matrix independently executed, plus To blur/refocus/reopen, frame-time focus ownership, view-change timer cleanup and draft retention, From failure/recovery, and actual desktop context with unavailable live feed. 1280/640 desktop reflow and 360/390 phone screenshots inspected. No full screen-reader/phone/native-zoom/all-keyboard-path claim; UX-03 and other broad surface audits remain open. Existing unknown-feed/no-shuttles wording is recorded for UX-07/09.

## 2026-09-18 00:02 ET — UX-03 feedback and Issues

General feedback and issue replies: changed and browser-verified, awaiting independent review. Built-SPA mobile360/390/430px and actual desktop context1280/640 CSS-pixel reflow, explicit labels/selected priorities,44px bounds,16px fields/select, Tab/Enter/Space, actual mobile taps, native filechooser events, unreadable image/recovery/replace/cancel/remove,503/429 preserving draft/image, successful retry/status/reset, close focus and async navigation non-stealing. Reports loading/failure/keyboard retry/empty and archived disclosure checked. Source and fixtures in `ux-03/REPORT.md`; mobile/desktop JSON and screenshots reviewed visually. No page errors. No new ETA/route/history claim or production report request. Paste/drop helper tests passed; no OS clipboard test, native screen reader/phone/zoom, or comprehensive cancel/reopen/parallel-request audit. Other surfaces stay at their recorded status; next UX-04.

## 2026-09-18 00:29 ET — UX-04 arrival history

History detail changed and browser-verified, independent review pending. Actual ArrivalDetails/ArrivalHistory/ArrivalPlot components in bounded synthetic-network fixtures: standing/departure context, captured snapshot/count/start-date range, recent-weighted summary or insufficient evidence, observed30sec–45min tails,1/2/8/100 samples, formula/table disclosures, separate50-dot forecast and bounds-only fallback. Refresh pending/success/error/timeout focus, no duplicate request, old-response/new-bus race, loading/503/malformed/retry/empty/unmatched/old snapshot, midnight-crossing service dates and ETA tick no-refetch. Both following bus and same-bus next lap/missing next remain intact.360/390/430px mobile and1280/640 CSS-pixel desktop reflow,44px actions, keyboard Enter/Space/Escape, actual mobile tap and native dialog focus. Zero page errors, screenshots visually inspected. Evidence `ux-04/REPORT.md` and `date-verify.log`.

This does not reverify the complete SPA/history entry, real cohort selection or stale live-feed gating. No external screen reader/physical phone/native zoom; no claim that hover titles provide mobile data access (the table does). Minimap overlap and broader map/ride surfaces remain UX-05 onward; no every-view completion claim.


## 2026-09-18 01:05 ET — UX-05 minimap attribution

Combined minimap changed and browser-verified, independent review pending. Actual component plus unmodified built-SPA tests: co-located Red/Blue Day/Brown, active/just-passed same-route buses, full route disambiguation without color, bus-number/observed-wait accessible names, compact elapsed/usual-total text, long Orange Night/East and broad pickup windows, in-place poll/focus, keyboard tooltips/zoom, fullscreen touch/Enter/Back/Escape, edge pan, missing/empty and full-SPA fresh-to-stale timing removal. Mobile 360/390/430 and separate desktop 1280/640 CSSpx contexts; measured 44px fullscreen target. Wait labels remain bounded and separate from bus/time labels in these fixtures. Source and before/after evidence: `ux-05/REPORT.md`. Following #309 retained in the actual #307 arrival dialog; no new ETA numerical claim.

Existing limitations remain explicit: geographic pin coincidences are preserved, no separate second upcoming-bus waiting marker is invented, dense endpoint chips can approach the legend/attribution, tiles are blocked, no native assistive technology/physical phone/native zoom. Fullscreen Back-to-BODY focus reproduced in baseline and candidate, carried to UX-06. Static MinimapReview art preview is not this production map; no edit needed there. Other map/ride/berth views remain at prior coverage; no every-view completion claim.


## 2026-09-18 01:52 ET — UX06 fullscreen return slice

Overview/expanded route map, walking TripMap and berth inset: changed and browser-verified for Back Enter/Space/touch, close Space, Escape from toggle/Back/zoom, consumed Escape, ordinary Tab after return, external focus ownership,44px close controls and Leaflet identity preservation. Berth disclosure folded/unmounted and reopened, published directions, inert panning restoration, missing timing/empty options, long accessible stop name and360/390/430/1280/640 CSSpx reflow checked. Full built SPA verifies Red detail/berth keyboard+touch, All routes retains endpoint/departure draft, pickup#307/following#309 and stale timing removal. Evidence ux-06/REPORT.md, final/, supplemental/ and supplemental-desktop/; zero page errors. Independent review pending.

This completes only fullscreen return focus within UX06. Remaining trip next-action/catchable-identity/ride-exit/final-walk and full modal-focus-trap/whole-map-removal audits remain open. Tiles are intercepted; no screen-reader/physical-phone/native-zoom/all-view completion claim.

## 2026-09-18 02:30 ET — UX06 trip identity/action/final-walk slice

Expanded trip: changed and actual-built-SPA verified for distinct pickup/journey buses, correctly attributed wait/ride, both explicit boarding paths,44px targets, Tab/Enter/Space/tap and polling/disappearing-action/external focus. Pickup/exit stop names visible, both pickup slots retained, Back preserves draft, missing/stale/recovery and ordinary same-bus state checked. Actual nonzero final-walk destination survives either boarding choice and Done, including valid Google walking target and no fixed origin. Mobile360/390/430 and separate desktop1280/640 CSSpx; screenshots inspected; no errors. Evidence ux-06-trip/REPORT.md; independent review pending.

No blanket UX06/08 completion: later occurrence of same vehicle and missing destination forecast need numerical identity contract, native assistive technology/phone/zoom and on-board alert/auto-end/whole-view focus remain open. Existing fullscreen work is deployed per controllerPR287. Next UX07 missing feed versus empty service.

## 2026-09-18 03:00 ET — UX07 Trip/Map empty and unavailable states

Changed and browser-verified on actual built SPA: pending/failed first request, fresh empty, failed-after-empty, malformed response, missing/stale ETA with fresh counts preserved, retained fleet past45sec failure, fresh empty/nonempty recovery, off-hours reporting, cached announcements, route schedule/walk fallback and both pickup slots. All-hidden and selected-idle map/card explanations, explicit44px recovery, manual-route persistence, pressed state, Enter/Space/touch, focus after recovery, phone360/390/430 and desktop1280/640 CSSpx reflow checked. Evidence `ux-07/REPORT.md`, final `verified/` mobile/desktop reports and inspected screenshots. Independent review pending.

Tiles intercepted; no native assistive technology/phone/zoom or full-map/on-board audit claim. First synthetic-clock rapid transition encountered a Leaflet timer; simpler baseline probe did not reproduce; final harness settles animations400ms. That timing stress needs separate normal-clock reproduction. UX08 alerts/on-board and same-bus occurrence semantics remain unfinished.

## 2026-09-18 03:24 ET — UX07 reviewer boundaries corrected

Actual built-SPA mobile/desktop: automatic empty-fleet and newly running selected route remove focused recovery with mode focus; unchanged poll retains recovery focus; appearing recovery does not steal focus; external Issues focus and outgoing view remain undisturbed; returning Map uses the newly mounted target. Current off-route positions without forecast are labeled as filtered, and recovery retains 2/2 buses / 2 off route. Phone/desktop screenshots inspected; all earlier loading/failed/empty/stale/missing/malformed/off-hours, filter, keyboard/touch, both-arrival and 360/390/430/1280/640 CSSpx checks still pass. Original reviewer boundary acceptance passes. Evidence ux-07-fix. Fresh independent review pending; no wider/native-accessibility claim.

## 2026-09-18 03:50 ET — UX08 stop-alert setup

Route-card stop-alert disclosure **changed and browser verified**: bell/choices Escape, correct-stop focus after arm/cancel, expanded/armed states, named group/permission description, switching stops,44px choices and360/390/430/1280/640CSSpx reflow. Actual built-SPA mobile/desktop4permission fixtures exercise denied/unsupported/default→denied/granted, no permission ask on opening, persistent arms across tabs, no stale/missing/failed/empty fixture firing and fresh recovery delivery. Native permission sheets/OS push/background/native assistive technology not tested. Main alert fallback exercised without semantic changes; on-board/get-off/automatic-end audit and banner/strip dismiss focus remain unfinished. Evidence ux-08/REPORT.md; independent review pending.

## 2026-09-18 04:16 ET — selected pickup identity and occurrence

Expanded trip changed and actual-built-SPA verified for destination-independent#309identity/17min wait/two explicit actions, same-bus later#307visit/41min/single action, disappearance focus, missing/recovered destination, stale/missing/failed feeds, raw walking caution, departed recovery, real future-plan clearing, physical bus storage/reload, final walk and both next-arrival/next-pass labels.360/390/430mobile and1280/640CSSpxdesktop,44px actions,Tab/Enter/Space/Escape/tap,reflow,screenshots inspected,zero page errors/resources closed. Evidence ux-pickup/REPORT.md; independent review pending. No nativeAT/device/zoom/all-onboard/every-view claim; historical incidence/calibration unchanged.

## 2026-09-18 04:39 ET — UX08 get-off prompt and finish recovery

Changed/browser-verified actual built SPA at390/1280px,with320/360/430/640reflow and actual mobile tap. Two/one/zero stops,open prompt stale/missing/empty/farther/failed-expired/recovery and initial unavailability checked;no duplicate notifications. Tab/Shift+Tab/Escape,restored prompt fallback,external focus,manual/automatic end,Dismiss/replan and Map→Trip recovery pass. Long final destination and origin-free walking link retained. Report ux-08-ride/REPORT.md;14recorded states/44polls per viewport,zero page errors,allresourcesclosed.62tests/types/build pass;source/bundle/unchanged numerical/engine audit passes.

No native AT/device/zoom/OS-background-delivery claim. Browser auto-end uses age;bus-gone/off-bus/invalid destination and repeated-stop guards covered by targeted tests. Global alert-strip removal/announcement,off-route whole-ride keyboard/locate and complete route census remain unverified by this slice.

### UX09 follow-up — 2026-09-18 05:13 ET

Normal-clock Map zoom → Trip and zoom/filter teardown emits asynchronous Leaflet errors on current and exact production baseline. This supersedes the earlier unconfirmed fake-clock lead. ux-09/NEXT_MAP.md gives bounded reproduction, stack, exact source/bundle parity and next scope. Crash fallback changes do not catch or fix this separate callback failure. Do not mark whole-map lifecycle complete.

## 2026-09-18 05:38 ET — reachable map teardown follow-up

System map and on-board map: **changed and browser verified**, independent review pending. Source correction disables CSS zoom completion on unmount while preserving zoom/pan/touch/wheel behavior. Actual mobile/desktop six rapid teardown cycles per map,empty/failed/stale/recovery adjacent states,filter and finish focus,final destination and320–1280reflow pass; original normal-clock failing sequence now passes. See ux-09-map/REPORT.md. Trip overview/walk/berth maps: existing fullscreen keyboard/touch/focus regressions pass with unchanged implementation. NearbyStopsPicker: source-inspected declaration-only,not current reachable view; no live-view defect/fix claimed. Physical device/OS background and native AT remain separate.

## 2026-09-18 06:15 ET — bounded system/ride touch teardown verified and changed

Review15 held-pinch blocker corrected on AllRoutesMap/RideRouteMap only. Built-SPA8gesture/removalcases and actual listener accounting, reviewer manual/automatic expiry, mobile/desktop zoom/pan/reflow/focus and feedstates all pass. Evidence ux-09-pinch/REPORT.md. This is no blanket every-map or physical-device claim; other trip/berth held gestures remain source-only concerns. UX10next source-only inventory is ux-09-pinch/NEXT_UX10.md.

## 2026-09-18 06:41 ET — saved destinations and recents

Reachable Trip no-options lists: changed and actual-browser verified (fresh independent review pending). KeyboardTab/Shift+Tab/Enter/Space/Escape,touch/click,renamecommit/cancel/blank/blur/reload,delete/promotion/clear/final-rowfocus,coordinate dedup,12itemscroll,externalfocuspreservation,blockedread/write,pending/failed/emptyfeeds and unavailableGPS checked. Longnames360/390/430/640/1280plus200%CSSzoom/44pxtargets/16pxinput pass. Existing search and stale/missing/failed/recovered feed regressions pass including bothbuses. Evidence ux-10/REPORT.md. No nativeAT/physicalphone claim. Weatherdisclosure and fullGPSdenial→typed-origin recovery remain source-only/unverified; UX11stillpending.

## 2026-09-18 07:15 ET — weather controls

Changed and browser-verified actual built SPA: native disclosure name/expanded/controls, keyboard Enter/Space/tap, independent unit Tab order, horizontal keyboard scroll, one-hour no-op skipping, refresh removal/focus and outside focus preservation. Dry/wet/rain-only/missing/pending/failed/expired, storage read/write denial, 360/390/430/640/1280 widths,200%CSSzoom and44px targets pass.390px baseline/wet screenshots visually inspected; compact line retained. Source/bundle parity and all non-weather source invariants pass. Evidence ux-10-weather/REPORT.md; independent review pending. No nativeAT/Safari/device or whole-view completeness claim.

07:19 ET supplement: actual shell denied/unavailable/timeout location errors settle; manual typed From recovers correct coordinates and removes obsolete error/spinner. Selected To survives weather removal with correct focus and endpoints. Ordinary weather refresh preserves focused strip/scroll; Map→Trip preserves navigation focus. No GPS change; final8group report ux-10-weather/supplemental-verified/report.json. Never-calling provider/native permission sheets remain unverified.
