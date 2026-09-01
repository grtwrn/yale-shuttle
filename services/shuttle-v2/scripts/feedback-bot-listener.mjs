#!/usr/bin/env node
// Event-driven trigger for the feedback bot: holds one SSE connection to
// /api/reports/stream and runs the bot when a report lands. Replaces the
// 2-hour cron schedule with callback semantics — the server can't reach into
// the Pi, so the Pi listens on an outbound stream instead.
//
// Debounce: a burst of reports (someone filing three in a row) triggers ONE
// run 30 s after the first event; the run drains whatever the arbitrator
// picks. The bot's own lockfile already guarantees a single instance, so a
// trigger during a run is simply absorbed by the next one.
//
// Kept alive by scripts/feedback-bot-keepalive.sh from cron; exits on stream
// errors and lets the keepalive restart it (simplest possible supervision).

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOT = path.join(HERE, "feedback-bot-cron.sh");
const TOKEN = fs.readFileSync(path.join(os.homedir(), ".yale-shuttle-admin-token"), "utf8").trim();
const URL = "https://yale-shuttle.fly.dev/api/reports/stream";
const DEBOUNCE_MS = 30_000;

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

let timer = null;
function scheduleRun(reportId) {
  if (timer) return; // burst -> one run
  log(`report #${reportId} — bot run in ${DEBOUNCE_MS / 1000}s`);
  timer = setTimeout(() => {
    timer = null;
    execFile(BOT, (err) => {
      if (err) log(`bot run failed: ${err.message}`);
      else log("bot run finished");
    });
  }, DEBOUNCE_MS);
}

const res = await fetch(URL, {
  headers: { "x-admin-token": TOKEN, accept: "text/event-stream" },
});
if (!res.ok || !res.body) {
  log(`stream refused: ${res.status}`);
  process.exit(1);
}
log("listening for reports");

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let event = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) { log("stream ended"); process.exit(1); }
  buf += dec.decode(value, { stream: true });
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:") && event === "report") {
      scheduleRun(line.slice(5).trim());
      event = "";
    }
  }
}
