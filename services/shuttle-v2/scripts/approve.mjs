#!/usr/bin/env node
// Developer approval: authorize the feedback bot to implement a triaged report.
//
//   npm run approve -- 54
//   npm run approve -- 54 "extract the locate logic into a module first, then retry at low accuracy"
//
// Writes an "[approved]" note on the report (keeping it open) and immediately
// kicks a bot run — approved reports jump the arbitration queue, so work
// starts now, not at the next event. Guidance text becomes operator
// instructions the bot follows (operator notes are trusted input, unlike
// rider bodies).

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [idArg, ...guidance] = process.argv.slice(2);
const id = Number(idArg);
if (!Number.isInteger(id)) {
  console.error("usage: npm run approve -- <report-id> [guidance...]");
  process.exit(2);
}

const TOKEN = fs.readFileSync(path.join(os.homedir(), ".yale-shuttle-admin-token"), "utf8").trim();
const note = "[approved] " + (guidance.join(" ") || "Implement per your triage analysis.");

const res = await fetch(`https://yale-shuttle.fly.dev/api/reports/${id}/update`, {
  method: "POST",
  headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
  body: JSON.stringify({ status: "open", note }),
});
if (!res.ok) {
  console.error(`approve failed: HTTP ${res.status}`);
  process.exit(1);
}
console.log(`#${id} approved — starting a bot run`);

const BOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "feedback-bot-cron.sh");
execFile(BOT, (err) => {
  if (err) {
    console.error(`bot run failed (${err.message}) — the next event or 6h sweep will retry`);
    process.exit(1);
  }
  const log = path.join(path.dirname(fileURLToPath(import.meta.url)), ".feedback-bot");
  console.log(`bot run finished — see the newest log in ${log}/ and the report's note for the outcome`);
});
