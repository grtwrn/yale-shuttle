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

## Initial deployed frontend verified

[Hosted run 35693019507](https://github.com/grtwrn/yale-shuttle/actions/runs/35693019507)
succeeded at research source `70708534c62430ae5e46cad0e471b9b72b4e42e9`.
The production Docker frontend stage reproduced all three captured files exactly:
`index.html`, `assets/rider-U6Gl7ugq.js` and `assets/geo-BjWFh9tz.js`.
Their lengths and SHA256 hashes match `deployed-bundle.json`; the result is in the
run's `captured-bundle-provenance` artifact, `bundle-verification.json`.

Production source is `05a988194af3c376e5aa5da16682c29f797db2b2`, with frontend tree
`39e7e9738975f45dfb5c443cc99961a39e9aa4ef`. This establishes source equivalence
for the initial captured release. Future different bundles require their own
mapping; a health build label alone is not sufficient. It does not validate
candidate forecasts, React replay parity, physical outcomes or probabilities.

## Hybrid distribution limitation

The protected-window research changes bounds while preserving the served point
and the original 50-point distribution. The deployed frontend does consume that
distribution: `ArrivalDetails.tsx` plots pickup samples, and `ArriveBy.tsx` plots
destination samples passed through `journeyArrival.ts`. Consequently, changing
only bounds can leave the detailed forecast plot inconsistent with the new
window even if point, reminder and route-selection controls pass.

The four-arm Brown lock deliberately retains those arrays as a diagnostic
control. It is not a coherent probability export or a production-ready display.
Before any hybrid deployment, define and test a consistent representation of
both pickup and destination uncertainty. The existing pickup component has an
interval-only fallback when a distribution is absent, and the destination plot
is conditional on a distribution; this observation does not authorize changing
the pinned experiment or inventing/rescaling probabilities to fit its bounds.
