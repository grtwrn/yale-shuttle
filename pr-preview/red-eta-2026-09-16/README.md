# Arrival details preview

Recorded Red feed from September 16, 2026. These are local-build screenshots, not a production deployment. Map tiles and the external tracker were omitted in the browser fixture.

[Trip card](card.png) · [Tap details](details.png) · [320-pixel phone](details-small.png)

The native dialog passes keyboard opening, Escape/focus restoration, close-button and backdrop dismissal, and narrow-screen overflow checks. It also opens from the expanded trip. See [browser results](browser-results.json).

[Measurement report](../../docs/red-eta-2026-09-16.md) · [Input hashes](inputs.json) · [Band comparison](band-compare.json) · [Watcher comparison](watcher-compare.json) · [Covariate summary](lap-spacing.json) · [Detailed covariate data and held-out predictions](lap-spacing-detail.json.gz)

The main estimate remains visible beside its likely window. The disclosure explains the 80% target and shows the next arrival, estimated gap, stops away, and any observed hold. No spacing model is promoted.

[Paired rider outcomes](rider-comparison.json) · [Validation](validation.json). Typechecks, frontend build, phone checks, and 2,605 tests pass across the full run plus targeted reruns. Rider outcomes and pin selections are unchanged; cold-start interval coverage remains below target. The change is not deployed.
