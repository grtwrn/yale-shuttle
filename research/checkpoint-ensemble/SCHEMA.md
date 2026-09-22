# Materialized evidence, version 2

All files are ordered JSONL gzip streams written with awaited streaming/backpressure; no giant joined JSON string and no sampling or row reduction. The first hosted materialization passed original-feature/prefix assertions but failed only while joining output into a JavaScript string. No model outcomes were scored.

`features.jsonl.gz` contains every original sampled forecast key, causal state and ensemble-membership result. A supported result stores `sourceIds` keyed by exact integer offset. Each ID references one immutable record in `physical-sources.jsonl.gz`. The writer asserts unique IDs and exact equality of every original source object to its referenced record before serialization. Readers resolve these references and assert known-at/asof and exact offset membership; missing references are fatal.

`traversal-history.jsonl.gz` preserves the full contemporaneous family state for every same forecast key, including rejected/ambiguous families. This separated audit stream is not input to model fitting or label assignment. `source-resets` and `source-rejections` retain the full causal reset/rejection ledger. Nothing is recovered from an audit record into model history.

The materialization audit reports exact reproduction of the separately pinned legacy filtered replay, changes in the independent full-poll experimental features, three future-prefix parity checks, source-reference equality, and outcome-free source/mask availability by route. The experimental replay never filters raw polls by future sampled vehicle names.

Version 2 adds `occurrenceProof` to each physical-source record and complete `observed-occurrences`, `occurrence-resets` and `occurrence-rejections` streams. Proof is taken at actual emission, before future polls, from the exact previously active pin and unwrapped occurrence epoch. It is an additional training-path admission gate; unsupported pins are preserved and counted, never recovered. Each deleted-future check compares all strict source/proof records as well as forecast membership rows. No field/row or original source reference is dropped.
