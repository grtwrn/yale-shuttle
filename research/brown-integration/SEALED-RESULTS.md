# Actual sealed K5/K8 integration follow-up

[Hosted run 35734571278](https://github.com/grtwrn/yale-shuttle/actions/runs/35734571278)
passed at `bcfc44dbd0fffd32281cc735c068767d1b6dfad1`, completing September 22,
2026 at 13:38:12 UTC. The [specification](SEALED-PLAN.md) was pinned first in
`f2f7767`. This appends evidence to the unchanged [earlier report](RESULTS.md):
K5 is now sealed and integrated, whereas that earlier run used K5 fixtures.

## Scope and passed checks

Both actual artifacts were loaded through the immutable runtime from K5 seal
code `76cab36799d6fd43a8ae33c235eb299b0028040b` (runtime SHA256
`9e5ca3bb06140305a005c14f3ccfd634e866f6808c1b356f4b0bf7d640697785`).
The loader verified 22 sealed K8 files and 27 sealed K5 files, including exact
pool, source, parameter, topology and training-prefix hashes. It retained the
real manifests and timestamps; fixture-artifact permission was not enabled.

| Model | Actual builtAt | Training cutoff | Validity in ET |
| --- | --- | --- | --- |
| Frozen K8 | 1790057940242 | September 16 00:00 | September 23 00:00 to September 30 00:30, exclusive |
| Rolling K5 | 1790059735660 | September 22 00:00 | September 23 00:00 to September 24 00:00, exclusive |

K8 artifact ID is
`d8648c2a87c00a113268e5da49ef6a8fa46c62081f740ac9bf8152fb7f648c76`;
K5 artifact ID is
`97ff8586a3760e4a3696689510008f9a972b94b989cf793b52bcd4ad457fd54f`.
The latter does not provide a September 24 model.

The same three preselected development fixtures were translated by whole days
into the September 23 validity interval. Relative source/confirmation clocks,
occurrences, phases and baseline wire cells were preserved; synthetic prefix
digests bound the original fixture and translation. These are explicitly
fabricated clocks and complete responses, not observed future GPS or captures.

- The original Python models answered 18 distinct K8 and 18 distinct K5 queries,
  all supported, from 240 row references. Missing group rows still participated
  in whole-target support. No training pools, durations or fitting rules changed.
- All 24 real-manifest boundary checks passed: before/at build, before/at
  validity, final valid millisecond and exact expiry across four arms. Both real
  models are built before validity, so a separate declared fixture isolated a
  hypothetical later build boundary. Receipt time never granted availability
  denied by the server forecast clock. A previously issued, still-fresh forecast
  retains its original server clock; this is not reuse for a new post-expiry
  forecast.
- Missing, duplicate or incorrectly bound query results failed closed. Explicit
  nulls were separately tested as unsupported fallback, without substituting
  them for missing computations. Model, source, pool, raw/knownAt prefix,
  request and runtime bindings were checked.
- All 24 case/profile/arm sessions matched the complete original frontend
  component and matched again in reversed execution order. The overlays changed
  344 synthetic arm/row outputs, counting repeated frames and both profiles;
  these are not independent visits. Every non-low/high cell and original
  distribution remained unchanged. Invalid/missing/unsupported/expired responses
  retained exact baseline component states. Same-array server attachment and
  the frontend's 45-second ETA expiry also passed.
- All five new tests, six prior integration tests and 26 unchanged original
  frontend adapter tests passed. Original causal response controls passed again.
  Both production source trees remained unchanged.

The prior run's development record stream, development and synthetic summaries,
integration summary and full compressed integration transcripts are byte-for-byte
identical. Their current SHA256s are, respectively,
`3e607ebf8550a538d036eefc945db00e5be9c9cdfa36290b6d99198b4e9e3c61`,
`906413e48658ef716795eaffc9e4f5534749065ec7dc09cd460b8528f17dc3ab`,
`f406c195d40572eedbe8cc8031d9c736b7abd947c52398b97b70633729263e36`,
`717afa3591fbc0d863cb4fbbeaf275670b5b587f5ea4b2fa132a5dd0f6c17156`, and
`50fd08c33908b95495d1d059481c7d0b46b27f65a8fcdd80903fb6f289c67b8e`.

## Limits remain

The K5 closing-provider exception is confined to the documented training-path
clock: source departure through target arrival retained one provider across
504 observations, while that target visit closed after a later provider
reissue. This follow-up neither alters the quality rule nor asserts continuity
through a subsequent boarding departure.

No prospective capture bodies, physical outcomes or performance scores were
read. No local tests/replays or production changes ran. The tests establish
real sealed-model integration on synthetic inputs, not complete-capture
readiness, actual Brown support, a preferred K, calibrated accuracy or safer
boarding. Later daily K5 models must still be built and validated individually.
The unchanged distribution dots still make the changed envelope a diagnostic
hybrid rather than a coherent probability export.

Artifact `brown-response-selection-integration` contains the new evidence under
`research/brown-integration/results/sealed/`: exact manifests, synthetic cases,
request/result bytes and their hash inventory, loader/boundary summaries and
full component transcripts. The prior evidence remains in its original result
directories.
