# Resume at poll9000

Cycle17 completes3000new polls, corrected-label scoring and connected rider analysis. Do not restart first9000polls. Read RESULTS.md/REVIEW_REQUEST.md and independent review before extension. Code is unchanged; diagnostic remains artifact-only. Remaining11,199polls cover later evening and the next reused date.

Copy cycle17`current.mjs`,`canonical.mjs`,`current-checkpoint-9000.v8`,`canonical-checkpoint-9000.v8`to a new sibling own artifact directory and assert hashes against cycle17. The sibling `../cycle-14/all-route-raw-frames.jsonl`input must resolve to the same hash. Preserve all eight PLAN input hashes. Check relevant current production source parity if controller advances HEAD.

Under one shared heavy lock, run sequentially from services/shuttle-v2:

```
node --max-old-space-size=512 NEW_DIRECTORY/current.mjs current 9000 12000
node --max-old-space-size=512 NEW_DIRECTORY/canonical.mjs canonical 9000 12000
```

Use a checked script/log redirection; outputs get `ARM-resume9000`names and checkpoint12000. Do not invoke these commands inside this completed directory or rebuild bundles. Adapt scorers to explicit new filenames and verified poll8999boundary without rescoring the prefix. Preserve both physical occurrences, all unknowns/tails/availability and future session continuity. Only reuse sessions wholly inside the next chunk unless their prior planner state is explicitly reconstructed.

No process, server, browser or lock remains. All owned sessions finished. Prior58physical zero-hop uncertainties/poll508sensitivity plus new19identical-arm keys remain provisional. No source/model/threshold change is supported by the small mixed errors. The rank difference is explained by5,043ms persistence-start delay; do not retune from one poll.
