# Recover a visit across a fresh-fix restart

The September 17 Red #316 recording exposed a restart during a shuffle at
344 Winchester. The rider's stationary clock survived, but the visit reducer
started a new visit. It stored a 30.011-second stand instead of the 439.480
seconds obtained by processing the same GPS continuously. The outgoing
departure instant was unchanged. That short fragment can contaminate dwell
calibration and historical comparisons.

On a previously unseen, unambiguous track at an open recorded stop, the
collector now replays the bounded raw prefix into temporary detector and
visit reducers. It restores them only if their anchor exactly matches a
consecutive still-open arrival on disk. The historical events are discarded;
the current observation is then processed normally. This preserves an open
shuffle or departure candidate and avoids inserting another arrival.

Recovery uses the existing 30-minute/600-row history bound and two-minute
handoff gap limit. Missing, unordered, mismatched, stale, or differently
identified evidence falls back to the existing stationary seed. Current
contended names are excluded, and existing in-memory states are reconciled
before recovery. This is deliberately limited to the existing 75-metre
stop-boundary case and does not reconstruct every possible service episode.

The checked-in fixture contains 147 raw observations from the recorded
case. Tests compare complete reducer state and the resulting visit with
continuous processing, check every eligible restart around the final
departure, reject unsupported histories, and run a real collector through
the restart against SQLite. The real collector records one full visit and
one legacy arrival. All 2,724 tests and both TypeScript checks pass.

Existing historical rows are preserved. This change prevents supported
future restart fragments; it neither deletes short journeys nor changes ETA
quantiles, smoothing, or movement tracking. Repairing previously truncated
rows needs a separately audited derivation from their raw observations.
