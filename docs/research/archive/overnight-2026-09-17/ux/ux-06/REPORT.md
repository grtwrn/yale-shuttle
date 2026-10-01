# Restore keyboard focus after closing fullscreen trip maps

Builder candidate, September 18, 2026, 01:38–01:52 ET. Base/HEAD remains `8de0eed1c6a869606272824fd3dcac753ce32836`, controller branch `overnight/ux-20260917-006`. No commit, staging, publication or deployment by this role. Independent review is pending.

## Problem and result

Closing the fullscreen overview with Back dropped keyboard focus to BODY, as already established by UX05. This round reproduced the same failure on the walking map and pickup-location inset: Back activated by Enter, Space or touch, and Escape while Back had focus, all removed the focused control without a replacement.

The three maps now share `useMapFullscreen`. Explicit Back/close returns focus to the persistent expand button before Back disappears. Escape does the same when focus belongs to the map; if the rider has moved focus outside it, that focus is preserved. A consumed Escape is left to its existing handler. The window listener is removed on close/unmount. `preventScroll` avoids an extra scroll caused by calling focus.

The same Leaflet instance remains mounted. Existing size invalidation, geometry, Back and close locations, 44px targets and berth panning/disclosure behavior remain intact. No map labels, ETA arithmetic, bus selection, trip ranking, route positions, wire semantics, history or both-arrival behavior changed. This is the fullscreen-return portion of UX06; broader next-action, ride-finish and catchable-bus audits remain unfinished.

## Proposal files

- `services/shuttle-v2/web/src/useMapFullscreen.ts`: shared state, close/focus and Escape lifecycle.
- `web/src/TransitMap.tsx`: connect overview and walking map wrapper/toggle/close controls.
- `web/src/BerthInset.tsx`: same handling for pickup-location inset; existing arm/disarm preserved.
- `web/src/berthMap.test.ts`: existing source-shape test now follows the extracted hook instead of requiring inline Escape code.
- `scripts/fullscreen-map-check.mjs`: reproducible actual-component browser regression, with all requests intercepted and tester identity seeded.

`source-hashes.json` freezes these five files. Both frozen baseline sources match exact HEAD blobs byte-for-byte. Working index and HEAD remain unchanged.

## Executed checks

From `services/shuttle-v2` unless the checked script changes directory itself:

1. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-06/baseline BASELINE_DIR=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-06 flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node scripts/fullscreen-map-check.mjs --baseline` — exit0, `baseline-browser-2.log`, `baseline/before-browser.json`. All three maps reproduce Back and Escape-from-Back → BODY,18 recorded close states, no page errors. This extends, rather than restarts, the completed UX05 investigation.
2. `OUT=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-06/mobile flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock node scripts/fullscreen-map-check.mjs` — exit0, `first-browser-2.log`: initial candidate18 close states pass.
3. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-06/verify.sh` — final exit0, `verify-2.log`:51 tests in5 files (`berthMap`, `berthDisclosure`, `berths`, `mapLabels`, `arrivalDetails`), backend/frontend `npm run typecheck`, `cd web && npx vite build` (125 modules,4.78sec), separate mobile and desktop component browsers, and the built-SPA browser. Outputs in `final/`, with desktop separate.
4. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-06/browser-final.sh` — exit0, `browser-final.log`. Final repository harness adds consumed/unconsumed Escape and ordinary Tab after returned focus; mobile21 and desktop18 closing-state records, no errors. Only browser-test additions/formatting followed the successful app build. Outputs `supplemental/`, `supplemental-desktop/`.
5. `node --check services/shuttle-v2/scripts/fullscreen-map-check.mjs`, `git diff --check`, `git diff --cached --exit-code`, exact HEAD/baseline/source-hash checks — exit0.

## Browser evidence and boundaries

Actual components, synthetic props: CombinedTripMap, TripMap and BerthDisclosure/BerthInset. Test-only exports allow the two private map components to mount; the app behavior is otherwise real. At 360/390/430px,1280px and640 CSSpx reflow, no page overflow. Actual mobile context/taps and separate desktop context; Back Enter/Space/touch, close Space, Escape from Back/zoom/toggle, consumed Escape, external focus ownership, subsequent Tab, ≥44px close controls, fullscreen viewport size and stable map instance all pass. Missing times and empty options retain usable controls. The berth returns to inert/pannable-off, unmounts while its disclosure is folded, and reopens without retained fullscreen. Component unmount closes map resources. Long stop names retain their accessible label. All browser errors arrays are empty.

The unmodified built SPA uses a fabricated two-bus server wire on the checked-in route network and the real planner. It opens Red details, expands the published/expected pickup-location map, closes by keyboard/touch with restored focus, checks walking directions still point to the published pickup coordinate, and returns to All routes with the same origin/destination/departure draft. Pickup#307 and following#309 remain distinct. Fresh-to-stale transport removes pickup/wait timing. `final/shell-map.json` records four passed checks, resourcesClosed true. `shell-fullscreen.mjs` is the artifact-only extension of UX05's already successful app fixture; no old evidence was overwritten.

Screenshots visually inspected: `mobile/after-berth-390.png` and `final/shell-berth-390.png`; final component phone/desktop screenshots are also saved. Map tiles/directions/API requests are intercepted, so screenshots intentionally have neutral map backgrounds. This is no claim about real street tiles, physical phones, native screen readers or native browser zoom.640 CSSpx is equivalent reflow coverage. Fullscreen focus trapping/modal semantics and focus on asynchronous removal of an entire map are not changed or comprehensively audited. Loading/error ETA semantics stay in the existing app; this slice verifies fresh/missing/empty/stale control behavior, not every transport state.

## Retained failures

- Initial script write used a repo-relative path from the v2 cwd; it failed before creating the script. `baseline.log` preserves the consequent missing-script command. A later first candidate command also used the wrong cwd (`first-browser.log`). Corrected paths passed; no app fix related to either.
- First custom esbuild setup conflated case-distinct `ArrivalDetails.tsx`/`arrivalDetails.ts` and `ArriveBy.tsx`/`arriveBy.ts`. `baseline-browser.log` preserves it. The same exact-extension resolution used in prior harnesses fixes the setup (`baseline-browser-2.log`); no app imports changed.
- Initial `verify.log` has50 passing tests and one failed source assertion requiring inline Escape code. The existing assertion now follows `useMapFullscreen`; real Back/Escape behavior is verified in the browser. All51 pass in `verify-2.log`. No behavior assertion was relaxed.

## Review and next slice

Independent reviewer should inspect focus ownership, synchronous focus before Back unmount, escape listener cleanup, and all three consumers; rerun with a fresh OUT to preserve evidence. `verify.sh` honors OUT and uses final repository browser tests. Full suite, complete backend staging/CI and publication/deployment are controller gates and were not run here.

Next UX builder: continue UX06 next-action/correct-bus/final-walk audit. ETA's01:44 research requests a narrowly scoped ordered-existing-pickup journey join after independent review (`eta/cycle-6/RESULTS.md`, `REVIEW_REQUEST.md`); coordinate that numerical change separately and preserve raw pickup countdown versus catchable journey identity. Do not adopt the rejected whole-override replacement or conflate the remaining38 next-lap cases.

All owned command sessions ended, browsers/pages/contexts closed, no owned server or heavy lock remains. No dependencies, watcher, production DB, feedback, credentials, controller state or other-team files were modified. Combined screenshot total at handoff:130 files/5,486,537bytes (<100MiB), all earlier evidence retained.
