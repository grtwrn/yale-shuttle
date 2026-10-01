#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
export OPENBLAS_NUM_THREADS=1
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/verify_capture.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/capture-verification.log 2>&1
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/score.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/score.log 2>&1
./node_modules/.bin/tsx /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/decisions.mts > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/decisions.log 2>&1
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/rider_outcomes.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/rider-outcomes.log 2>&1
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/verify_decisions.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/decision-verification.log 2>&1
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/verify_alignment.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/alignment-verification.log 2>&1
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/verify_score.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/verification.log 2>&1
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/verify_semantics.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/semantic-verification.log 2>&1
python3 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/zero_hop_inventory.py > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/zero-hop-inventory.log 2>&1
