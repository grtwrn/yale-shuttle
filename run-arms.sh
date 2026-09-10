#!/bin/bash
# The paired gate for the server-side belief: the SAME tree, the same capture,
# the same snapshot, the same population — one arm with a cold store per rider
# cohort (what a browser has), one with a single store stepped over every poll
# of the day (what the server would have).
#
# One arm at a time, nice'd, behind a load gate. Never fights another replay.
set -u
cd /home/gwarren/wt/servermove/services/shuttle-v2 || exit 1
OUT=/home/gwarren/wt/servermove/arms
mkdir -p "$OUT"

# ONE rider-sim arm at a time — a full-day run pins all four cores and has
# crashed this machine. The canary's browsers keep the load average near 6 all
# day, so gating on load alone would never open; gating on "no other replay"
# plus nice -n 10 is what actually protects the machine.
gate() {
  until [ -z "$(pgrep -f 'rider[-]sim/run.ts')" ]; do sleep 30; done
}

arm() { # name warm extra-env...
  local name=$1 warm=$2; shift 2
  gate
  echo "=== $name (WARM_STORE=$warm) started $(date -Is)" | tee -a "$OUT/$name.log"
  env TZ=America/New_York \
    REPLAY_DB=./store/snap.db \
    CAPTURE=/home/gwarren/shuttle-captures/cap-et-0904.jsonl \
    CLIENT_ROOT=/home/gwarren/wt/servermove/services/shuttle-v2 \
    ROUTES=${ROUTES:-Red} HOLDOUT=${HOLDOUT:-} CHAIN=${CHAIN:-none} POP=${POP:-uniform} \
    REPLAY_OUT="$OUT" OUT_NAME="$name" WARM_STORE="$warm" \
    "$@" \
    nice -n 10 npx tsx scripts/eta-replay/rider-sim/run.ts >> "$OUT/$name.log" 2>&1
  echo "exit=$? finished $(date -Is)" | tee -a "$OUT/$name.log"
}

case "${1:-smoke}" in
  smoke)
    arm smoke-cold 0 DETECTOR_FROM=2026-09-04T15:30:00Z FROM=2026-09-04T16:00:00Z TO=2026-09-04T16:40:00Z
    arm smoke-warm 1 DETECTOR_FROM=2026-09-04T15:30:00Z FROM=2026-09-04T16:00:00Z TO=2026-09-04T16:40:00Z
    ;;
  # Is the generator refactor of `computeUpcomingArrivals` a no-op? Same
  # harness, same capture, same population, same WARM_STORE=0 browser arm —
  # only CLIENT_ROOT differs: dbc23ed (the plain loop) against this tree (the
  # drained generator). Here IDENTICAL waits files are the PASS, which is the
  # inverse of every other comparison in this directory.
  refactor)
    gate
    for name in refac-base refac-new; do
      root=/home/gwarren/wt/servermove/services/shuttle-v2
      [ "$name" = refac-base ] && root=/home/gwarren/wt/servermove-base/services/shuttle-v2
      echo "=== $name CLIENT_ROOT=$root started $(date -Is)" | tee -a "$OUT/$name.log"
      env TZ=America/New_York REPLAY_DB=./store/snap.db         CAPTURE=/home/gwarren/shuttle-captures/cap-et-0904.jsonl         CLIENT_ROOT="$root"         ROUTES=Red HOLDOUT= CHAIN=none POP=uniform WARM_STORE=0         DETECTOR_FROM=2026-09-04T15:30:00Z FROM=2026-09-04T16:00:00Z TO=2026-09-04T16:40:00Z         REPLAY_OUT="$OUT" OUT_NAME="$name"         nice -n 10 npx tsx scripts/eta-replay/rider-sim/run.ts >> "$OUT/$name.log" 2>&1
      echo "exit=$? finished $(date -Is)" | tee -a "$OUT/$name.log"
    done
    md5sum "$OUT"/refac-*.waits.jsonl
    ;;
  full)
    # Focus Red (the founding complaint and the line riders use), holdout the
    # two fold-back lines a Red-tuned change must not silently regress, and the
    # 344 Winchester chain block first — the layover the standing model lives
    # or dies on.
    export HOLDOUT=Green,Purple CHAIN=Red:11:6 POP=both
    arm red-cold 0
    arm red-warm 1
    ;;
esac
