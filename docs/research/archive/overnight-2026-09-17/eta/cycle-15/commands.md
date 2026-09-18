# Executed recovery commands

Final saved-wire scoring, under one shared lock, exit 0:

```bash
flock -w 900 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/heavy.lock bash -c 'set -e; python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/score.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/score-final.log 2>&1; python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/verify_score.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/verification-final.log 2>&1; python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/audit_tails.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/tail-audit-final.log 2>&1; python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/rider_outcomes.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/rider-outcomes-final.log 2>&1'
```

Additional completed checks, each exit 0:

```bash
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/verify_semantics.py
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/audit_join_changes.py
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/audit_transitions.py
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/compare_resume.py
python3 -m py_compile /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/score.py /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/verify_score.py /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/rider_outcomes.py /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/verify_semantics.py
```

Final report/integrity are generated with report.py then finish.py. final-integrity.json records the latter result.

Retained initial failures: diagnose_verification.py exited 1 because SQL how!=gap suppressed NULL endpoints; its source/traceback remain. rg was unavailable (127); grep/sed were used. Original interrupted round also retained the unbounded capture partial, early pricing-origin assumption failure and preflight zero-counter failure. These are not passed gates. Initial score and intermediate semantic score outputs remain in explicitly superseded directories.

No 6,000-poll forecast generation was rerun in this recovery invocation. run.sh/logs/metas/frozen bundles from the interrupted invocation are inherited evidence, verified with saved-wire and resume checks above. No application build/typecheck/test/browser/publication command was run.

Final decision-field check, exit0:

```bash
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-15/verify_decisions.py
```
