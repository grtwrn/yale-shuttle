#!/bin/bash
set -euo pipefail
O=/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-13
bash "$O/run.sh"
bash "$O/run-fixture.sh"
python3 "$O/pair_score.py"
python3 "$O/compare_fixture.py"
python3 "$O/verify.py"
python3 "$O/longitudinal.py"
python3 "$O/audit_changes.py"
python3 "$O/tail_context.py"
python3 "$O/verify_export.py"
python3 "$O/compare_export_red.py"
