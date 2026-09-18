# Next bounded UX10 slice after saved-place review

Saved/recent controls are implemented and tested in REPORT.md. Preserve the proposed three files and prior independently approved recovery/map changes; controller owns capture/review/publication. Do not rerun completed baseline work for new context.

Remaining source-only leads in current TransitMap:

1. Weather line around3250 is a native button overridden with role=status, lacks aria-expanded/controls, and remains in keyboard order when <=1hour means it cannot expand. Unit switch is a separate sibling and must stay separate. Reproduce with a local `/api/weather` fixture for dry/wet/no-temp/missing data and2+hours; inspect actual accessibility tree, keyboard/touch, focus on asynchronous weather replacement, blocked-storage units and390px geometry. Preserve existing no-temperature-trend/operator constraints from CLAUDE, units, timing interpretation, thresholds, all weather values and option order. No copy/statistical claim expansion.
2. Location denied/unavailable must still permit typed From. Current saved-list harness proves selecting destination works withoutGPS and focuses To, but does not certify full typed-origin recovery after denial or stop indefinite location loading. Existing gps-tier-check.mjs and navigation-search-check.mjs may provide fixtures. Bound follow-up to actual reproduced failures; do not alter geolocation tracking or ETA math casually.
3. Source-only previous UX02 leads: explicit Enter-before-geocoder-results focus, small Swap control. Evaluate relevance against time left; do not accumulate cosmetic changes just to fill a round.

UX11 remains an independent About/operator-view audit and requires actual mobile/keyboard/loading/error/empty verification. VIEW_COVERAGE.md records still-unverified whole-view issues. No ETA/shared contract action currently requested.
