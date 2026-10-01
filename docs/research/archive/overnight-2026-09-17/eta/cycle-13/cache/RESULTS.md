# First-caller kernel caching explains the checkpoint mismatch

**Research only. No application patch is proposed or applied.** Current-code
baseline is PR291 (`8aa67bd7f3883598f9458d825d97a52cbc004e0f`) with the same
frozen historical calibration payload and actual recorded inputs in both arms.
This is not a replay of today's live production payload or a fresh holdout.

The unresolved cycle4 fresh-process discrepancy has a concrete mechanism:
`moveKernel` rounds the moving-speed mean to tenths for its cache key, but
computes the distribution with the first unrounded mean in that bucket.
Subsequent callers get that first caller's kernel. Another vehicle, a previous
poll or a pre-restart process can therefore change the answer for identical
current inputs and checkpoint state.

A direct fresh-process example uses1.951and2.049cells, both keyed20. Calling
1.951 first creates a10-element array; calling2.049 first creates11elements.
The maximum difference in their shared probability bins is0.029434803.
Within either process the second caller gets exactly the first array. These
are unit-level mathematical diagnostics, not measured rider errors.

`PLAN.json` freezes one artifact-only diagnostic: round the clamped mean to
the same tenth used by the cache key before constructing the kernel. No other
source replacement, parameter fit or threshold selection was tried. Bundles
are built from the current checkout; `build-provenance.json` records the exact
one-line replacement, count1 and both bundle hashes. Application source is
unchanged.

## Matched restart experiment

Each arm processes the same2,178continuous historical polls, including the
same78-poll window surrounding source58224. A checkpoint is serialized just
before the window. Each arm first restores in the same warm process, then a
separate fresh Node process loads that arm's checkpoint and receives precisely
the same78raw input frames. All three buses are restored. This does not use
cycle4's old forecast outputs as today's comparator.

| Same-arm warm versus fresh process | Current code | Rounded-mean diagnostic |
|---|---:|---:|
| Same-process complete-wire matches | 78 / 78 | 78 / 78 |
| Fresh-process complete-wire matches | 0 / 78 | 78 / 78 |
| Fresh-process complete-belief matches | 0 / 78 | 78 / 78 |
| Paired arrival rows | 10,592 | 10,592 |
| Changed arrival rows | 1,817 | 0 |
| Changed50-quantile vectors | 7,044 | 0 |
| Largest median change | 21sec | 0 |
| Largest upper-bound change | 3,768sec | 0 |
| Largest quantile change | 4,153sec | 0 |
| Changed served-position frames | 0 | 0 |
| Availability / occurrence losses | 0 | 0 |

First and second occurrences are scored separately:6,786first rows and
3,806second rows. Current-code restart changes1,332and485respectively;
maximum median differences are17and21seconds. The diagnostic is exactly equal
in both occurrences, all bands, all quantiles and saved belief fields.
Every posterior remains normalized. All bands/quantiles are ordered, but
**eight negative lower bounds already occur identically in all four runs**.
They remain in `retained-negative-bounds.json`; they were not clamped, excluded
or characterized as fixed by this experiment.

## Why a small kernel difference creates a large tail change

At1789567542315, #308approaching stop115 has the same lead position and a5second
median in both current-code runs. Its upper bound changes8→3,776seconds.
`tail_probe.mts` reads the saved posterior without advancing it: the lead
cluster's mass changes0.807607→0.786230, crossing the existing0.8threshold for
including the full mixture of possible positions in the interval. The
canonical arm has mass0.797316and high3,759seconds. Alternative positions can
put the stop a lap away, so a small posterior shift can greatly widen the tail.
This is a measured deterministic mechanism, not permission to drop a valid
alternative or raise the threshold. The threshold and route-forward filter
were not changed.

The diagnostic also changes the continuously warm baseline:1,373rows and
4,834quantile vectors differ, with median differences up to21seconds and
upper-bound differences up to3,751seconds. Position labels and availability
remain equal in this one window; the actual posteriors do not. **Restart
repeatability is established here; better rider ETAs are not.** No connected
outcome accuracy, interval misses, route ranking, class-arrival decision or
all-route behavior was evaluated for this tracking change. It is not ready
to ship merely because the one-line repair looks straightforward.

## Executed checks and retained failures

From `services/shuttle-v2`:

```sh
flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-13/cache/run.sh
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-13/cache/score.py
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-13/cache/verify.py
./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-13/cache/tail_probe.mts
```

Final invocations all exit0. `run.sh` sequentially builds two isolated Node
bundles and runs eight bounded Node invocations under one shared lock. No
fit/workers/browser/server or Vite build is involved. Its session60085ended
and the lock was released. `verify.py` independently joins by physical
bus/stop/hops, checks exact saved inputs, every band's ordering, every quantile
vector and normalized posterior, both bundle/input hashes, all four outputs,
HEAD and clean checkout. All output is confined to this directory.

Two verifier failures are retained. The first demanded nonnegative low bounds
and exposed the eight pre-existing rows; final checks explicitly preserve
their exact identities/values and still require ordered bands. The second
assumed identical row order even though wire rows can reorder with ETA changes;
final checks require identical identity sets and join those identities.
Initial sources/logs remain. Supplemental scoring originally assumed a
[rowIndex,vector] distribution shape, then only zipped same-order rows. Final
scoring asserts50-value vectors and joins every row by bus/stop/occurrence;
old JSON and a correction note remain. Replay outputs never changed.

No app tests/typechecks/fullsuite/staging/Docker/CI/deployment were run or
claimed. This is not an independent reviewer approval. No coefficient,
measurement exclusion, ETA cap, forward-progress change or historical record
was introduced.

## Next bounded task

Independently review the cache cause and isolated repeatability experiment.
Then ask the controller to scope the tracking work; do not silently turn this
artifact into an application patch. Start from these saved outputs and fixed
one-line diagnostic, avoiding another unrestricted cache/parameter search.
Replay both arms in separate processes on the complete already-collected Red
input prefix and available all-route recordings, with the same chronological
calibration and all connected outcomes. Check both occurrences, tails,
availability, route-forward behavior, stability and prior legitimate
regressions, especially the0.8mixture-boundary case above. Test fresh-process
restart and bus-order invariance across multiple routes. Only a supported
coherent proposal proceeds to substantive regression tests, normal app gates
and fresh independent review. The eight preserved negative lower bounds are
a separate transport/display audit, not a reason to broaden this repair.
