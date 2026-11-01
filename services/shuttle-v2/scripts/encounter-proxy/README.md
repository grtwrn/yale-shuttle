# Independent encounter proxy (fixture qualification only)

This standalone tool binds a forecast opportunity to one independently tracked curb encounter. Passing a curb without a confirmed proxy ends that encounter even when the same stop appears on the opposite side or on a later lap. Those later visits cannot rescue the earlier forecast.

The outcome engine accepts raw vehicle identity, GPS, named curb, stationary flag and explicit observation/receipt/consumer clocks. Model forecasts, route-position beliefs, ETA rows, travel tables, provider last-stop, heading and speed cannot select an outcome. All reachable raw path branches remain represented; unresolved earlier service regions prevent binding.

This is a GPS curb proxy, not proof of door opening or passenger service. Protocol R3 is pinned in `protocol.v3.json`; the earlier unexecuted revisions remain for review. The fixed 40m/s reachability bound is an engineering assumption. The Pink catalog in the tests is explicitly conditional and has not qualified historical counterpass service semantics.

## Run the finite fixture tool

Use Linux Node 22 from `services/shuttle-v2/` after installing the locked backend dependencies:

```sh
npx tsc --noEmit -p scripts/encounter-proxy/tsconfig.json
npx vitest run scripts/encounter-proxy
node --import tsx scripts/encounter-proxy/fixture-runner.ts \
  --input /absolute/path/commands.jsonl \
  --catalog /absolute/path/catalog.json \
  --out /absolute/path/new-exclusive-namespace \
  --namespace unique-fixture-id
```

The catalog JSON uses `RouteCatalogSpec` in `types.ts`; repeated published slots remain separate. Additional service or traversal-only masks require their own provenance. Unknown regions are barriers. Synthetic specifications in `test-fixtures.ts` illustrate the schema; they are not Yale service evidence.

Input is finite UTF-8 JSONL with a final newline. Each line is one command:

- `ingest`: `availableAt`, `originalReceivedAt`, HTTP `status`, `origin` (`public-current` or `historical-frame`) and exact response bytes encoded as canonical `rawBase64`.
- `enroll`: `availableAt` and `opportunity` containing `id`, `vehicle` (`routeId`, `busId`, `busName`), `stopId`, `horizon`, `forecastAt`, `availableAt` and the stripped raw `receiptHash`. Horizons are `0-2`, `2-5`, `5-10` or `10-30`.
- `tick`: `availableAt`.

These clocks are explicit fixture simulation clocks. `forecastAt` must equal the evaluated forecast's consumer availability, not model generation time. The source receipt hash comes from `projectPublicPacket`/`stripRawExchange` and is separate from the full raw byte custody hash. Fixture replay never becomes prospective support.

The tool records exact raw bytes before deriving a result, fsyncs an append-only command/result hash chain, writes a final checkpoint, closes the namespace and independently replays the externally pinned prefix before returning success. Actual execution clocks remain separate from fixture clocks. Malformed ingress is retained and seals a refused namespace; no later command is consumed. Duplicate output directories or receipt files are refused. Interrupted namespaces cannot be resumed writable.

The external `<out>.receipt.json` pins the manifest, source inventory and terminal prefix. Keep it outside the namespace when invoking `verifyFixtureNamespace`; a self-reported internal head is insufficient. Verification checks reproducibility and byte custody, not physical service truth. A successful process exit is required in addition to any intermediate artifacts.

The runner has fixed finite input, catalog, command, storage and wall-clock caps. Source inputs use bounded regular-file reads with descriptor identity and EOF checks. Its reviewed runtime import closure stays within this folder and a small builtin allowlist; unsupported commented import clauses and dynamic loading are refused.

## Qualification boundary

The recorded tests retain all 4,314 raw records in original order, distinguish the short South109 episode from the later opposite pass, retain the North110 positive control, and require byte-identical outcomes after adversarial changes to model fields. Synthetic tests separately cover later-lap bindings, clocks, exact deadlines, source gaps and durable journal tampering.

Nothing imports this tool into production or the existing learning loop. No existing trial, labels, dates, publication setting or runtime is changed. The durable prospective namespace factory deliberately rejects activation until a separate source/catalog qualification and prospective admission exist. Fixture success alone does not authorize model fitting, promotion or a live pilot.
