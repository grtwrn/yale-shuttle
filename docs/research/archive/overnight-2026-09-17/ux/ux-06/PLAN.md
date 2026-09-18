# UX-06 bounded slice: fullscreen map return focus

Base 8de0eed1c6a869606272824fd3dcac753ce32836; controller branch006. Prior UX05 baseline and independent review already establish CombinedTripMap Back→BODY. Preserve those experiments. This round extends the regression to the walking TripMap and published/expected pickup BerthInset, then shares close/focus handling across the three maps. No ETA, planner, bus identity, data or wire changes.

Verify Back by Enter/Space/touch, Escape from Back/zoom/toggle, close toggle, external focus ownership, map preservation, berth inert/armed state and disclosure cleanup; phone/desktop/reflow and full-shell retained plan, both arrivals, stale removal. Actual components with intercepted network and tester identity; all resources close. App build/types and selected existing map/berth/arrival tests under shared lock. Full-suite/staging/publication remain controller gates.

Remaining UX06 action/identity/final-walk audit is a separate slice. ETA01:33 is diagnosing shell journey joins; do not change shared math in this candidate.
