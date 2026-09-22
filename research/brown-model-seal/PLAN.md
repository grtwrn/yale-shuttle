# Seal the unchanged frozen Brown K8 path pool

September 22, 2026. Research only. This implements artifact availability for the
four-arm lock at `a1ee9cc377cb6ad6ab3235512cc89231ca68c2de`; it does not launch the
prospective replay, inspect prospective observations, attach outcomes or change
production. All fitting, tests and source-data processing run on GitHub runners.

Build only frozen K8, shared by the original and directed Brown phase variants.
Use canonical run35684356219, raw run35677536788, and the already completed
physical/source/path/fit parity evidence in run35691411464. Preserve the exact
existing canonical fit, cutoff September16 00:00ET, 90-minute path cap, fixed
waits, 120-minute circular weighting, weekday/weekend split, effective paths>=12,
three material dates with>=5% weight, and empirical q10/q90. No wait reselection,
new training data, clock change, path modification or parameter search.

Export every Brown K8 source/wait/target path pool, including empty target cells.
Preserve original list order, IDs and float values. Retain source/target physical
identities and every admitted intermediate visit used in each original path;
all knowledge timestamps and raw quality/bracketing fixes must precede cutoff.
Hash and export the exact causal raw/visit prefixes, topology, fixed parameters,
original fitting source and parity evidence. Whole-file input hashes identify
the older development artifacts independently of exported causal prefixes.

Required hosted gates before sealing:

1. Rebuild the original frozen model using the unchanged canonical fitter.
   Its Brown K8 physical paths must exactly match both saved original and
   directed paths. All saved frozen-K8 fit queries must exactly reproduce both
   numerical results, including unsupported queries.
2. Reload the sealed pools without constructing new paths. Execute the exact
   original `Models.fit`, `clock`, `weekend` and `q` AST nodes with their original
   timezone/imports, not a rewritten fit. Require exact results against the
   original model and saved controls. Export the original source and helper
   hashes. Missing/corrupt hashes, foreign cells, invalid clocks and nonfinite
   values fail loading rather than activating a partial model.
3. Refit from physically removed future raw/visit suffixes and require identical
   Brown K8 pools and query results. Keep source and training availability strict
   at cutoff; fixtures exercise unsupported pools, weekday/weekend separation,
   source tampering and serialization precision.

Seal only after these gates. `builtAt` is the actual UTC sealing time generated
by the hosted process, never an input or historical deadline. Fixed validity is
September23 00:00ET through September30 00:30ET, exclusive at the upper endpoint.
Manifest includes protocol, topology, source, parameter, prefix and pool hashes,
all parity references, and the creating commit/run. Hash the final manifest to
identify the artifact. Adapter eligibility additionally requires builtAt<=ETA.at;
a late build cannot repair earlier fallback. Missing/invalid/expired artifacts
remain exact served fallback. This export is a fit pool plus unchanged fit code,
not a coherent new 50-quantile distribution or evidence of rider safety.

Rolling K5 exports and daily raw/public alignment are separate follow-up work.
No forecasts, input bodies or performance outcomes from September23–29 are read
by this builder. Development fit-query clocks only check numerical equivalence;
their labels, accuracy and actions are never loaded.
