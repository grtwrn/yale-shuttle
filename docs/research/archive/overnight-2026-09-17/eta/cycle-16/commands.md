# Executed commands

Working directory: `/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17`.
All output below is within `/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-16` (`O`).

1. `python3 -m py_compile $O/score.py`, `python3 -m py_compile $O/verify_semantics.py`, `python3 -m py_compile $O/verify_alignment.py` — exit 0.
2. `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash -c 'python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-16/score.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-16/score.log 2>&1'` — exit 0, 6,000 existing polls rescored; no forecasts regenerated.
3. First `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash $O/verify.sh` — interrupted with SIGTERM to its own verifier, exit 143. Repeated identical SQL queries were unnecessarily slow. Original source/empty log and reason preserved; no semantic failure or passing validation claimed for this invocation. `VERIFIER_RESOURCE_NOTE.json` documents caching the exact query results before the complete rerun.
4. `python3 $O/compare_labels.py > $O/label-comparison.log 2>&1` — exit 0; every original scored row preserved or assigned an explicit proved correction, all raw forecasts/availability/stability/progress and 25 prior largest regressions retained.
5. `python3 $O/zero_hop_inventory.py > $O/zero-hop-inventory.log 2>&1` — exit 0; 57 current / 58 canonical unresolved-identity zero-hop scored rows catalogued, no new exclusions or reassignments.
6. `python3 $O/audit_cases.py > $O/resolved-case-audit.log 2>&1` — exit 0; all 216 newly resolved rows and eight following-target changes documented, including up to 1,574.321-second actual point error.

The final locked verification, report, and integrity commands are recorded in RESULTS.md when completed. No application unit/type/full-suite/Vite/browser/staging/CI/deploy checks are required or claimed for this artifact-only change. No dependencies, screenshots, telemetry, historical writes, external contacts or watcher changes.

7. Final `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash $O/verify.sh` — exit0. All three sequential verifiers complete:8,228affected rows per arm,183,123structural truths,both-arm wire/occurrence checks,and4,925ridertrips per arm.
8. `python3 $O/report.py` — exit0; RESULTS.md regenerated from completed checks.
