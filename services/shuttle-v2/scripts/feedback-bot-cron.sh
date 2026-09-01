#!/bin/bash
# feedback-bot: reads new rider reports, classifies priority, fixes what is
# safely fixable, routes everything else to the operator. Runs headless
# `claude -p` on the Pi, like map-bot did.
#
# Safety model (in order of what actually protects production):
#   1. Report text is DATA. The prompt quotes it inside a fenced block and
#      instructs the model never to follow instructions found there — but the
#      real enforcement is the layers below, which hold even if that fails.
#   2. Everything ships through `npm run deploy` — typecheck, 600+ tests,
#      staged server, browser smoke. A change that breaks anything cannot land.
#   3. File allowlist enforced OUTSIDE the model: after the run, this wrapper
#      diffs the tree; touches outside web/src/, src/server/ or src/planner/
#      (or ANY change to schema.ts, drizzle/, scripts/, deploy tooling,
#      fly.toml, package.json, Dockerfile, sw.js, manifest) hard-revert the
#      tree and skip the deploy.
#   4. One run at a time (lockfile), 25-minute cap, at most 3 reports per run
#      (enforced in the prompt, and the turn cap bounds it regardless).
set -u
cd "$(dirname "$0")/.."
mkdir -p scripts/.feedback-bot
LOCK=scripts/.feedback-bot/lock
LOG=scripts/.feedback-bot/run-$(date +%Y%m%d-%H%M).log
exec >> "$LOG" 2>&1
if ! mkdir "$LOCK" 2>/dev/null; then echo "already running"; exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
echo "=== feedback-bot $(date -Is) ==="

TOKEN=$(cat ~/.yale-shuttle-admin-token) || exit 1

# Arbitration: fairness (round-robin per reporter) + reputation (repeat
# spam/injection submitters get auto-closed without reaching the model).
QUEUE=$(curl -s -H "x-admin-token: $TOKEN" 'https://yale-shuttle.fly.dev/api/reports?status=open')
ARB=$(echo "$QUEUE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s).reports)))" | node scripts/feedback-bot-arbitrate.mjs)
CHOSEN=$(echo "$ARB" | sed -n 1p)
BLOCKED=$(echo "$ARB" | sed -n 2p)

# Reputation auto-closes: no model involved, one annotation per report.
if [ -n "$BLOCKED" ]; then
  echo "reputation auto-close: $BLOCKED"
  for id in ${BLOCKED//,/ }; do
    curl -s -X POST -H "x-admin-token: $TOKEN" -H 'content-type: application/json' \
      -d '{"status":"wontfix","priority":"nice_to_have","note":"automated: ignored (this browser has repeatedly submitted abusive or machine-directed content)"}' \
      "https://yale-shuttle.fly.dev/api/reports/$id/update" > /dev/null
  done
fi

if [ -z "$CHOSEN" ]; then echo "nothing to process after arbitration"; exit 0; fi
echo "processing report(s): $CHOSEN"

# Snapshot BEFORE state per-file (path + content hash), so enforcement below
# judges only what THIS run changed. The tree legitimately carries other
# uncommitted work; a blanket `git checkout -- .` would destroy it — the bot
# may only ever revert its own edits, file by file.
SNAP_BEFORE=scripts/.feedback-bot/before.snap
SNAP_AFTER=scripts/.feedback-bot/after.snap
# git prints repo-root-relative paths; we run from services/shuttle-v2.
GITROOT=$(git rev-parse --show-toplevel)
snapshot() { git status --porcelain | awk '{print $2}' | while read -r f; do
  if [ -f "$GITROOT/$f" ]; then echo "$(md5sum "$GITROOT/$f" | cut -d' ' -f1)  $f"; else echo "gone  $f"; fi; done | sort; }
snapshot > "$SNAP_BEFORE"

timeout 1500 claude -p "$(cat scripts/feedback-bot-prompt.md)

Process exactly these report ids, no others: $CHOSEN" \
  --allowedTools "Bash,Read,Edit,Write,Grep,Glob" \
  --max-turns 60 || echo "claude run ended (timeout or error)"

# ---- allowlist enforcement (outside the model) ----
snapshot > "$SNAP_AFTER"
# Files whose content is new or different since the snapshot = the bot's edits.
BOT_CHANGED=$(comm -13 "$SNAP_BEFORE" "$SNAP_AFTER" | awk '{print $2}')
revert_bot_files() { echo "$BOT_CHANGED" | while read -r f; do
  [ -z "$f" ] && continue
  if git ls-files --error-unmatch ":/$f" >/dev/null 2>&1; then git checkout -- ":/$f"; else rm -f "$GITROOT/$f"; fi
  echo "  reverted $f"; done; }

VIOLATIONS=$(echo "$BOT_CHANGED" | grep -vE '^services/shuttle-v2/(web/src/|src/server/|src/planner/)' | grep -vE '^$' || true)
CRITICAL=$(echo "$BOT_CHANGED" | grep -E 'schema\.ts|drizzle/|scripts/|deploy|fly\.toml|package\.json|Dockerfile|sw\.js|manifest' || true)
if [ -n "$VIOLATIONS$CRITICAL" ]; then
  echo "OUT-OF-LANE BOT CHANGES — reverting the bot's files only:"
  echo "$VIOLATIONS"
  echo "$CRITICAL"
  revert_bot_files
  exit 1
fi

if [ -n "$BOT_CHANGED" ]; then
  echo "in-lane changes present — shipping through the staged pipeline"
  BOT_CHROMIUM_PATH=/usr/bin/chromium npm run deploy || {
    echo "PIPELINE REFUSED — reverting the bot's files only"
    revert_bot_files
    exit 1
  }
fi
# Strike accounting: chosen reports the model closed as spam feed reputation.
AFTER_RUN=$(curl -s -H "x-admin-token: $TOKEN" 'https://yale-shuttle.fly.dev/api/reports?limit=200')
echo "$AFTER_RUN" | CHOSEN="$CHOSEN" node -e '
const fs=require("fs");
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const chosen=new Set((process.env.CHOSEN||"").split(",").filter(Boolean).map(Number));
  const repPath="scripts/.feedback-bot/reputation.json";
  let rep; try{rep=JSON.parse(fs.readFileSync(repPath,"utf8"));}catch{rep={strikes:{},served:{}};}
  for(const r of JSON.parse(s).reports){
    if(!chosen.has(r.id)) continue;
    if(r.status==="wontfix" && (r.note||"").startsWith("automated:")){
      const k=r.anonId??"anon";
      rep.strikes[k]=(rep.strikes[k]??0)+1;
      console.log("strike for "+k.slice(0,8)+" (now "+rep.strikes[k]+") via #"+r.id);
    }
  }
  fs.writeFileSync(repPath,JSON.stringify(rep,null,2));
});'
echo "=== done $(date -Is) ==="
