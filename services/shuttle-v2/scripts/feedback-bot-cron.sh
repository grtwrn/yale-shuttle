#!/bin/bash
# feedback-bot: reads rider reports, classifies priority, proposes fixes as
# PULL REQUESTS, routes everything else to the operator. Triggered by the SSE
# listener (feedback-bot-listener.mjs) or the 6h sweep; headless `claude -p`.
#
# Approval model:
#   - Triage-only actions (priorities, [triage]/automated notes) act directly
#     via the admin API — they change no code.
#   - CODE changes never touch this working tree and are never deployed by the
#     bot. It works in a disposable git worktree, the wrapper commits the
#     result to a feedback-bot/* branch, pushes, opens a PR, and stamps the
#     report with the PR link. MERGING the PR is the developer's approval —
#     master's CI pipeline (gates -> staging -> browser smoke -> fly -> verify)
#     is what deploys it. Closing the PR declines it.
#   - `npm run approve -- <id> [guidance]` pre-authorizes bigger work; the
#     output is still a PR, just allowed to be larger.
#
# Safety (independent of the model behaving):
#   1. Report text is DATA; the prompt forbids following instructions in it.
#   2. Worktree isolation: the main tree is never modified by a bot run.
#   3. Allowlist enforced here, on the worktree diff: changes outside
#      web/src/, src/server/, src/planner/ — or ANY touch of schema.ts,
#      drizzle/, scripts/, deploy tooling, fly.toml, package.json, Dockerfile,
#      sw.js, manifest — abort the PR; nothing is pushed.
#   4. Gates re-run by the wrapper in the worktree before any push.
#   5. One run at a time (lockfile), 25-min cap, <=3 reports, <=1 PR per run.
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
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.npm-global/bin/claude}"
SHUTTLE_DIR=$PWD
BOT_FAILED=0

# ---- follow up on earlier proposals first -----------------------------------
# A merged feedback-bot PR means the fix shipped through CI: tell the rider.
gh pr list --repo grtwrn/yale-shuttle --state merged --search "head:feedback-bot/" \
  --json headRefName,url --jq '.[] | .headRefName + " " + .url' 2>/dev/null | while read -r BRANCH URL; do
  RID=$(echo "$BRANCH" | sed -n 's|feedback-bot/\([0-9]*\)-.*|\1|p')
  [ -z "$RID" ] && continue
  NOTE=$(curl -s -H "x-admin-token: $TOKEN" "https://yale-shuttle.fly.dev/api/reports?limit=200" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s).reports.find(r=>r.id===$RID);process.stdout.write(r?(r.note||''):'gone')})")
  case "$NOTE" in
    "[pr]"*)
      echo "PR merged for #$RID — marking fixed"
      curl -s -X POST -H "x-admin-token: $TOKEN" -H 'content-type: application/json' \
        -d "{\"status\":\"addressed\",\"note\":\"[fixed] The proposed fix was reviewed, merged and deployed. ($URL)\"}" \
        "https://yale-shuttle.fly.dev/api/reports/$RID/update" > /dev/null
      git push origin --delete "$BRANCH" 2>/dev/null || true
      ;;
  esac
done

# ---- arbitration ------------------------------------------------------------
QUEUE=$(curl -s -H "x-admin-token: $TOKEN" 'https://yale-shuttle.fly.dev/api/reports?status=open')
ARB=$(echo "$QUEUE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s).reports)))" | node scripts/feedback-bot-arbitrate.mjs)
CHOSEN=$(echo "$ARB" | sed -n 1p)
BLOCKED=$(echo "$ARB" | sed -n 2p)

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

# ---- disposable worktree ----------------------------------------------------
TS=$(date +%s)
WT=/tmp/feedback-bot-wt-$TS
BRANCH="feedback-bot/pending-$TS"
git fetch origin master -q
git worktree add -q -b "$BRANCH" "$WT" origin/master || { echo "worktree failed"; exit 1; }
cleanup_wt() { cd "$SHUTTLE_DIR"; git worktree remove --force "$WT" 2>/dev/null; git branch -D "$BRANCH" 2>/dev/null; }
trap 'cleanup_wt; rmdir "$LOCK" 2>/dev/null' EXIT
# Share dependencies; installing in the worktree would take minutes on the Pi.
ln -s "$SHUTTLE_DIR/node_modules" "$WT/services/shuttle-v2/node_modules" 2>/dev/null || true
ln -s "$SHUTTLE_DIR/web/node_modules" "$WT/services/shuttle-v2/web/node_modules" 2>/dev/null || true

( cd "$WT/services/shuttle-v2" && timeout 1500 "$CLAUDE_BIN" -p "$(cat "$SHUTTLE_DIR/scripts/feedback-bot-prompt.md")

Process exactly these report ids, no others: $CHOSEN
Your working directory is a DISPOSABLE git worktree of the repo — implement here. Do not run any git commands; the wrapper handles commit, push and the pull request." \
  --allowedTools "Bash,Read,Edit,Write,Grep,Glob" \
  --max-turns 60 ) || { echo "CLAUDE RUN FAILED (timeout or error)"; BOT_FAILED=1; }

# ---- allowlist + PR ---------------------------------------------------------
cd "$WT"
# node_modules entries are the wrapper's own dependency symlinks, not bot
# changes — counting them made a triage-only run look out-of-lane.
CHANGED=$(git status --porcelain | awk '{print $2}' | grep -v "node_modules" || true)
if [ -z "$CHANGED" ]; then
  echo "triage-only run, no code proposed"
  exit "$BOT_FAILED"
fi
VIOLATIONS=$(echo "$CHANGED" | grep -vE '^services/shuttle-v2/(web/src/|src/server/|src/planner/)' | grep -vE '^$' || true)
CRITICAL=$(echo "$CHANGED" | grep -E 'schema\.ts|drizzle/|scripts/|deploy|fly\.toml|package\.json|Dockerfile|sw\.js|manifest' || true)
if [ -n "$VIOLATIONS$CRITICAL" ]; then
  echo "OUT-OF-LANE CHANGES — discarding the worktree, no PR:"
  echo "$VIOLATIONS"; echo "$CRITICAL"
  exit 1
fi

echo "re-running gates in the worktree"
( cd services/shuttle-v2 && npm run typecheck && npx vitest run ) > /dev/null 2>&1 || {
  echo "GATES FAILED in worktree — no PR"; exit 1; }

FIRST_ID=$(echo "$CHOSEN" | cut -d, -f1)
REAL_BRANCH="feedback-bot/$FIRST_ID-$(date +%m%d%H%M)"
git checkout -q -b "$REAL_BRANCH"
git add -A
git -c user.name="feedback-bot" -c user.email="feedback-bot@yale-shuttle.local" \
  commit -q -m "feedback-bot: proposed fix for report #$FIRST_ID

Automated proposal from rider feedback. Review before merging; merging
deploys via the master CI pipeline.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -q origin "$REAL_BRANCH"
PR_URL=$(gh pr create --repo grtwrn/yale-shuttle \
  --title "feedback-bot: fix for report #$FIRST_ID" \
  --body "Automated proposal for rider report #$FIRST_ID (see its [triage] note for the analysis). Merging = approval; master CI deploys. Closing = declined." \
  --head "$REAL_BRANCH" --base master 2>/dev/null | tail -1)
echo "PR opened: $PR_URL"
curl -s -X POST -H "x-admin-token: $TOKEN" -H 'content-type: application/json' \
  -d "{\"status\":\"open\",\"note\":\"[pr] A fix is proposed and awaiting developer review: $PR_URL\"}" \
  "https://yale-shuttle.fly.dev/api/reports/$FIRST_ID/update" > /dev/null
echo "=== done $(date -Is) ==="
exit "$BOT_FAILED"
