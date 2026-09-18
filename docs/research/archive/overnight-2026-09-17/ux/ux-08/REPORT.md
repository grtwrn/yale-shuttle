# Keep stop-alert setup usable with a keyboard

Builder candidate, September18,2026 03:39–03:50 ET. Independent review pending. HEAD/base `7e29064475315c2d621b77cdca130c05737d1ab8` and empty index preserved. The controller owns capture, review routing, CI/staging, commits and publication.

## Problem and change

On the actual production-source SPA, opening a route stop's alert choices and pressing Escape left the chooser open. Activating Cancel or a lead-time choice removed the focused button and left focus off the stop's bell. The bell did not expose whether the choices were expanded or an alert was armed. `before-final/stop-alert-controls.json` records all these failures with no browser errors; `baseline-dist` and `TransitMap.baseline.tsx` freeze the comparator.

The candidate keeps focus on the same stop's currently rendered bell after arm, cancel or Escape. Escape works both from the bell and from within the choices. Restoration is synchronous and only happens on these explicit actions, so normal polls and leaving the view do not schedule a late focus change. Each bell exposes expanded and armed states; each chooser is a named route/stop group with its existing permission explanation attached; Cancel has an explicit accessible name. Opening another stop still replaces the first chooser and closes back to the correct bell.

Only two application files changed: `web/src/TransitMap.tsx` and the new reproducible `scripts/stop-alert-controls-check.mjs`, both under services/shuttle-v2. No numerical, estimator, ranking, occurrence, alert threshold, expiry, notification delivery, storage, map geometry or ride behavior changed. The current PR289 ETA walking-caution integration is preserved in the production comparator.

## Verification

1. Baseline reproduction, from services/shuttle-v2:

   `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08/before-final BASELINE=1 DIST=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08/baseline-dist flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node scripts/stop-alert-controls-check.mjs`

   Exit0, baseline-final.log: records missing expanded state, Escape not closing, Cancel/Arm focus loss. Baseline mode deliberately records instead of asserting candidate behavior. Closed browser resources; zero page errors.

2. Final candidate verification, from worktree root:

   `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08/release flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08/verify.sh`

   Exit0, release-verify.log:126tests in stopAlerts, stopAlerts.replay, leaveAlert, liveUpdates and mapFilter; backend/frontend typechecks; Vite build; actual built-SPA mobile and desktop browser suites. Each browser suite tests denied, unsupported, undecided→denied and granted Notification API fixtures. Enter/Space/Tab/Escape, touch arm, cancel/disarm, switching stops, polling/external/navigation focus, named groups/disclosures, existing permission copy, measured44px choices, and360/390/430/1280/640CSSpx reflow pass. Both suites verify persistent arms through tab changes, no fixture alert on stale/missing/failed forecasts or empty fleet, then delivery through OS mock or existing in-app fallback on recovered fresh threshold. All pages/contexts/browsers closed and errors empty. Screenshots `release/chooser.png` and `release/desktop/chooser.png` visually inspected; latter is640CSSpx desktop reflow.

3. Final integrity:

   `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-08/verify-integrity.py`

   Exit0, integrity.log/json: pins HEAD and empty index, checks exact scoped changed files, baseline/current bundle source equality, untouched planner/trip/ride/main/alert engine/card estimator and nine numerical/transport/filter modules, both completed browser reports and screenshot budget.209images/9,272,460bytes across teams at capture. `git diff --check` passed. The integrity script intentionally pins this builder HEAD; a reviewer should adapt that assertion after controller capture while retaining base/source checks.

## Retained setup/intermediate evidence

`baseline.log`/`before/` records an initial fixture timeout: it compacted the slash in Division / Prospect while the route row uses spaces. Only the selector was corrected. `verify.log` records the first passing candidate. `final-verify.log` is an intermediate failed attempt: the new opening-bell Escape check read the bundle compiled immediately before that last handler addition. No claim of a pass for that run; the complete final rebuild above passes and source-map integrity confirms the tested final source. Existing artifacts were preserved.

## Limits and next work

This is the stop-alert setup slice of UX08, not completion of the on-board audit. No native screen reader, physical phone, actual OS permission sheet/push/background delivery, native200%zoom, full suite, backend staging, CI or deployment is claimed. Requests are intercepted on a synthetic host, tester identity is seeded, and no production data or analytics are written. The normal notification fallback was exercised but its announcement and dismiss-focus semantics were not changed.

Next reviewer: independently check same-stop focus and correct group/bell association, Escape from opening bell, switching stops, and permission/freshness boundaries. Then resume UX08 on-board missing/stale bus status, get-off popup focus and manual/automatic finish recovery. Source inspection suggests testing retained bus positions and an already-open get-off popup through feed interruption; that is a hypothesis requiring an actual browser reproduction, not a proved bug here. Global alert strip/banner removal focus remains another bounded follow-up. ETA is preparing an independently reviewed pickup identity/occurrence contract under cycle-11; consume it only in a separately coordinated proposal, preserving both arrivals and numerical decisions.

All owned command sessions47390/12327/95375/88459/35861 completed. No owned browser/server/collector/lock remains; existing simulated-rider watcher untouched. No dependency install, other-team artifacts, controller files, credentials, historical data, Git index/HEAD/branch or publication action changed.

## Coordination addendum — 2026-09-18 03:51 ET

Read ETA03:49REQUESTS and cycle-11/INTEGRATION.md. The concrete eta-projection.patch is now available, still artifact-only pending independent prototype review. After this alert candidate's review, prioritize one combined pickup-selection identity/wait/action proposal using that patch plus the UX consumer: preserve current production with explicit patch/parity checks, missing-destination unknownness, selected bus despite missing target, same-bus later-visit wait with only one manual action, both arrivals, caution and focus. Do not publish unused metadata or treat the selected pickup as a boarding guarantee. If prototype review is not complete, continue the separate on-board recovery audit. This arrival does not expand the present two-file alert candidate.
