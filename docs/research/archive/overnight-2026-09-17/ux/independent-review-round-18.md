# Independent review 18 — weather disclosure and keyboard access

Reviewed September 18, 2026, 07:21–07:27 ET, controller round 12. **Verdict: approve. No blocking findings.**

Exact head: `413c85ac5158ef5d4f5c0c50ecf7c8e9c43a1c97`.
Exact supplied base and independently checked merge-base: `56a5258bd4c6a4869667a99d3b480b12a3ce61c9`.

The complete candidate is two files: weather-only markup/focus state in `services/shuttle-v2/web/src/TransitMap.tsx`, and the new bounded browser regression `scripts/weather-controls-check.mjs`. Checkout and index remained unchanged throughout review. Fresh evidence is in `review-ux10-weather/`; builder evidence was inspected and preserved rather than assumed correct.

## Supported behavior

The weather summary is now a native button with the correct accessible name, disclosure state and controlled region. The collapsed region is hidden from the accessibility tree and Tab sequence; the expanded hourly strip is a named, keyboard-focusable region that actually scrolls with keyboard input. Units remain a separate sibling button. The single-hour summary remains readable and explicitly unavailable, is skipped by Tab, and does not open a nonexistent strip. Existing focus on that summary survives the transition to one hour so the rider can continue to the unit switch.

Actual-browser tests establish guarded focus recovery when refreshed data removes the focused strip, summary or unit control. A removed strip returns to the remaining summary; removal of the whole forecast returns to the existing To input or selected To summary. Ordinary updates retain strip focus and horizontal scroll. Navigation and deliberately focused outside controls retain focus. Repeated disappearance/recovery does not leave stale focus ownership.

The reviewer-authored extra fixture reuses the synthetic setup/traffic interception but supplies six distinct interaction groups: collapsed-region Tab exclusion; whole forecast removal while the strip is focused; repeated disappearance/recovery; preserving a typed destination query; natural forecast expiry after failed refresh; pointer activation of the single-hour no-op while the unit action remains usable. All six pass with no page errors. Pending/missing/expired/failed initial weather leaves place entry usable. Supplemental browser tests also independently pass denied/unavailable/timed-out location recovery and selected-To fallback without changing endpoint coordinates.

Fresh 390px dry and wet screenshots were visually inspected. The compact line, independent unit action and horizontal hours remain legible without overlap. Main browser checks exercise mobile touch and desktop keyboard/pointer, 360/390/430/640/1280px reflow, 200% CSS zoom, 44px touched controls, unit persistence and blocked storage. Native screen-reader behavior, Safari and physical devices are not certified by these Chromium checks.

## Scope, prior evidence and integration

Exact source comparison proves that all non-weather portions of TransitMap equal the supplied base. Weather values/copy/helpers/provider/cache/storage, ETA calculations, planner ordering, route-forward tracking, route/bus identity, both stop occurrences, historical data and the previous saved-place/map/recovery release remain unchanged. There is no new forecast accuracy, calibration, normality or interval-coverage claim. Current ETA progress/requests and release/follower research were read; this proposal needs no shared-interface change.

Builder baseline source-map provenance independently matches the supplied base. Its retained report positively reproduces the status-role disclosure, focusable one-hour no-op and focus loss after forecast removal. The completed baseline experiment was not restarted. Previous independent review17 belongs to the already deployed base; this approval is based on the new two-file diff and fresh execution.

Fresh search/navigation checks pass, including delayed/reopened search and draft behavior. Fresh feed-state checks pass pending/failed/malformed/stale/empty/recovered states, off-hours and filtered counts, with both #307 and #309 pickup slots retained. Server tests independently exercise checkpoint restart, warm-state parity, cache/weather behavior and Docker runtime import closure. The actual service-worker offline-shell and map pinch experiments from the prior release were not repeated: their source is unchanged and their earlier evidence is retained. No claim of a new real-offline or deployment-version test is made.

## Independently executed commands

Commands used this worktree's own dependencies. Heavy test/build/browser commands held the shared lock for their complete execution. No local server or persistent watcher was launched.

1. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-10-weather/verify.sh`

   **Exit 0**; `review-ux10-weather/verify.log`. 84 tests in four files, backend and frontend typechecks, Vite build with 131 modules pass.

2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux10-weather/integration.sh`

   **Exit 1**; `integration.log`. Mobile weather, desktop weather and navigation/search all passed first. The reviewer extra fixture then passed five groups and timed out on `locator.click()` for the explicitly ARIA-disabled single-hour summary. Playwright's actionability gate refused the intended pointer probe; this was not an application exception or failing no-op behavior. Initial script/report/log are preserved in `extra.mjs`, `extra/report.json`, and `integration.log`; all its resources closed.

3. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux10-weather/remaining.sh`

   **Exit 0**; `remaining.log`. Corrected reviewer fixture uses actual coordinate mouse input to the disabled summary and passes all six groups. Supplemental eight-group weather/location checks and eight-group feed checks pass. 39 additional tests in `serverEta.test.ts`, `serverEta.parity.test.ts`, and `serverEta.closure.test.ts` pass. Total: **123 tests in seven files and six successful browser reports**, no page errors. Successful navigation script explicitly closes its page/context and browser; all other reports record closure.

4. `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux10-weather/integrity.py`

   **Exit 0**; `integrity.log/json`. Exact head/base/merge-base, clean checkout, unchanged index tree, all 913 tracked file hashes and 63 builder artifact hashes verified. Exact two-file scope, unchanged non-weather shell, candidate bundle source parity and baseline bundle provenance verified. All six successful browser reports verified. Shared screenshot census: **456 images / 20,313,553 bytes**, below 100MiB. Existing evidence preserved.

5. `git diff --check 56a5258bd4c6a4869667a99d3b480b12a3ce61c9..HEAD`, `node --check services/shuttle-v2/scripts/weather-controls-check.mjs`, and `node --check /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-ux10-weather/extra-corrected.mjs`: **each exit 0**.

## Handoff

Controller may proceed with remaining full-suite/staging/CI/publication/deployment gates for this exact head. Next bounded UX work is the source-only UX11 Retry/weekday-filter focus audit in `ux-10-weather/NEXT.md`; weather/location edge leads remain separately documented. These are not blocking findings against this coherent weather improvement, nor is every-view accessibility claimed complete.

Sessions 89886, 60199, 88468 and 32555 completed. Every launched browser/page/context closed; no owned server, heavy command or lock remains. Existing simulated-rider watcher untouched. No application fix, tracked file edit, branch/commit/index change, GitHub/publication/deployment operation, controller file/state change, other-team artifact change, private feedback access, credentials or historical database mutation occurred. Only reviewer artifacts and own team notes were written.
