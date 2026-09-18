# Reproduction and data scope

This archive preserves research as it was performed. It is not a second deployed application or a self-contained raw-data distribution.

## What is here

Reports, independent reviews, plans, fitted coefficients, experiment patches, analysis programs, diagnostic assertions and result summaries are under `archive/`, grouped by the original research directory. Every experiment's source version, dates, outcome definitions and limitations should be read before comparing numbers.

`manifest.json` records original source paths, bytes and available SHA-256 hashes. Published copies also have hashes. A JSON object's `_publication` entry records removed large row arrays and operational identifier fields. Aggregate scores, subgroup counts, fit parameters and limitations are retained where present. A summarized file is **not** byte-identical to the original file referenced by a frozen experiment plan.

Rejected variants and pre-correction outputs are intentionally included. In particular, causal timing, peer identity, occurrence matching and replay-cache corrections changed the interpretation of earlier results. The dated review chain is the authority for those changes, not whichever score looks best.

Original source, patches and generated figures retain their historical formatting, including existing whitespace. Formatting warnings in those archived artifacts are not changes to the current application.

## Re-running a study

1. Read its `PLAN.json`, report, review and source program. Establish which dates were training, reused development, chronological follow-up or genuinely unopened observations.
2. Obtain the original public-shuttle recording snapshot and derived event/leg inputs named by that study. Check their recorded hashes where supplied. The Git archive does not contain the bulk SQLite/JSONL recording collection or private operator reports.
3. Check out the application revision named by the experiment. Use its `services/shuttle-v2` dependencies and shared collector/ETA modules. Archived worktree names and absolute paths are historical; recreate that workspace layout or explicitly adapt imports and file paths in a separate working copy.
4. Use the study's stated timezone (`America/New_York`), chronological availability contracts and runtime support gates. Do not substitute current live calibration for a historical frozen fit and call the result an exact reproduction.
5. Run the saved analysis/build/replay/scoring sequence. Inspect excluded, censored and unresolved observations alongside aggregate scores. Keep valid outliers and genuine regressions.

The Python studies commonly use NumPy and SciPy; TypeScript studies use the relevant app revision's `tsx`, `esbuild`, SQLite and ETA code. Exact commands are retained where they were recorded. This publication does not invent missing dependency pins or claim historical receipt timestamps were recovered when only a conservative proxy was available.

## Checking the publication itself

From the repository root:

```sh
python3 docs/research/verify_archive.py
```

The checker validates every published file against the publication manifest, verifies the report catalogue and internal Markdown links, and rejects symlinks or bulk database/stream files. This checks archive integrity and navigation; it is not a fresh statistical replication.

## Publication boundaries

Raw operational snapshots, database copies, GPS/forecast row streams, UI screenshots, execution transcripts, generated bundles and operator-submission containers are inventoried or excluded by category. Private feedback bodies and browser identifiers do not belong in a research-results commit. Small public-shuttle or synthetic numerical fixtures may remain where needed to explain a case; they are not independent real-rider observations.

Current production source and design documents remain outside the historical snapshot. Research-only publication does not change coefficients, collection, ETA behavior, watcher state or deployment.
