import { describe, expect, it } from "vitest";

import { riderFacingNote } from "./reports.js";

describe("riderFacingNote — what a rider reads of an operator/bot note", () => {
  it("returns a plain note unchanged", () => {
    expect(riderFacingNote("Thanks, fixed this morning.")).toBe("Thanks, fixed this morning.");
    expect(riderFacingNote(null)).toBeNull();
  });

  it("keeps only the text above the --- rule", () => {
    const note = "Good idea! We're looking into it.\n---\n[triage] Hypothesis: planner.ts:218 prices n:0 hops at avgSeg…";
    expect(riderFacingNote(note)).toBe("Good idea! We're looking into it.");
  });

  it("strips the machine tags the tooling keys on", () => {
    expect(riderFacingNote("[pr] Thanks — a fix is in the works!\n---\nPR: https://github.com/x/y/pull/2"))
      .toBe("Thanks — a fix is in the works!");
    expect(riderFacingNote("[fixed] This should be sorted now.")).toBe("This should be sorted now.");
    expect(riderFacingNote("[approved] [triage] On it.")).toBe("On it.");
    expect(riderFacingNote("automated: Thanks for checking the box works!")).toBe("Thanks for checking the box works!");
    expect(riderFacingNote("automated-abuse: ignored")).toBe("ignored");
  });

  it("shows no reply when the note is only tags or log", () => {
    expect(riderFacingNote("[triage]")).toBeNull();
    expect(riderFacingNote("---\nroot cause: anchor.ts")).toBeNull();
    expect(riderFacingNote("   ")).toBeNull();
  });

  it("does not treat a dash inside a sentence as the rule", () => {
    expect(riderFacingNote("Yes --- and thanks!")).toBe("Yes --- and thanks!");
    expect(riderFacingNote("Line one\n  ---  \nlog")).toBe("Line one");
    expect(riderFacingNote("Windows\r\nnote\r\n---\r\nlog")).toBe("Windows\nnote");
  });
});
