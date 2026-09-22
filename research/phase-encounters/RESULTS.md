# Phase-independent physical encounters: frozen diagnostic findings

The diagnostic preserves every previously identified earlier-pickup barrier. A route-phase repair can change its interpretation of a marker without deleting the raw physical encounter. This establishes causal bookkeeping and physical ambiguity, not boarding truth, arrival accuracy, or safety of promoting the repaired labels.

## Provenance and checks

- Spec/schema frozen before implementation in `a3048b5`; implementation `13b15ceb1b63f72b13697221e5913a13f84ab466`.
- Hosted [run35690094053](https://github.com/grtwrn/yale-shuttle/actions/runs/35690094053) succeeded, September22,2026. No tests, reconstruction, or model evaluation ran on the Pi.
- [Artifact10677389218](https://github.com/grtwrn/yale-shuttle/actions/runs/35690094053/artifacts/10677389218), `phase-independent-encounters`, zip SHA256 `daa850236d2729bb3bfb36637c981b0248ad7833f0e5c591d1af515a9b8a9409`.
- Frozen inputs: raw35677536788; canonical35684356219; guarded-phase35687909547/c80ab5f; physical-difference35688487783. Same September3–20 observations, fixed75/125m marker thresholds,60s continuity gap and15s descriptive plateau threshold. Original22m/s quality and every original label retained.
-13 encounter fixtures and18 original phase/recovery fixtures passed. Both reconstructed visit streams matched their frozen comparators:51,581 baseline and51,017 guarded visits.
- All1,487,970 observations across153,936 polls and14 observed routes replayed. No duplicate observations. Production files and frozen inputs passed before/after checks.
- Three independent future-deletion replays passed, including physical IDs, per-episode versions, knownAt, continuity breaks and both phase-annotation streams: midpoint1789262772829; September16 04:00Z; September19 04:00Z. No EOF closure was manufactured.
- Committed companion evidence files retain the exact hosted replay/audit summaries and the two earlier physical encounters. Full updates and all forecast rows remain in the hosted artifact.

## Physical ledger and separate phase interpretations

There are130,331 independent marker episodes and2,022,476 physical updates. The baseline and guarded ledgers matched byte-for-byte, with physical-stream SHA256 `f6e4e01c279eaf74f5ec5c4176adc052538152c00c91baa255c23c746f3fabc8`. Each marker retained its own causal identity. Contemporaneous marker lists were recorded on individual updates; no transitive marker grouping occurred.

The4,044,952 separate phase annotations include40,791 differing pairs. Counts per arm:

| Association | Baseline | Guarded |
|---|---:|---:|
| One occurrence supported by phase |867,026|864,952|
| Another phase/leg |149,036|151,110|
| Marker absent from assigned route |1,005,808|1,005,808|
| Phase unavailable at update |606|606|

These are update counts, not independent trips or examples of service. Enumerating all physical public markers deliberately includes markers outside the bus's assigned route. Direction/occurrence interpretations cannot erase a possible physical pickup.

Final descriptive evidence:61,099 episodes contain an observed exact-coordinate plateau inside75m lasting at least15s;69,225 have coordinate motion without that plateau;7 remain uncertain. These labels do not establish whether doors opened or a rider could board. There are51 one-fix episodes and620 episodes in contended-name segments.

The418 continuity-break records affect614 marker episodes:555 gap censors,51 provider-change censors and8 contention-change censors. There were no route-change censors in this frozen input. Of614 censored episodes,23 obtain a later same-provider absence witness and591 remain unwitnessed.129,713 episodes have a spatial exit and4 remain open at EOF. Unwitnessed persistence is deliberately conservative; a different provider cannot terminate it.

## Earlier pickups and fixed forecast rows

All38,047 forecasts retain their original asof and baseline/proposed labels. All23,867 proposed visits have exactly one matching observed-interval physical encounter;14,180 rows have no proposed label. A unique encounter association does not validate the label.

There are10,140 forecast rows with at least one physical barrier:7,008 previously accepted rows,262 newly proposed rows and2,870 rows with no proposed label. Among proposed labels,7,270 remain physically unresolved and16,597 have no earlier encounter identified. The latter is a diagnostic absence of evidence under this fixed ledger, not a validated or scored cohort.

Reason counts overlap:9,568 rows have unresolved censored presence;571 have an encounter open at asof;359 have a distinct encounter between asof and the proposed arrival. The prominence of old unwitnessed censors is a limitation to expose, not permission to add an expiration rule after seeing results.

For Blue Night's905 additions:

| Diagnostic state | Forecast rows |
|---|---:|
| Previously identified earlier physical encounter retained |32|
| Additional unresolved rows, solely censored presence without exit witness |230|
| No earlier encounter identified by the fixed rules |643|

Of the32 retained rows,31 also have a censored-presence barrier. None of the32 is accepted as a clean addition. Among the631 originally accepted Blue rows,93 now have a physical sensitivity barrier:86 censor-only,4 censor plus open-at-asof,3 open-at-asof only. This diagnostic is applied symmetrically to original and proposed labels rather than treating the original labels as unquestioned physical truth.

The32 rows refer to two independent Elm/York(marker53) encounters:

- **#38/provider66519:** one forecast row; entry September18 03:45:19.714Z, last within125m03:45:44.590Z, observed exit03:45:49.668Z. Four fixes within75m, minimum48.289m, no repeated fix inside75m. The4.974s exact-coordinate repeat is95.133m away, in the outer band. This remains a moving possible pickup. The earlier report's three near fixes counted only the original visit window; this marker episode begins one poll before that anchor and includes a fourth. The original earlier pickup remains the evaluation barrier.
- **#45/provider66597:**31 forecast rows; entry September20 02:43:39.085Z, last within125m02:45:19.057Z, exit02:45:24.124Z. Sixteen fixes within75m and a60.007s exact-coordinate plateau at53.56m; plateau evidence first becomes known at02:43:59.051Z. This remains a stationary possible pickup. Geometry does not disprove boarding.

## All physical reconstruction differences

Every suppressed Blue arrival uniquely matches an independent physical episode. The plateau threshold is descriptive and differs from a service/outcome label; a row without such a plateau remains a possible pickup.

| Suppressed marker/outcome | Visits | With>=15s near plateau | Moving without that plateau |
|---|---:|---:|---:|
| Elm/York53, stopped |51|45|6|
| Elm/York53, passed |41|7|34|
| LEPH72, stopped |47|36|11|
| LEPH72, passed |95|0|95|
| **Total** |**234**|**88**|**146**|

Thus the98 suppressed stopped visits comprise81 plateau-supported and17 moving episodes; the136 suppressed passed visits comprise7 plateau-supported and129 moving episodes. None disappears from physical evidence because its phase anchor is suppressed.

All63 paired Blue timing/outcome changes associate both old and new arrivals with the **same** physical episode. Baseline outcomes:37 stopped and26 passed; guarded:44 stopped and19 passed.43 episodes have a>=15s near plateau and20 do not. The repair can alter timing/outcome within one encounter; the encounter ledger supplies no new precise service arrival.

All3 paired Purple changes also retain the same physical episode between arms:2 with descriptive stationary support and1 moving pass. Green's1 new passed visit has one unique moving encounter. Every other frozen physical difference, including unarrived anchor bookkeeping, remains in `physical-difference-encounters.jsonl.gz`; no post hoc stop/date removal occurred. Red's reconstruction stays unchanged; its raw encounter ledger and conservative barrier sensitivity are still audited.

## Limits and disposition

The completed experiment establishes that physical encounters and causal evidence can survive a directed-phase reconstruction change unchanged. It establishes neither boarding availability nor that643 Blue additions are safe labels. Old censored encounters can conservatively persist across many later forecasts; the result reports this rather than inventing a clearing event. Fixed-coordinate plateaus may reflect feed quantization, queues or traffic lights; moving passes can still be boardable. Geometry cannot resolve those service questions.

No K models were fitted, no arrival-error scores computed, no new dates inspected, no labels promoted and no production changes deployed. The original earlier pickups remain evaluation barriers pending independent service evidence or an independently specified, reviewed continuity interpretation.
