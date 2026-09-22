# Running public fleet evidence capture

Tested source `bae23b33211c73589ede784bf32d3485124874d1` passed all19 hosted
fixtures in [run35692217733](https://github.com/grtwrn/yale-shuttle/actions/runs/35692217733).
The script SHA256 is `4f494f132da14bd369b768605190a77319ef1586e326f062289ec6f1274115b3`.
The immutable local copy and `source.json` are under
`ongoing-window-research/capture-tools/bae23b33211c73589ede784bf32d3485124874d1/`.

Recording began September22,2026 at05:50:35UTC as user unit
`shuttle-public-fleet-20260922.service`. It was verified active/running with
Nice15,CPUWeight10 andCPUQuota25%, no browser. The first response records include
health build05a988194af3, root HTML, both referenced JavaScript bundles and the
complete public fleet response. Off-hours fleet is empty and has no server_eta;
that is preserved as observed, with no manufactured ETA.

Output: `/home/gwarren/projects/yale-shuttle-watcher/ongoing-window-research/full-public-feed-2026-09-22-bae23b3/`.
`records.jsonl` is an append-only hash chain; its completed records reference
content-addressed gzip bodies. `manifest.json` is replaced atomically and
records progress, incomplete responses, skipped ticks, pending release capture
and explicit stop reasons. Individual transport success does not establish
valid ETA data, outcome finality or full scenario coverage.

End time is September30,2026 at04:30UTC; hard capture storage cap3GiB, minimum
filesystem free4GiB. The service also has an8-day runtime bound and20-second
stop timeout. It stops without deleting evidence or restarting automatically.
This is a transient user service: a reboot interrupts capture. Inspect the
actual service handle and manifest before any restart; an observation timeout
does not mean it stopped. Never reuse or overwrite the old output directory.

The existing03:45ET midnight-context export is a separate job. This timeline
does not replace raw fleet archive preservation or independent physical labels.
The synthetic all-line protocol is separately pinned in `6dfbe4f` under
`research/phase-encounters/PROSPECTIVE-SELECTION-PROTOCOL.md`, with42 static O/D
entries, all-route planning and actual one-shot reminder semantics. No candidate
or outcome replay is activated by recording these public responses.
