# Preserve a standing forecast through server clock resets

PR184 now retains an already validated departure-phase prior for the client's continuing physical rest. Its pause display, downstream ETA and departure probability read the same retained prior. This fixes a reproduced lifecycle error; it does not establish a new Red accuracy gain or remove the PR's existing countdown regressions.

## Reproduced failure and repair

The server caches a standing context by bus, route pattern, occurrence and server visit-start timestamp. A background fit can finish during a hold. With an unchanged server timestamp, the server correctly keeps the old context. If the server clock then restarts while the client's physical rest continues, that cache key changes and the server can supply the newer fit instead.

The client correctly rejects that fit: it was produced after the client's retained visit origin. Previously, it had no retained prior to use, so all consumers fell back to the pooled duration table. In the synthetic reproduction through the actual server model and rider client, an expected total of 614.75 seconds became 309.37 seconds. At 180 seconds elapsed, remaining time became 261.27 seconds instead of 435.56 seconds from the still-valid original law. These are forecast-consistency measurements, not observed bus outcomes or a reproduction of the operator's actual morning trip.

The prior now stays in the caller's `AnchorStore` alongside the belief. A different server start or a replacement fit cannot rewrite that rest's law. The filter uses it over the previous-to-current observation interval; the downstream price and both pause-display callers use it at the current time. The existing duration/phase mixture, fitted weights and causal guards are unchanged.

Retention still requires a valid incoming context for the same canonical occurrence and route pattern. An omitted context may signal an ambiguous fleet identity or feature withdrawal, so omission continues to revoke reuse. Expiry, a confirmed departure since the client origin, a new physical rest, a stale belief, or changed topology also invalidate it. An earlier discovered client origin must still pass the original history and fit availability guards. Alternative latent stop hypotheses retain their own laws; this change does not force them onto the displayed stop.

The server-to-client regression includes a fresh GPS shuffle and compares the entire belief vector, ETA array and pause quantiles against a control that kept receiving the original prior. Six additional client cases cover withdrawal, consumed departure, expiry, changed pattern, departure from the rest radius and a stale restart. No existing accuracy tolerance was relaxed.

All 2,339 tests across 99 files pass, along with backend/frontend typechecks and the frontend build. Local test discovery excludes `store/**`, which contains private archived test sources; clean CI uses the normal repository suite.

## What the stored data establishes

The original zero-activation review was caused by missing production calibration fields in its replay, as isolated in [the earlier review response](pr184-rider-review.md). The corrected full-day candidate audits record 401,328 successful calls on September4 and 257,699 on September8, including 171,800 and 120,245 Winchester-occurrence calls. Neither day has a clock-guard rejection. These count function calls, including latent hypotheses, not independent physical holds. The bounded audit samples do not establish all-visit phase-slot invariance.

The new before/after September4 replay retains all 21,718 Red fixes, the same frozen phase fit and calibration cutoff, original runtime history, and separately reconstructed scoring labels. Both executions verified all 283 recorded source/input hashes before and after running. Every recorded forecast is byte-identical after decompression:

| Output | Records | Before versus repaired |
|---|---:|---|
| ETA | 56,746 | identical |
| Labelled standing display | 1,482 | identical |
| All issued standing displays | 2,616 | identical |

All three outputs also match the previously archived phase replay on `e332cba`. The lifecycle repair therefore preserves that cohort's gains **and its known regressions**. A fixed-fit replay cannot demonstrate the benefit of preserving a prior across a fit refresh.

## Separate training-clock experiment

The same phase algorithm was also refitted using the previously frozen reconstructed Red training visits, with non-Red training rows unchanged. This repaired duration clocks, censoring and availability representation together; runtime history stayed unchanged. Fits and prediction files were frozen before scoring. The refits failed the component gate and were not adopted:

| Winchester component MAE | September4 original → refit | September8 original → refit |
|---|---:|---:|
| First total | 119.22 → 148.11 s | 62.75 → 128.15 s |
| Remaining wait | 104.19 → 127.89 s | 62.92 → 125.62 s |

Both error tails also worsened. September4 and September8 remain previously examined development/regression dates; this experiment did not evaluate September9 or establish a new holdout result. It is evidence against adopting these particular refits, not a reason to treat known label errors as correct.

## Evidence and reproduction

Compact checked-in results are in [the data report](data/red-standing-clock-lifecycle-2026-09-09.json). The complete private local package is under ignored `services/shuttle-v2/store/red-clock-lifecycle-20260909/`: server/client reproductions, the 283-file replay manifest and execution receipts, all replay outputs and parity checks, clock audits, and the rejected training refits with their freeze manifests. `archive-manifest.json` hashes the preserved files. Recorded paths in those manifests identify original immutable inputs; reproduction requires them or verified copies and a fresh output directory.

From `services/shuttle-v2`, the checked-in regression is runnable with:

```sh
npx vitest run web/src/eta/standingForecast.lifecycle.test.ts web/src/eta/standingForecast.client.test.ts
```

The replay manifest SHA256 is `d69c15120d4b385a068e3046187c0d73ce49bb716390d99020ec27318d2d77d0`. The rejected clean-refit manifest SHA256 is `fa344ae821dfc5dbb36613f5df5305a0a93a6033f74857a0c1c0fd49b94dce04`.

PR184 remains draft. This change does not authorize deployment or establish that the full accuracy proposal is ready to ship.
