# Separate e778 component/source qualification

Deployed e778 is qualified for the bounded research component-state adapter.
The implementation is **501e5e13fa7774fbd42f9840743edae0736068e3**;
[hosted two-version gate 35769507682](https://github.com/grtwrn/yale-shuttle/actions/runs/35769507682)
passed. Execution scope was pinned at 44fc2e5 before tests. All builds and
fixtures ran on hosted GitHub; local work retained only compact metadata.

| Check | Original 05a | Deployed e778 |
| --- | ---: | ---: |
| Component, parent-poll, version and streaming fixtures | 59/59 | 59/59 |
| Synthetic decoder/spool fixtures | 30/30 | 30/30 |
| Exact source's overview regressions | 6/6 | 8/8 |
| Original-component parity sequences | 20 | 20 |
| Original-component snapshots per implementation | 59 | 59 |
| Additional fixed walking-boundary snapshots | 3 | 3 |

Both versions compare all captured component state against the complete
original TripPlanner body with its final JSX removed, plus the actual parent
poll closure/effect. Existing fixtures retain bus/occurrence pinning, no-shuttle
refresh, invalid-feed permanent disarm, heads-up versus leave-now, ranking
timers, visibility hysteresis and input uncertainty. New fixtures reject
unknown/intermediate sources, cross-version metadata, extra/missing assets,
mismatched loaded code, and future proof knowledge. Already-bound pages keep
their source when later metadata describes the other qualified version.

## Fresh served/build proof

[Hosted proof 35769249431](https://github.com/grtwrn/yale-shuttle/actions/runs/35769249431)
at fd00e87 rebuilt the exact e778 Docker frontend stage and matched fresh
served HTML plus both JavaScript assets byte for byte. It requested only
`/healthz`, `/`, and the two fixed public asset URLs. Both health brackets
reported e7784c03b8c7. It read no fleet responses or outcomes.

[E778-SOURCE-PROOF.json](E778-SOURCE-PROOF.json) records all receipt timestamps,
byte counts, hashes and hosted artifact provenance. Verification completed
**2026-09-22T18:45:29.513721Z**. Availability is conservatively pinned at
**18:45:30Z**, the next whole UTC second, preserving the shared proof identity
clock without rounding knowledge backward. Earlier quick root verification
is not treated as a complete retroactive proof.

The complete `web` tree is `f985c086ee1d340ab37c7fc7c482b98bcde03ac6`;
`c86bcf558a276752ed35b1145bd7c7fc33f7d4cf` identifies its `web/src` subtree.
The first proof attempt rejected that mistaken tree scope; the next rejected
an incomplete staged index for newly added source files. Both failed before
accepting public bytes. Correct staging and exact tree verification passed.

## Behavior and preservation

The complete service diff from 05a to e778 contains only MakeHaven's curated
entry/aliases, the hackerspace icon, the overview walking threshold and its
tests. TransitMap, live updates, ranking, reminder exports, dependency locks
and shared frontend build inputs are unchanged. The fixed coordinate protocol
does not invoke destination search; source fixtures verify aliases and icon
without adding geocoder requests.

The threshold now accepts shuttle walking **at most half** the direct walk;
the original accepts at most two thirds. Fixtures cover exactly half, one
second above, 60%, exactly two thirds and one second above that, including
optimistic ranking and retained-third inputs. The full options are unchanged.

The predeclared component geometry uses static stop 100 → static stop 105,
with each walking leg extending 0.75 route-leg lengths. Across initial, 15 s
and 30 s snapshots, direct walking is 1295.270 s and shuttle walking is
777.162 s (60%). Both versions retain Red and Walk in full options; 05a shows
Red + Walk, e778 shows Walk. Adapter and original-component state match in
all three snapshots for each version. These are synthetic arithmetic values,
not real trip or accuracy observations.

Extraction stamps its exact source identity. The runtime requires that same
identity; registration of e778 cannot authorize it in a process loaded with
05a, or vice versa. Hosted jobs stage one exact version each; default remains
05a. The original generated 05a module was compared byte-for-byte to the
frozen 53834e9 extractor, with only the newly added identity export removed.
All 199 selected source ranges and the TransitMap hash are unchanged.

Original proof, geometry, production files and the immutable 28,224-profile
benchmark/evidence have no diff. The full benchmark was not repeated. This
qualification adds no model, estimator, window, notification or production
change. The intermediate b008 source remains unsupported.

## Limits for future execution

The result qualifies source identity and component state, not DOM/browser
behavior, physical boarding, human response, accuracy or useful window width.
No prospective bodies or Sep23–29 outcomes were read. No candidate was fitted,
activated or scored. Multi-version worker dispatch and any real capture
replay remain separate work.

Profile B retains its frozen **first ordered option** choice from SPEC.md.
That synthetic policy can choose a route hidden by the overview filter;
qualification does not silently replace it with a visible-only choice or
claim it models a real rider click. Both full ordering and visibility remain
separately observable. Release binding still uses policy 9ded9d0 at the exact
initial receipt, with unknown states shadowing older mappings, no future
proof search, and explicit continuity assumptions. Equal health brackets do
not prove that every intermediate release was observed.

Compact [evidence](evidence-35769507682/summary.json) records artifact hashes,
test counts, source/extraction identity and the fixed component example.
Hosted artifacts retain full synthetic transcripts. Original full-week
evidence remains in [STREAMING-RESULTS.md](STREAMING-RESULTS.md).
