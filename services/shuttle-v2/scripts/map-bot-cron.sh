#!/usr/bin/env bash
# map-bot-cron.sh — scheduled LOCAL run of the map bot (system crontab on the
# Pi). Replaces the retired cloud routine (trig_01Bkf38toKw5NucbsG3jz4ZJ,
# disabled 2026-07-05): the cloud sandbox had to install Chromium from scratch
# every run and broke daily, spamming the user with failure notifications.
#
# Two stages per run:
#   1. CAPTURE (deterministic): health probe + map-bot-visual.mjs — random
#      trip, real headless chromium, screenshots of plan + map + bus watch.
#   2. JUDGE (AI): a headless `claude -p` session reads the screenshots +
#      meta.json and judges the run like a rider would, filing ONE in-app
#      "[map-bot]" report only for a genuine defect.
#
# Silent on success. Hard capture failures and judge failures file a deduped
# "[map-bot]" report via POST /api/report (never more than one open at once).
# Artifacts: .bot-artifacts/run-*/ (+ verdict.md per run), pruned after 14 days.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${BOT_BASE_URL:-https://yale-shuttle.fly.dev}"
ART="$HERE/.bot-artifacts"
CLAUDE_BIN="/home/gwarren/.npm-global/bin/claude"
# GET /api/reports is operator-only now (it returns reporter IPs), so the
# dedupe check needs the shared secret. Kept out of the repo: env var first,
# else a mode-600 file in $HOME. Empty token just means dedupe degrades to
# "file it" — POST /api/report stays public.
ADMIN_TOKEN="${SHUTTLE_ADMIN_TOKEN:-$(cat "$HOME/.yale-shuttle-admin-token" 2>/dev/null || true)}"
mkdir -p "$ART"
LOG="$ART/cron-$(date +%Y%m%d-%H%M%S).log"

# Keep two weeks of artifacts/logs so the SD card doesn't fill up.
find "$ART" -maxdepth 1 -mtime +14 -exec rm -rf {} + 2>/dev/null

file_report() { # $1 = reason
  # Dedupe: if an open [map-bot] report already exists, don't file another.
  local open payload
  open="$(curl -sf --max-time 15 -H "x-admin-token: $ADMIN_TOKEN" \
    "$BASE/api/reports?status=open" || true)"
  if [[ "$open" == *'[map-bot]'* ]]; then
    echo "map-bot-cron: open [map-bot] report already exists, not filing" >&2
    return 0
  fi
  payload="$(REASON="$1" LOGPATH="$LOG" python3 -c '
import json, os
print(json.dumps({
  "note": "[map-bot] " + os.environ["REASON"]
          + " (log on the Pi: " + os.environ["LOGPATH"] + ")",
  "source": "map-bot-cron",
}))')"
  curl -sf --max-time 15 -X POST "$BASE/api/report" \
    -H 'content-type: application/json' --data "$payload" >&2 || true
}

# ── Stage 1: capture ─────────────────────────────────────────────────────────
health="$(curl -sf --max-time 15 "$BASE/healthz" || true)"
if [[ "$health" != *'"ok":true'* ]]; then
  echo "map-bot-cron FAIL: healthz not ok: ${health:-no response}" >&2
  file_report "scheduled run: site unhealthy — healthz returned: ${health:-no response}"
  exit 1
fi
if ! BOT_CHROMIUM_PATH=/usr/bin/chromium /usr/bin/node "$HERE/map-bot-visual.mjs" >"$LOG" 2>&1; then
  reason="visual capture failed (page crash / no screenshots); log tail: $(tail -c 400 "$LOG" | tr '\n' ' ')"
  echo "map-bot-cron FAIL: $reason" >&2
  file_report "scheduled run: $reason"
  exit 1
fi

RUNDIR="$(grep -o '<BOT_VISUAL>.*</BOT_VISUAL>' "$LOG" | head -1 \
  | python3 -c 'import sys,json,re; m=re.search(r"<BOT_VISUAL>(.*)</BOT_VISUAL>", sys.stdin.read()); print(json.loads(m.group(1))["outDir"] if m else "")')"
if [[ -z "$RUNDIR" || ! -d "$RUNDIR" ]]; then
  file_report "scheduled run: capture succeeded but no artifact dir was found"
  exit 1
fi

# ── Stage 2: AI judgment ─────────────────────────────────────────────────────
# Resolve dedupe HERE rather than letting the judge query it, so the admin
# token never has to appear in the prompt (which would put it in verdict.md
# and the log). The judge only ever needs POST /api/report, which is public.
existing="$(curl -sf --max-time 15 -H "x-admin-token: $ADMIN_TOKEN" \
  "$BASE/api/reports?status=open" || true)"
if [[ "$existing" == *'[map-bot]'* ]]; then
  DEDUP_RULE="An open [map-bot] report ALREADY EXISTS, so do NOT file a report under any circumstances this run — just give your verdict."
else
  DEDUP_RULE="No open [map-bot] report exists, so you may file exactly one if (and only if) there is a genuine defect."
fi

JUDGE_PROMPT="You are the yale-shuttle map-bot judge. A scripted browser run just tested the live site https://yale-shuttle.fly.dev and saved artifacts in $RUNDIR — meta.json (the trip, the /api/plan ground-truth recommendation, watched-bus distance per cycle, console errors) and full-page PNG screenshots (00-loaded = trip tab, 01-plan = ranked plan options, 01b-map = the Leaflet map, 02-watch-* = the map during the bus watch). Read meta.json first, then EVERY png (your Read tool renders images). Judge GENEROUSLY and flag only clear breakage. The run is GOOD if ALL hold: (1) the map screenshots show real OpenStreetMap tiles, route polylines, stop markers, and at least one labelled bus marker — not blank or an error screen (if meta.json status is WALK_ONLY, no bus/route on the map is fine); (2) the plan screenshot shows a coherent ranked list broadly consistent with the ground truth — small differences in minutes, arrival times, or exact board stop are EXPECTED and NOT defects (the UI recomputes seconds later from live data); only flag an empty, nonsensical, or grossly contradictory plan (e.g. ground truth had a clear fast shuttle but the UI shows no route at all); (3) meta.json shows no console/page errors; (4) during the watch the tracked bus marker stays present — flat or rising distance is NOT a bug (resting or mid-loop), only a fully missing marker is. If (and only if) there is a genuine defect: $DEDUP_RULE File a report with curl -sf -X POST 'https://yale-shuttle.fly.dev/api/report' -H 'content-type: application/json' --data '<json>' where the json has note starting with '[map-bot] ' describing the trip and expected-versus-seen, plus source 'map-bot-judge', and mention the artifact dir $RUNDIR. Never POST anywhere else and never report a healthy run. End with a verdict line 'VERDICT: GOOD' or 'VERDICT: PROBLEM — <one sentence>' followed by a summary under 150 words (trip, plan, bus watched, distance trend, whether you filed a report and its id)."

if ! ( cd "$RUNDIR" && timeout 600 "$CLAUDE_BIN" -p "$JUDGE_PROMPT" \
    --model claude-sonnet-5 \
    --allowedTools "Read" "Bash(curl:*)" \
    > "$RUNDIR/verdict.md" 2>>"$LOG" ); then
  reason="AI judge failed to run (see verdict.md/log); capture artifacts are in $RUNDIR"
  echo "map-bot-cron FAIL: $reason" >&2
  file_report "scheduled run: $reason"
  exit 1
fi
echo "map-bot-cron: judge verdict follows" >>"$LOG"
cat "$RUNDIR/verdict.md" >>"$LOG"
exit 0
