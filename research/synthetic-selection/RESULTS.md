# Baseline component-state parity — September 22, 2026

The research adapter at `30996f91e4e09764ff55fb2c762bdfd67ce407e2` passed all **26 hosted fixtures** in [run 35694101810](https://github.com/grtwrn/yale-shuttle/actions/runs/35694101810). Twenty independently executed original-component/adapter sequences produced **59 matching complete snapshots per component**. Six additional envelope fixtures cover version/source refusal, initial response selection, noncausal/duplicate input rejection and a full fixed 45-minute synthetic episode. No prospective fleet/outcome recording was replayed.

The source/extraction/parity specification was committed before implementation at `e3ab99a`. Source is the unchanged deployed baseline `05a988194af3c376e5aa5da16682c29f797db2b2`, proven equivalent to the worktree's `1e8b13e` frontend tree `39e7e9738975f45dfb5c443cc99961a39e9aa4ef`. Root's separate [hosted bundle reproduction](https://github.com/grtwrn/yale-shuttle/actions/runs/35693019507) exactly matched the captured HTML and both JavaScript assets. See [VERSION.md](VERSION.md).

The extractor recorded **193 source ranges**. TransitMap SHA256 is `8e89152f7af5589c0451b343ab3b85f1210eb3013df2cad537cc8d4a5d3432be`; generated module SHA256 is `532c729922b466b49d27980e58bfdebfd3798be182902274a6abff4c8ab7b63b`. The immutable [extraction manifest](evidence-35694101810/extraction.json) and [fixture report](evidence-35694101810/fixtures.json) are retained here. Full original/adapter transcripts are in artifact **10679393263**, `synthetic-selection-parity`, **349,249 bytes**, zip SHA256 `6a5d1bb812715dc7afd72f7add35ae77a017897bae7c14fd933efc0771b45e63`.

Coverage establishes these synthetic component-state contracts:

- Complete-fleet service filtering and the actual six-shuttle planner cap; three-route comparisons preserve initial stop pairs and bus pins across polls while live selected vehicles may change.
- A roster change replans a shuttle-less snapshot; ordinary polls/wall ticks and live walking do not refresh an existing shuttle plan.
- Countdown and boardable identities remain distinct for another vehicle and a later occurrence of the same vehicle. The raw-current override remains intact.
- Heads-up marks fired state without walking; leave-now starts one walk at its actual timer instant. Short-walk arms are rejected as `at_stop_no_ping` and retain the actual origin.
- Failed transport, missing/invalid/expired ETA and a vanished selected fleet permanently disarm; recovery does not rearm. A failed response retains the fleet and differs from a successful empty response.
- Server ETA age expires between polls; normal wall ticks retain unchanged memo identities. Fractional reminder phase is preserved. The predeclared timer-before-receipt tie can permanently disarm exactly at expiry even when the tied receipt restores freshness.
- Ranking holds a changed desired order for 30 seconds of applicable recomputations. Third-route visibility survives its retention-only band, disappears beyond it, requires the entry band to reappear, and resets on destination changes.
- Profile B retains its initial direct-walk choice when a shuttle later appears. Changed armed boarding coordinates mark interpretation unresolved and cannot silently redirect the walk.
- Exact known source/bundle metadata must be available at initial receipt; future release metadata cannot supply an earlier version. Missing initial response within 30 seconds is retained, and later valid ETA cannot replace an initial missing-ETA observation. Horizon stays scheduled start plus 45 minutes.

The first generator run stopped at an AST-parentheses assertion; the selector was corrected without changing source logic. A later all-fleet fixture wrongly expected night routes to be filtered at 16:30 ET; the source's existing 90-minute grace correctly retained them. Only that fixture expectation was corrected. All 26 final fixtures passed and the hosted job confirmed tracked production source remained unchanged. No local tests, builds or replays ran.

## Limits and the next boundary

This proves exact-source component-state parity for these synthetic sequences, with the original final UI return replaced by a null boundary. It is not DOM/browser, notification delivery, real rider, arrival-error or boarding-safety validation. The adapter preserves the planner's six-route cap; it does not export internal pre-cap stop-pair candidates. An offline anchor-store entry fails closed. Each episode binds the proven frontend; later changed bundles require separate proof and parity.

The input API expects **already-verified** public receipt envelopes. At this gate, a capture-journal/body-hash decoder, causal release-metadata join, fixed 42-scenario enumerator and bounded streaming runner for all 28,224 profiles still needed separate implementation/review before prospective execution. Subsequent decoder work is recorded separately in [CAPTURE-RESULTS.md](CAPTURE-RESULTS.md), and the later complete synthetic streaming benchmark in [STREAMING-RESULTS.md](STREAMING-RESULTS.md). The original envelope fixture buffers diagnostic rows and is not itself a whole-week scale test. Timer/receipt ties and the 15-second observer cadence remain explicit limitations. Unfinished capture horizons are reported independently of simulated clock completion.

No candidate arm, model fit, error/miss scoring, production change, recording, browser or actual notification was performed. Brown September 23–29 and all other prospective outcomes remain unopened. The 32 earlier physical-encounter barriers and all encounter censoring requirements remain unchanged; nothing here validates the 643 Blue additions.
