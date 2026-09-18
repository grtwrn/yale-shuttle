# UX-05 bounded minimap audit

Builder start2026-09-18 00:44 ET;25-minute role deadline01:09 ET. Clean HEAD/base6220b860a69f5567557926f41de59ed1af72d2f8, branchovernight/ux-20260917-005. Preserve HEAD/index; no controller/publication changes.

Actual CombinedTripMap bundled with a test-only export and map reference, synthetic props and all network intercepted. Existing seedTestId, context/browser finally cleanup, screenshots only in this directory. Shared heavy.lock covers each browser/build run. No watcher or server/staging process.

Cases: same-route catchable/just-passed buses; co-located Red/Blue Day/Brown; compact waits with full route/bus attribution; long pickup/arrival strings;360/390/430/1280/640px reflow; pan to viewport edge; keyboard marker focus, fullscreen/Back/Escape; missing times/empty options. Source leads: generic Marker accessible names, wait visible route without bus number, Blue/Brown shared initial tags. Browser reproduction required before app edits. Existing ETA math, both arrivals, route positions, historical total/elapsed distinction and wait format remain unchanged.

No numerical shared semantics or ETA request. ETA00:40 occurrence-pooling/cache diagnosis is separate ETA-owned work. Prior UX01–04 are deployed per controller; do not restart those experiments.
