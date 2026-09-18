# Updated resume guidance after semantic review

Read final RESULTS.md and both correction JSONs before scoring more data. Initial/intermediate score directories are superseded. Retain zero-hop/current versus full-lap identity, explicit source ambiguity, exact cumulative physical hop distances, and the independent wire/database semantic verifier. Rider outcomes now have their own exact pickup-to-target chain checks.

For the next 25-minute role, prefer a newly declared 6000:9000 chunk over the larger original suggestion below. Copy the frozen current.mjs/canonical.mjs and arm-matched checkpoint-6000.v8 files into the next own cycle directory; preserve and check their hashes against this cycle. The sibling cycle-14 input path then remains valid. Run each copied bundle with its own arm and arguments6000 9000 sequentially under heavy.lock; it writes arm-resume6000 wire/meta plus checkpoint9000 into that new directory. Do not overwrite this reviewed slice. No full replay, extraction or new model fit is needed. Adapt output readers explicitly for resumed filenames and both-occurrence truth rules.

The original checkpoint mechanics remain below.

Use only this cycle's frozen bundles with its recorded inputs and arm-matched native checkpoints. Preserve current/canonical checkpoint-6000.v8, wire streams, metadata and bundle hashes. Both bundles include an artifact-only global reference to the kernel cache; neither changes the checkout. Current arm retains the original unrounded first-caller kernels. Canonical differs only by the previously frozen mean rounding.

After `resume-comparison.json` passes both100poll exact comparisons (5900:6000, including immutable minute-state digests), continue each arm from6000, not from a cold server:

```
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
node --max-old-space-size=512 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/current.mjs current 6000 12000
node --max-old-space-size=512 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/canonical.mjs canonical 6000 12000
```

Run sequentially under the shared heavy lock with checked script/log redirection. Outputs are arm-resume6000-wire.jsonl.gz and corresponding metadata; native checkpoint12000 is saved. Do not overwrite the original6000 outputs or rebuild a different comparator silently. Copy/adapt scripts in the next own cycle, routing output to that cycle and loading these checkpoints explicitly. Prior current production baseline is98e535b; compare relevant ETA source hashes if controller advances the checkout.

The capture0:6000covers2026-09-16 11:04:43.166Z–19:25:49.204Z, eight routes1/2/3/8/9/10/15/19. The prepared archive contains12routes and20199polls; night routes and later Red date remain unfinished. All source dates are reused evaluation. Per-bus10minute warmup is a scoring gate, not a forecast exclusion.

Outcome join uses repaired physical route positions and infers the UNIQUE pricing origin from all served(stopId,stopsAhead) rows. Do not substitute tracked belief.lead: startChain may advance its priced origin during standing/repositioning. Per-physical-position occurrences0/1 remain distinct; repeated stop IDs can have more than two total rows. Negative raw lower bounds and post-label transitions remain in raw/tail files. Current labels have causal reconstructed metadata, not original first-publication clocks.

The old cycle14 mutable state evidence is superseded by reviewer13 immutable captures; see ARTIFACT_CORRECTION.md. Kernel-aware continuation here verifies the research harness's chunking, not an additional production checkpoint fix. The canonical diagnostic's ordinary production checkpoint repeatability proof remains in reviewer13.
