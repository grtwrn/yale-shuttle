# Live-site QA — September 10, 2026

Tested https://yale-shuttle.fly.dev/ around 9:38–9:43 AM Eastern using one Chromium process and one page on the Raspberry Pi. Viewports: 390×844 and 1280×900. Mobile viewport emulation is not a physical iPhone/Safari test.

Before first navigation, the repository's `seedTestId` helper set `shuttle-anon-id` to `00000000-0000-4000-8000-000000000000`. Observed `/api/buses`, `/api/my-reports`, and `/api/geocode` requests used that ID in `x-anon-id`; no other identity was observed. The local repository's `src/server/actives.ts` seeds this ID into `excluded_anon_ids` and excludes it from metrics. Production's private exclusion table was not independently queried.

## Findings

### Medium: keyboard users cannot open trip result details

1. Plan a trip to Union Station from Old Campus or a current location near Old Campus.
2. Use Tab to move through the overview map controls, ending at Fullscreen.
3. Press Tab again.

Actual: focus jumps directly to “Show 2 more routes,” skipping every shuttle and walking result. Live DOM inspection confirmed the result rows are plain `div` elements with no role and `tabIndex=-1`. Clicking a row opens details, but the keyboard cannot reach that action. This blocks keyboard access to boarding/alighting information and the controls inside the detail view.

Expected: each result has a named, keyboard-focusable control that opens details with Enter/Space.

Local source corroboration: `/home/gwarren/yale-shuttle/services/shuttle-v2/web/src/TransitMap.tsx:3711`, with the click handler at line 3717. Source references are from the available checkout; the live DOM is the basis for the finding.

Evidence: keyboard navigation screenshot (`keyboard-skip.png`; historical input/reference, see publication manifest).

### Low: empty search results give an impossible instruction

1. Clear the selected trip and type `zzzzqxxxnonexistent` into the destination input.
2. Wait for “Finding places…” to finish.

Actual: no matching suggestions appear, but the page says “Pick a destination from the list to see trips.” The search request completed without an HTTP error; the state persisted after waiting.

Expected: an explicit no-matches message with a prompt to try another name or address.

Evidence: empty search screenshot (`no-results.png`; historical input/reference, see publication manifest).

## Successful checks

- Initial load and live bus polling; 19 shuttles on eight routes were displayed during the session.
- Location permission denial displays an explanation; selecting a manual origin still produces trips.
- Granted geolocation using simulated coordinates near Old Campus produces current-location trips.
- Destination lookup, route comparison, opening route details, and returning to all routes.
- Future trip planning for September 10 at 5 PM displays schedule-based assumptions and future arrival times; Now restores live planning.
- Swapping origin/destination updates the trip.
- Saving a destination persists across clearing the trip and reloading.
- Map Hide all removes bus markers; enabling Red displays its three bus markers; expanding Red shows the stop list.
- Issues empty state and opening/canceling the feedback form.
- No horizontal document overflow in the checked 390px trip view.
- No uncaught JavaScript errors or HTTP responses with status 400+ were recorded.

Additional evidence: mobile trip (`mobile-trip.png`; historical input/reference, see publication manifest), future trip (`future.png`; historical input/reference, see publication manifest), [request log](network.json).

## Scope limits

This was a short functional and accessibility pass, not a measurement of real-world ETA accuracy or a load test. No physical ride, prolonged arrival observation, actual notification delivery, offline recovery, or Safari test was performed. Feedback was not submitted, and source/deployment files were not changed. Chromium was closed after testing.
