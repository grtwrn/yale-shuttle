# Finite independent published-call embedding analyzer

This tool enumerates a frozen finite set of interpretations of a published stop plan on an independent raw path. Its outputs are analyzer evidence. It cannot admit a live catalog, launch a watcher, change R3, relabel an existing trial, or publish a model.

`protocol.v2.json` pins the proposal, unchanged R3 geometry and engineering bounds. The immutable v1 remains historical; v2 explicitly accounts for EOF probes separately from source payload. `input-schema.v1.json` defines the strict input shape; `schema.ts` additionally checks source references, original occurrence identity, contiguous published indices, complete crosswalk coverage, closed path and orientation accounting. Original published slots stay distinct even when their names or stop IDs repeat. Every declared variant is considered; no per-bus PDF variant is guessed.

The one-plan-cycle to one-raw-loop relation is a required admission assumption. A reference input without reviewed evidence returns `refused-source-scope` before clock, geometry or search. Fixture assumptions work only in fixture mode. Both modes keep `qualificationPending`, `liveQualified:false` and `publicationCapability:false`. The retained official Pink input deliberately has unqualified cycle/path and PDF crosswalk scope and cannot produce inferred service mappings. Its original official source files are preserved alongside it; it is not an Oct30 or physical-service attestation.

The search keeps every token crosswalk, admitted orientation, cyclic start, maximal 150m raw curb component and permitted one-loop lift. Exact dyadic inequalities test strict interval order and cyclic closure without a nearest-point choice or epsilon. Every accepted/rejected prefix and feasible source witness is retained. A physical alias key annotates repeated solutions without discarding them. Shared/degenerate curb components and separately unqualified SPUR remain unknown. Unassigned counterpasses never become traversal-only by omission from a plan.

`searchExhausted:true` records that the finite search returned normally. `complete:true` additionally requires a nonempty feasible set for every admitted variant and all analysis artifacts to complete. A cap, deadline, missing final record or incomplete source custody cannot count as exhaustion. An admitted variant with no embedding refuses the entire source scope. Candidate invariance is only a static subset result; R3 still requires independent current/next occurrence and ordinal agreement across all raw branches. An unresolved correlated catalog ensemble cannot be replaced with convenient independent masks.

Future execution requires a separately frozen, owned Linux Node22 profile: one CPU, 512MiB memory, Node heap 256MiB, internal monotonic budget 90 seconds, external owner 120 seconds, 64MiB total output including a reserved 1MiB refusal/finalization budget. Bounds can be lowered and never raised by an input. No numerical execution is authorized by these files.

After explicit owner admission, the finite CLI forms are:

```text
cli.ts run --input CONTROL --sources SOURCE_DIRECTORY --out NEW_DIRECTORY [--execution-identity OWNER_IDENTITY]
cli.ts verify --directory EXISTING_DIRECTORY --manifest MANIFEST_SHA256 [--final FINAL_SHA256]
```

The control file must be exactly canonical sorted JSON followed by one newline; noncanonical text, duplicate keys and BOM are refused before namespace creation. Primary evidence files remain exact arbitrary bytes. Control plus primary source files share the frozen 16-file/2MiB payload bound, each at most 256KiB; equality is accepted. A separate allowance permits at most one attempted one-byte EOF probe per descriptor, at most16 per complete source pass. Any nonzero probe refuses and never becomes pinned payload. Payload/probe bytes and attempts are recorded separately; per-pass actual IO is bounded by2MiB+16. The runtime module closure is independently pinned; optional owner execution identity is opaque custody metadata and never qualification evidence by itself.

Custody uses exclusive output creation, bounded regular-file FD reads through EOF, exact input/source/runtime hashes, globally sequenced prefix-chained artifact records, a retained monotonic clock transcript and final external inventory. Verification checks every artifact and replays the pure enumeration with the same clock/byte accounting; missing, extra, partial or modified files refuse. Output failure clears effective invariance and cannot be rescued by an earlier solution prefix.

Focused controls include a tiny independent grid oracle for strict order, a separate exact difference-constraint Cartesian oracle for full folds/crosswalks/all orientations/lifts, source variant contradiction, repeated published calls, SPUR evidence, unknown barriers, self-crossings, seam provenance, resource boundaries and prototype-named IDs. These are finite fixture controls, not prospective accuracy support or proof that a bus served a curb.
