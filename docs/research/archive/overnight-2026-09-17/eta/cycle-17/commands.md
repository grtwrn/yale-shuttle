# Exact commands and results

All commands ran in the assigned checkout; TS commands use services/shuttle-v2 as cwd. Outputs are only in `/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17`. Historical databases were opened mode=ro.

- `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/run.sh` — exit0;3,000new polls per arm, both checkpoint9000files saved, zero server failures.
- `flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/analyze.sh` — exit0; sequential capture/score/decisions/rider/decision/alignment/SQL/wire/zero-hop gates all pass. See individual `.log` outputs. No prefix replay.
- `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/verify_decisions.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/decision-verification.log` — exit0 after inherited descriptive note correction; exact actual counts unchanged, original source/log/output preserved.
- `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/audit_decision_changes.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/decision-case-audit.log` — exit0; all one order/one caution/four deadline changes accounted for.
- `./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/audit_ranking.mts > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/ranking-state-audit.log` — exit0;3,672saved rows exactly reproduce visibility, one-poll persistence delay explained.
- `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/summarize.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/summary.log` — exit0; inclusive scores reproduce; all19uncertain keys remain, complementary sensitivity labeled; all25largest regression contexts saved.

Preparation: initial inline boundary-seed assertion exited1 on an unadapted canonical-wire filename before any scoring; corrected explicit resumed path before analysis. A diagnostic read before output creation returned nonzero and was not a verification failure. `adapter-provenance.json` records adaptations and exact current numerical memo/runtime-source parity. No app gate was run or claimed.

Final reporting/integrity commands are recorded in their own logs and final-integrity.json.

- `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/write_report.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/write_report.log` — final exit0. Initial draft count assertion failed before writing a report; corrected35current-only/29diagnostic-only counts match saved ledger. Initial script/log preserved.
- `python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/finish.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/final-integrity.log` — exit0;912trackedfiles,241priorartifacts,eightinputs,fourcopiedfrozenfiles unchanged, exactHEAD and cleanindex.
