# Causal source-discard diagnostic — pinned before implementation

Research-only branch from `41d3fa127c5b46206cb40be0d44054f8ebe6097c`. This is an observation/invariance study, not a new ETA arm. No fits, threshold changes, window scores, new dates, production/archive/watcher/schedule changes, or local replay. All meaningful fixtures and replay run on hosted GitHub. Parent review of this plan precedes interpretation of diagnostic results.

## Frozen inputs and unchanged computation

Use raw and prediction input run 35677536788 with SHA256s `3990d06ebdab596cfebdd7f03c528f7efcbb46fd3f6af68a9d64ede648e220b9` and `5bcc9927337564067af7eabc6c667ff44eeb7c3cba05619cc57cb0a3cf5b12de`. Canonical topology, waits, feature rows, labels and stored model forecasts come from canonical run 35684356219; topology SHA256 `eb753d58c4ace616e844b3a54842978c4ec46833373560e1b236d7b5d61b40bc`, wait/preparation SHA256 `2edd09127b7d41357ef6ecb6bf461f75c4f0b59c33d37ad2dd11cff24269df0d`. Existing highway reason streams may be joined from run 35688081446 solely as saved metadata; no candidates are regenerated or refitted.

Replay the existing canonical feature generator with read-only diagnostic observers around its history insertion, history reset and final source-filter stages. Preserve original input ordering, one-hour replay lead-in before September 16 ET, route canonicalization, detector/reducer, public-name track planning, ten-minute continuous warmup, 15-second freshness, 45-minute source cap, occurrence resolution and release latches. Every original generated feature row must match the pinned canonical feature row exactly. Stored forecasts and labels remain immutable and are joined only after feature parity; equality of unchanged inputs plus exact stored forecast bytes is the forecast control, not a claim to have refitted models.

The replay processes only observations with collected_at <= forecast asof. A visit is known only when stepManyWithVisits actually emits it at that poll. Do not close visits at end of file, invoke a pruning/flush pass, or load completed database visits to create sources.

## Diagnostic evidence ledger

Maintain an independent ledger of strict physical source emissions. An entry requires kind=visit, outcome stopped/passed, non-gap confirmation, finite nonnull pinnedAt/arrivedAt/departedAt, arrival <= departure <= actual emission known_at, and matching canonical route/stop occurrence. A pass with no pin, arrival or departure is an excluded evidence record, never a physical source. Preserve rejection reasons, open pinned visits without known departure, and unmatched baseline origins separately.

Retain ledger provenance after the original model history is cleared, but never feed it back into that history. Record exactly when and why the feature generator clears it: initial left boundary/first observation, >60-second observation gap, route change, or simultaneous public-name contention; preserve combinations. Retain old/new public names, provider IDs, routes and actual observed reset times. Record provider-ID and provider-to-name transitions separately, together with available detector state/track-key changes. A provider ID is a service-block identifier, not proof of a new physical vehicle; a transition alone must not be asserted to have caused a history reset. Do not recover a source across names or ambiguous identities.

At each forecast, identify the requested source occurrence using the pinned previous wait and each K in 1,2,3,5,8,10,15. Report both frozen/refreshed arms using their existing reason streams; their source-filter diagnostic is intentionally shared, not independent evidence. Cover every route as a control, with Green/Purple detail.

## Classification before the existing filter

Preserve all applicable flags and an explicitly documented mutually exclusive summary category:

1. No uniquely requested source: absent major wait, ambiguous target occurrence, or K outside single-loop support. Do not force an occurrence.
2. Current row not ready: record missing state/warm state, route mismatch, observation age/future timestamp, insufficient continuous warmup and unknown phase/index. These are direct observations; an initial left-censored state is not evidence that the bus never visited a stop.
3. Requested source exists in model history: record route, actual known_at, departure relative to current phase start, age and whether the unchanged filter keeps it. Call it **seen and expired solely by the cap** only if it matches a strict physical emission, all other existing source conditions pass, and age >45 minutes. Report simultaneous failures separately.
4. Requested model history absent but a strict physical source was previously emitted in the observed prefix: report whether it was cleared by an observed reset, rejected because its departure preceded the current warm epoch, belongs to another route/name/provider context, or lacks enough evidence for causal attribution. Never substitute it into a forecast. If multiple plausible identity contexts disagree, classify ambiguity rather than selecting one.
5. No qualifying physical source emitted/known in the observed prefix: distinguish an open pinned visit without confirmed departure, only invalid/unpinned/null visit emissions, and no observed source event. This means unknown/not emitted **within the frozen observed prefix**, not proof that the physical stop was never visited.

The original filter order remains unchanged. The diagnostic ledger can expose a provenance concern without modifying baseline features; such a row is labelled unproven/ambiguous rather than counted as a verified physical source. Unsupported-target model reasons and released/live reasons remain separate from source-discard causes.

## Controls and report

- Hosted fixtures: age exactly45 minutes versus just beyond; emission known_at after forecast; null pin/arrival/departure; unresolved/gap emissions; open visit; initial left censor; route/gap/contention resets; sequential provider reissue versus contention; name transition ambiguity; coincident causes; repeated occurrences; and zero synthetic EOF closure.
- Require exact all-route generated feature equality to pinned canonical features, exact immutable raw/prediction/topology/wait/forecast/label hashes, unchanged existing model inputs at every stored forecast join, and no additional forecast/label row.
- Three prespecified physically deleted future-prefix checks at the original forecast stream's quarter/midpoint/three-quarter timestamps. Each includes both feature rows and diagnostic records. The observer must never read a later emission, observation, final visit record, or outcome.
- Report all-route controls and all14 Green/Purple arms: source request/availability categories, strict physical source counts, age distributions, observed reset/identity flags, combinations, warmup/freshness exclusions and unknown/ambiguous attribution. Existing labelled visit IDs may provide denominators only; arrival/departure truth and error scores are not used.
- Preserve examples selected by first chronological occurrence within each classification, not by prediction accuracy. Public fleet identifiers/times are sufficient; no rider reports or identities.

The intended question is whether missing sources primarily arise from a demonstrably expired same-context physical source, observed history resets, or an absence of causally emitted valid source evidence. Results may falsify an age-cap hypothesis; they do not authorize a larger cap, relaxed continuity rule, model selection, or deployment.
