# Rider UX fixes and validation

September 10, 2026. Excluded tester UUID: `00000000-0000-4000-8000-000000000000`. Mobile Chromium at 390 × 844.

Gold's observed pickup estimate stayed at 26 min for approximately 10 min; the initial wait was approximately 34 min. The new notice uses the collector's last_moved_at timestamp and describes reported position uncertainty after five minutes. It does not distinguish a physical hold from stale GPS and does not adjust ETA arithmetic. Five minutes is a presentation threshold, not a calibrated confidence interval.

Automatic ride endings now explain age, missing-bus, or off-bus triggers and retain the destination in the finish card. Find another shuttle opens the planner for that destination from current location at Now. Without a destination the card still offers the planner. The finish card is component state: refreshing after the ride has ended does not restore it.

The official Yale tracker now opens by default below the stop list. Its iframe remains lazy-loaded and can be collapsed/reopened.

## Final verification after the Pi reboot

- Backend/frontend typecheck passed with 768 MB Node heap cap.
- Production build passed with 512 MB cap.
- 80 focused tests passed, one worker, 512 MB cap: pickup notice, finish card, ride ending, arrival ambiguity, map focus, tracker URLs, planning time, trip draft, stand ranges.
- Single-page mobile browser checks passed with no uncaught errors: Gold notice/clearance on new movement, tracker default expansion/order/collapse/reopen, all three automatic-ending reasons, destination recovery and replan, dismissal, manual Done, no-destination fallback.
- Tasks ran sequentially. Browser closed after tests. External map tiles blocked and official tracker frame stubbed with an explicit placeholder to avoid remote browser load; these screenshots verify local UI, not upstream tracker rendering/performance.
- Gold replay uses recorded 19:51 UTC bus positions with current route/calibration tables and active-route flags. It is a UI reproduction, not a new ETA accuracy measurement.

## Remaining finding

Before the reboot, synthetic Green/Purple repeated-stop smoke tests exposed inconsistent arrival displays: bus and rider at repeated stop 25 (Building 800), boarded at 26, produced Get off here while the stop-list ETA showed 48 min on Green / 7 min on Purple. The underlying ambiguity-guard unit tests pass, but this does not make the two displays consistent. This is unresolved and outside these presentation changes. The reboot removed those temporary screenshots; the full visible text survived in prior-browser-results.json. Do not interpret these checks as production clearance for repeated-stop journeys.

## Evidence

- gold-before-live.jpg: actual live watcher screenshot before this change.
- gold-uncertainty-summary.png: controlled Gold replay with notice.
- tracker-expanded-below-stops.png: final local layout; remote content explicitly stubbed.
- tracking-age-recovery.png, tracking-bus-gone-recovery.png, tracking-off-bus-recovery.png: controlled ending cases.
- replanned-destination.png: destination preserved in a new plan.
- browser-results.json: final post-reboot results.
- prior-browser-results.json: retained pre-reboot results, including unresolved repeated-stop text.

Open index.html for the screenshot gallery.
