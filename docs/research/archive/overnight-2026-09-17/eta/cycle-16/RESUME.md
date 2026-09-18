# Resume after independent label review

No new forecasts ran in cycle16. Cycle15 owns the frozen `current.mjs`, `canonical.mjs`, and arm-matched `*-checkpoint-6000.v8` files. Their native global kernel-cache states preserve chronological first-caller behavior. Original input/export/calibration and native checkpoints must remain unchanged.

Start with cycle16/RESULTS.md and REVIEW_REQUEST.md. Its labels supersede the proved cycle15 lagged-rest identities; older artifacts remain. Independent review is still required. Keep the remaining57/58zero-hop identity uncertainties and8,927legacy same-source/2,322lagged-chain unknown minute rows visible; aggregate scores are not blanket identity validation.

After acceptance, create a new sibling cycle directory. Copy the four frozen files there and assert SHA256 equality to the originals before starting. Keep this directory at the same depth as cycle15 so frozen bundles' `../cycle-14/all-route-raw-frames.jsonl` input remains valid. Do not rebuild the comparator or invoke the commands in the original cycle15 output directory.

Under ONE shared lock, run sequentially from services/shuttle-v2 with logs routed to the new directory:

```
node --max-old-space-size=512 NEW_DIRECTORY/current.mjs current 6000 9000
node --max-old-space-size=512 NEW_DIRECTORY/canonical.mjs canonical 6000 9000
```

Use `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash CHECKED_SCRIPT`. Each bundle writes `ARM-resume6000-wire.jsonl.gz`, matching metadata, and `ARM-checkpoint-9000.v8`. No prefix replay is needed. A score adapter can refer to these new outputs via explicit input paths; never write over old wire streams or checkpoints.

Reuse corrected scoring and independent alignment/semantic verifiers with own output paths, adding an explicit snapshot provenance check if HEAD changes. Preserve full fleet order/global cache, reused chronology, warmup, both physical occurrences, source ambiguity, all availability/tails/stability, connected rider outcomes and older legitimate regressions. A no-gain result can complete this research without an app patch. Night routes/later date remain outstanding beyond this chunk.
