#!/usr/bin/env node
/**
 * How many people are using the app.
 *
 * Reads the operator-only /api/stats endpoint. The token is the same one the
 * triage queue uses: $SHUTTLE_ADMIN_TOKEN, else ~/.yale-shuttle-admin-token.
 *
 *   npm run riders
 *   npm run riders -- --json      # for piping somewhere
 *
 * Counts are per BROWSER, not per person: one rider on a phone and a laptop is
 * two, and clearing site data starts a new one. They are a good trend line and
 * a soft floor on real people, not a headcount.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.BOT_BASE_URL ?? "https://yale-shuttle.fly.dev";
const json = process.argv.includes("--json");

function token() {
  if (process.env.SHUTTLE_ADMIN_TOKEN) return process.env.SHUTTLE_ADMIN_TOKEN.trim();
  const file = path.join(os.homedir(), ".yale-shuttle-admin-token");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    console.error(
      `No admin token. Set $SHUTTLE_ADMIN_TOKEN or put it in ${file}.\n` +
        `It is the same token the triage queue uses (see CLAUDE.md).`,
    );
    process.exit(1);
  }
}

const res = await fetch(`${BASE}/api/stats`, { headers: { "x-admin-token": token() } });
if (res.status === 401) {
  console.error("Rejected: the token is wrong. Check ~/.yale-shuttle-admin-token.");
  process.exit(1);
}
if (res.status === 503) {
  console.error("The server has no SHUTTLE_ADMIN_TOKEN configured, so stats are disabled.");
  process.exit(1);
}
if (!res.ok) {
  console.error(`Unexpected ${res.status} from ${BASE}/api/stats`);
  process.exit(1);
}

const { riders } = await res.json();
if (json) {
  console.log(JSON.stringify(riders));
} else {
  const row = (label, n) => `  ${label.padEnd(14)}${String(n).padStart(6)}`;
  console.log("\nUnique browsers using yale-shuttle\n");
  console.log(row("today", riders.today));
  console.log(row("last 7 days", riders.last7Days));
  console.log(row("last 30 days", riders.last30Days));
  console.log(row("all time", riders.allTime));
  console.log(
    "\n  Counts browsers, not people — phone + laptop is 2, and clearing\n" +
      "  site data starts a new one. History is kept for 90 days.\n",
  );
}
