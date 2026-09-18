# Restart recovery patch review

Reviewed `/home/gwarren/projects/yale-shuttle-watcher/restart-recovery-2026-09-17/services/shuttle-v2/src/collector/{visitRecovery.ts,collector.ts,visitRecovery.test.ts}` and the recorded147-observation fixture. **The recovery approach is appropriate and independently justified by the reproduced truncation. One ordering fix should precede merge.** This reviewer made no application edits.

The pure helper reconstructs the detector and visit reducer from observations strictly before the current poll, checks identity/route/order, drops state across a gap above the existing60-second handoff limit, and requires the final replayed episode to match an exact still-open legacy arrival timestamp. This is much stronger than matching a stop and choosing an earlier clock. The current observation is then processed normally with the recovered pending candidate, so a real departure can be confirmed without pretending the bus remains stationary. Historical events are discarded; the integration test verifies one completed439.48-second visit and one legacy arrival, rather than duplicate inserts.

I inspected the successful focused test log: five tests pass, including exact pre-restart state/candidate reconstruction, invalid histories and identity changes, multiple true-departure restart positions, and a real restarted collector using SQLite. Full-suite results are being handled by the parent; they are not claimed complete here.

## Necessary ordering fix

`runPoll` currently reconciles `livePositions`, calls `recoverOpenVisits`, and only afterward lets `stepManyWithVisits` reconcile `states`/`visitStates`. Recovery checks `this.states.has(plan.keys.get(busId))`. When a formerly contended name becomes unique, an existing live detector may still be stored under its suffixed key. Recovery therefore treats a known physical track as absent, performs queries/restoration, and logs a recovery. Subsequent reconciliation can overwrite that restoration with the old keyed detector; the two maps need not have taken identical paths.

**Reconcile the detector and visit maps to the same plan before the recovery check**, or equivalently recognize the existing bus-ID entry before restoring anything. Add a regression for a contended→unique key transition asserting the existing detector and visit state are carried normally and recovery does not run. This makes the promise “only recover absent state” true independently of key spelling.

## Additional useful coverage

The helper correctly stops at a closed or different-stop row when scanning older duplicate arrivals. A small test should pin both accepting consecutive still-open duplicates when an older exact timestamp matches, and refusing to cross an intervening closed/different-stop record. The current closed-row test covers the newest row only. Add an explicit current-contended-name integration check if the key-transition test does not already cover the guard.

## Scope limits

This patch is conservative and does **not** universally eliminate truncated labels. Recovery requires the current fix within75 m, a complete enough30-minute/600-row prefix, unchanged identity, a resting/pinned reconstructed pass, and an exact open arrival. A restart while a shuffle is outside75 m, after an unobserved gap, following route/ID changes, or without the matching arrival remains on the existing fallback. These limits favor refusing uncertain joins; they are not reasons to widen recovery opportunistically.

The four audited examples do not support deleting all short observations. Source65237 is a proven left-truncated duration; the other three measured legitimate shorter pinned portions after off-marker waiting. This patch prevents the reproduced future-write failure within its supported conditions; it does not repair already stored records, add completeness provenance, or align the broader filter rest origin with the pinned-duration model. Keep those follow-ups explicit.

Subject to the ordering fix and required checks, I found no reason to delay this narrowly scoped data-quality repair for the uncertainty-model experiments. It preserves existing departure logic and learns no new forecasting coefficients.
