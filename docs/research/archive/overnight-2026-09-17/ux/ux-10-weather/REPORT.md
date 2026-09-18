# Make weather forecasts usable by keyboard

Builder proposal on deployed PR293, preserved HEAD `56a5258bd4c6a4869667a99d3b480b12a3ce61c9`. Independent review and controller release gates remain required.

The weather summary now exposes a native disclosure button with its expanded state and controlled hourly region. Keyboard users can reach and horizontally scroll the named hourly forecast. When only one forecast hour is available, the summary remains readable but is skipped in Tab order and announces that its action is unavailable. The separate Fahrenheit/Celsius switch and all existing weather text, numbers, thresholds and timing interpretation are unchanged.

A refresh can remove the hourly strip or the whole forecast. Focus follows a removed strip back to the summary, or a removed forecast back to the existing To control. The guard preserves outside focus and does not move focus on ordinary updates. This also handles a unit button disappearing with the forecast.

## Positive baseline evidence

`baseline/report.json` and `baseline.log` use the frozen entry production bundle in `entry-dist`. They positively reproduce:

- The expandable summary appears in the accessibility tree as `status`, not `button`, with no expanded state.
- A one-hour summary is a focusable no-op.
- Removing the focused forecast on refresh leaves `document.activeElement` at BODY.

The ten-hour strip is694px wide inside356px, with no name/role and tabIndex−1. This measurement alone does not establish whether a browser automatically offers a scroll focus stop; that claim is deliberately not made. The new explicit keyboard route is verified in Chromium. Baseline screenshot was visually inspected. Its source map contains the exact entry TransitMap source.

## Scope and implementation

Exactly two proposal files under `services/shuttle-v2`:

- `web/src/TransitMap.tsx`: weather-only focus refs/effect and capture handlers; native button semantics; single-hour Tab handling; controlled, named, focusable hourly region retained hidden while collapsed.
- `scripts/weather-controls-check.mjs`: bounded actual-built-SPA regression using `seedTestId`, fixed forecast clock and fully intercepted traffic.

Everything in TransitMap before/after the weather state/markup boundaries is exact entry source. Every other tracked source file is unchanged. Weather helpers/server/provider/storage, ETA/arrival/planner calculations, route/vehicle identity, both occurrences, historical samples, previous saved-place/map/recovery changes and all displayed forecast values are unchanged. No new accuracy/calibration/coverage claim.

## Executed checks

All browser/test/build work held `/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock`. No dependencies or servers were needed.

1. From `services/shuttle-v2`, `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10-weather/baseline DIST_ROOT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10-weather/entry-dist flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node scripts/weather-controls-check.mjs --baseline` — exit0, three positive baseline groups, zero page errors, closed resources.
2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10-weather/verify.sh` — exit0:84 tests in four files (`web/src/weather.test.ts`, `src/server/weather.test.ts`, `web/src/endpoints.test.ts`, `web/src/tripDraft.test.ts`), backend and frontend typechecks, Vite production build131modules. Full output `verify.log`.
3. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10-weather/browser.sh` — final exit0 (`browser-second.log`), three reports: mobile/desktop weather and existing navigation/search regression. Weather reports `final/{mobile,desktop}/report.json` pass six groups each, zero page errors and closed resources; navigation `final/navigation/after-browser.json` records completed checks.
4. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10-weather/verify-integrity.py` — exit0: exact HEAD/index, all other911tracked files, only two-file proposal scope, whole non-weather shell equality, baseline/current source-map parity and shared screenshot budget. Details `integrity.json`/`integrity.log`.
5. `node --check services/shuttle-v2/scripts/weather-controls-check.mjs` and `git diff --check` — each exit0.

The mobile/desktop weather fixture exercises Enter/Space/tap, Tab to the independent unit button then hourly region, real keyboard horizontal scroll, persisted units/reload, dry/wet/missing-temperature, current refresh, two-plus→one-hour→recovery, focused strip/full-forecast removal, outside focus, expired data, failed and pending requests and blocked storage reads/writes. Actual rendered controls meet44px; dry/wet/rain-only text remains one line at390px.360/390/430/640/1280px and200%CSSzoom have no page overflow. Screenshot inspection confirms no overlaps and unchanged compact weather hierarchy.

## Retained fixture failures

The first candidate browser run failed the scroll assertion because the fake JavaScript forecast clock did not wait for Chromium's real compositor smooth scroll. Adding a400ms real wait produces an observed40px horizontal scroll without an application change. First script, report and log remain in `weather-check-first.mjs`, `first-run/mobile/report.json`, `browser-first.log`. This is not represented as a passing first attempt.

## Limits and next work

These are mocked browser state/interaction checks, not physical-device, Safari or native-screen-reader certification.200% is CSS zoom/reflow. No production weather incident rate is inferred. Full suite/staging/CI/commit/PR/merge/deploy verification belong to the controller. There is no publication claim.

Review the small weather diff plus focus restoration on refresh and one-hour transitions. Preserve the completed baseline rather than rerunning it merely for fresh context. Remaining UX10 leads (never-calling location provider, Enter before geocoder response and small Swap control) and UX11 About/operator view coverage are separate; do not interpret this slice as every-view accessibility completion.

## Supplemental verification completed — 2026-09-18 07:19 ET

From `services/shuttle-v2`, `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10-weather/supplemental-verified flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10-weather/supplemental.mjs` — **exit 0**, eight groups, zero page errors, all resources closed. `supplemental-verified/report.json` and matching log are final.

Denied, unavailable and timed-out location requests all settle; typed From selects the intended coordinates and clears the obsolete error/spinner. Each case also verifies focused weather removal returns to the selected To summary without changing either endpoint. Ordinary weather refresh retains strip focus and scroll; leaving/reopening Trip retains navigation focus. These are useful negative location findings: no GPS fix is supported for these three cases. This does not cover a provider that never invokes either callback.

Earlier supplemental failures are preserved, with original scripts (`supplemental-first.mjs`, `supplemental-second.mjs`, `supplemental-third.mjs`) and reports/logs (`supplemental`, `supplemental-second`, `supplemental-final`). The first two reused browser storage between cases, so the expected Popular button had become an existing trip and then a Recent button. The third checked loading before the existing settle effect completed. The final fixture clears only its own synthetic draft/recents at navigation and explicitly awaits spinner removal. No application change was made after the original successful typecheck/build or for these fixture corrections.

Final integrity rerun passes with all four successful candidate reports (mobile weather, desktop weather, navigation/search, supplemental), exact source/bundle parity and preserved HEAD/index. Shared screenshot budget remains 445 files / 19,822,610 bytes. Sessions15939/8604/92856/67650/77103/70420/69153/87528 are complete and collected. No owned process, browser, server or lock remains; the existing watcher is untouched.
