#!/bin/bash
set -euo pipefail
cd /home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2
export OPENBLAS_NUM_THREADS=1
node --max-old-space-size=512 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/current.mjs current 6000 9000 > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/current-resume6000.log 2>&1
node --max-old-space-size=512 /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/canonical.mjs canonical 6000 9000 > /home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-17/canonical-resume6000.log 2>&1
