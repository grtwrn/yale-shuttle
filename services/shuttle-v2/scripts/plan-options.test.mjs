import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { planOptions } from "./plan-options.mjs";

// 15:28 ET on 2026-10-01, when the fixture page was captured.
const AT = Date.UTC(2026, 9, 1, 19, 28);
const MIN = 60_000;
const et = (h, m) => Date.UTC(2026, 9, 1, h + 4, m);

/**
 * The plan as production rendered it on 2026-10-01: body innerText for the
 * eta-accuracy default trip (Prospect / Canner -> Chapel / Church), with two
 * Blue Day buses live. Since #309 (2026-09-18) the options are rows of the
 * "Route | Board in (min) | Arrive at" table. Both harnesses recognised NONE
 * of them, because they still looked for a "N min" line followed by a clock.
 */
const LIVE = readFileSync(new URL("./__fixtures__/plan-table-live.txt", import.meta.url), "utf8");

/** A table row the way the browser's innerText lays it out. */
const row = (label, cell, arrive) => `${label}\t\n${cell}\n\t${arrive}\n\n🚌 10 min\n›\n`;
const table = (...rows) => `Route\tBoard in (min)\tArrive at\n${rows.join("\n")}Clear\n💬 Send feedback\n`;

describe("planOptions", () => {
  it("reads every option of the live route table", () => {
    const opts = planOptions(LIVE, AT);
    expect(opts.map((o) => o.route)).toEqual(["Red", "Green", "Orange Day", "Walk", "Blue Day"]);
    expect(opts.map((o) => o.waitSec)).toEqual([5 * 60, 19 * 60, 15 * 60, null, 20 * 60]);
    expect(opts.map((o) => o.isWalk)).toEqual([false, false, false, true, false]);
    expect(opts.map((o) => o.arriveText)).toEqual(["3:43p – 3:52p", "3:57p – 4:19p", "3:55p – 4:05p", "~3:59p", "4:06p – 4:21p"]);
  });

  it("scores an arrival window at its midpoint, and totalMin from the scrape", () => {
    const [red, , , walk] = planOptions(LIVE, AT);
    expect(red.arriveMs).toBe((et(15, 43) + et(15, 52)) / 2);
    expect(red.totalMin).toBe(20);   // 15:28 -> 15:47:30
    expect(walk.arriveMs).toBe(et(15, 59));
    expect(walk.totalMin).toBe(31);
  });

  it("reads the under-a-minute and at-stop points, and no wait for status rows", () => {
    const opts = planOptions(table(
      row("Red", "<1 (<1 – 1)", "3:17p – 3:24p"),
      row("Blue Night", "At stop", "3:20p – 3:30p"),
      row("Green", "Missed", "—"),
      row("Orange Night", "Unavailable", "—"),
      row("Purple", "Scheduled", "~4:32p"),
    ), AT);
    expect(opts.map((o) => [o.route, o.waitSec, o.arriveText])).toEqual([
      ["Red", 30, "3:17p – 3:24p"],
      ["Blue Night", 0, "3:20p – 3:30p"],
      ["Green", null, null],
      ["Orange Night", null, null],
      ["Purple", null, "~4:32p"],
    ]);
  });

  it("carries an arrival clock past midnight into the next day", () => {
    const at = et(23, 30);
    const [o] = planOptions(table(row("Blue Night", "~8 (5 – 12)", "11:50p – 12:10a")), at);
    expect(o.arriveMs).toBe(at + 30 * MIN);
  });

  it("returns nothing for a page with no route table, which the harnesses fail on", () => {
    expect(planOptions("YALE SHUTTLE TRACKER\nTrip\nMap\nIssues\nFROM\n📍 Current location\n", AT)).toEqual([]);
  });
});
