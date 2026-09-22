# Observation source audit

Source pinned by the diagnostic workflow checkout, descending from canonical study3f7b5e9. These are statements about the source and stored contract, not proof every historical deployment used identical code.

- `services/shuttle-v2/src/collector/collector.ts:73`: nominal poll interval5000ms.
- `collector.ts:783`: `runPoll` rejects an overlapping poll and logs the skip; no deliberate concurrent collector fetch in this process.
- `collector.ts:806`: awaits upstream buses before assigning the observation timestamp.
- `collector.ts:833`: timestamp is `max(Date.now(), lastObservationStampMs+1)`, ensuring monotonicity within the collector instance. Fetch completion, not a device/GPS acquisition time. Startup/restarts and upstream repeated positions are not corrected by this rule.
- `collector.ts:854`: raw observations are persisted before detector/network stepping. Map matching and client rendering therefore cannot explain interpolation in these stored rows.
- `collector.ts:908`: sanitizer copies `lat/lon`, bus name/provider ID and route from a single upstream row. It deduplicates provider IDs within a payload; it does not deduplicate bus names. Concurrent distinct provider IDs with the same bus name can survive into raw history and must remain flagged.
- `collector.ts:938`: every valid row in a poll receives the same local `now`. `lastUpdate` is unused here.
- `collector.ts:1804`: persistence copies observation fields directly.
- `services/shuttle-v2/src/collector/upstream.ts:15`: bus schema accepts optional `lastUpdate`.
- `upstream.ts:206`: `buses()` validates `/routes_buses.php` rows and returns coordinates; no coordinate interpolation occurs in this function. Unknown fields are stripped by the schema.
- `services/shuttle-v2/src/db/schema.ts:27`: raw archive stores provider ID, bus name, route, lat/lon, heading, last stop and `collected_at`; no upstream measurement timestamp, full envelope, fetch-start time or response latency.

The collector source establishes why collection interval is not necessarily observation interval. It does not establish whether upstream coordinates are direct sensor fixes, cached fixes, interpolated positions, or a mixture. Frozen raw data can reveal repeated coordinates and burst patterns but cannot recover discarded measurement times. A prospective timestamp-preserving collection proposal would be separate work; this diagnostic changes neither collection nor production.
