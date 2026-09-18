Live bus responses could be reused by the browser cache, resetting the receipt-based forecast clock. A continuing wait reproduced a backward step from 0:29 to 0:25. Serve `/api/buses` with `Cache-Control: no-store`; the existing server payload memoization remains in place. Fresh responses preserve normal stop/rest resets and stale-forecast expiry.

Waiting-label placement now includes the fullscreen/back buttons outside the Leaflet container, preventing those controls from covering the route and wait time. The browser check also requires elapsed time to increase and checks collisions against map controls.

Validation: backend/frontend typechecks, frontend build, 151 focused server/ETA/label tests, and recorded Red rider UI checks pass. A controlled browser replay reproduced the old backward clock; the fix advances through 25 samples without a backward step. Pink layouts pass at 320, 390, and 430 px in embedded and fullscreen maps; recorded Red checks pass at 320, 390, and 1701 px. No page errors in those checks.

This fixes stale-response jumpiness and label collisions. It does not alter model coefficients or tighten prediction intervals.
