#!/usr/bin/env node
// Decides WHICH untriaged reports this bot run may touch. Two policies, both
// the operator's ("round robin arbitrate based on the user; if a user gives
// too many bad comments that are cyber attacks, we can ignore that user"):
//
//   FAIRNESS  one report per reporter per run, reporters ordered by who was
//             served least recently — a single noisy browser cannot monopolize
//             the bot while everyone else's reports queue behind theirs.
//
//   REPUTATION  a reporter whose submissions keep getting closed as
//             spam/injection ("automated:" wontfix) accrues strikes; at
//             STRIKE_LIMIT their new reports are auto-closed here, without
//             ever reaching the model. Strikes are per anon id, persisted in
//             scripts/.feedback-bot/reputation.json, and the operator can
//             clear one by deleting its entry.
//
// stdin:  JSON array of open reports (id, body, priority, note, anonId, createdAt)
// stdout: line 1: report ids to process (comma-separated, may be empty)
//         line 2: report ids to auto-close for reputation (comma-separated)
// The wrapper handles the actual closing and the post-run strike accounting.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STRIKE_LIMIT = 3;
const MAX_PER_RUN = 3;
const REP = path.join(path.dirname(fileURLToPath(import.meta.url)), ".feedback-bot/reputation.json");

const load = () => {
  try { return JSON.parse(fs.readFileSync(REP, "utf8")); } catch { return { strikes: {}, served: {} }; }
};
const save = (r) => fs.writeFileSync(REP, JSON.stringify(r, null, 2));

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const reports = JSON.parse(input);
  const rep = load();

  // Two ways into a run:
  //   untriaged — nobody has written a note yet (priority is NOT part of this
  //     test: riders set their own, so an urgent submission must not look
  //     "already triaged"), or
  //   approved — the operator reviewed the bot's [triage] analysis and wrote a
  //     note starting "[approved]", authorizing implementation. These jump
  //     every tier: an explicit human instruction outranks all arbitration.
  const untriaged = reports.filter(
    (r) => r.status === "open" && !r.note && !r.body.startsWith("[map-bot]"),
  );
  const approved = reports.filter(
    (r) => r.status === "open" && (r.note ?? "").startsWith("[approved]"),
  );
  // Replied: a rider followed up after triage. Detected by a followup newer
  // than our per-report watermark (kept locally — the server has no
  // "note written at" field to compare against). Re-enters the normal pool at
  // the report's priority; the watermark advances when we choose it, so one
  // reply means one revisit, not a loop.
  const followupsOf = (r) => {
    try { return JSON.parse(r.context ?? "{}").followups ?? []; } catch { return []; }
  };
  rep.handledFollowups = rep.handledFollowups ?? {};
  const replied = reports.filter((r) => {
    if (r.status !== "open" || !r.note || (r.note ?? "").startsWith("[approved]")) return false;
    const fu = followupsOf(r).filter((f) => f.text !== "Reporter marked this as resolved.");
    if (fu.length === 0) return false;
    const newest = Math.max(...fu.map((f) => f.at));
    return newest > (rep.handledFollowups[r.id] ?? 0);
  });
  for (const r of replied) {
    const fu = followupsOf(r);
    rep.handledFollowups[r.id] = Math.max(...fu.map((f) => f.at));
  }

  const keyOf = (r) => r.anonId ?? "anon";
  const pool = [...untriaged, ...replied];
  const blocked = pool.filter((r) => (rep.strikes[keyOf(r)] ?? 0) >= STRIKE_LIMIT);
  const eligible = pool.filter((r) => (rep.strikes[keyOf(r)] ?? 0) < STRIKE_LIMIT);

  // Priority tiers first (an urgent report beats everyone's normals), then
  // the fairness rotation WITHIN each tier — a flood of one user's urgents
  // still yields to another user's urgent, but not to anyone's nice-to-have.
  const chosen = [];
  // Operator-approved work first, oldest approval first, no fairness cap —
  // the developer asked for exactly this to happen.
  for (const r of approved.sort((a, b) => a.createdAt - b.createdAt)) {
    if (chosen.length >= MAX_PER_RUN) break;
    chosen.push(r);
  }
  for (const tier of ["urgent", "normal", "nice_to_have"]) {
    if (chosen.length >= MAX_PER_RUN) break;
    const inTier = eligible.filter((r) => r.priority === tier);
    const byUser = new Map();
    for (const r of inTier.sort((a, b) => a.createdAt - b.createdAt)) {
      if (!byUser.has(keyOf(r))) byUser.set(keyOf(r), []);
      byUser.get(keyOf(r)).push(r);
    }
    const users = [...byUser.keys()].sort(
      (a, b) => (rep.served[a] ?? 0) - (rep.served[b] ?? 0),
    );
    for (let round = 0; chosen.length < MAX_PER_RUN; round++) {
      let took = false;
      for (const u of users) {
        if (chosen.length >= MAX_PER_RUN) break;
        const q = byUser.get(u);
        if (q && q.length > round) {
          chosen.push(q[round]);
          rep.served[u] = Date.now();
          took = true;
        }
      }
      if (!took) break;
    }
  }

  save(rep);
  console.log(chosen.map((r) => r.id).join(","));
  console.log(blocked.map((r) => r.id).join(","));
});
