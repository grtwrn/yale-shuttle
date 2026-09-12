import { describe, expect, it } from "vitest";
import { checkView, compileExpect, describeMissing, rulesFor, unevaluatedRules } from "./preview-expect.mjs";

/**
 * THE REAL FALSE PASS, verbatim.
 *
 * Not a synthetic page: this is what pr-preview.mjs itself recorded in its new
 * "saw" field on 2026-09-12 while reproducing the case — a Red bus mocked for a
 * preview and shot on a SATURDAY, when Red runs Mon-Fri. The service gate
 * correctly dropped the bus, so the page is entirely valid and contains no Red
 * option at all. Before this guard the harness screenshotted it, found no page
 * error, and EXITED 0; only a human opening the PNG caught it.
 *
 * The tell is in the text: "SHUTTLES THAT GO THERE — NONE ON THE MAP YET".
 */
const FALSE_PASS_PAGE = "YALE SHUTTLE TRACKER | Not affiliated with or endorsed by Yale University. | Trip | Map | Issues | \u21bb | FROM | \ud83d\udccd Current location | \u21c5 | TO | \ud83c\udfc1 41.306177, -72.929592 | \u2606 | WHEN | Now | Plan for later\u2026 | \u2600\ufe0f | 71\u00b0F \u00b7 Clear \u00b7 no rain expected | \u25be | \u00b0F | | | \u00b0C | SHUTTLES THAT GO THERE \u2014 NONE ON THE MAP YET | Green | Runs Daily 5:30a\u20136:40p | Should be running now \u2014 no bus reporting yet";

/** The assertion the fixture recipe declares: a live countdown on a card. */
const WANTED = "in \\d+[,-]";

describe("the recorded false pass", () => {
  it("is caught — the page is valid and the feature is absent", () => {
    const { rules, errors } = compileExpect(WANTED, ["trip"]);
    expect(errors).toEqual([]);
    const r = checkView(rules, "trip", FALSE_PASS_PAGE);
    expect(r.missing).toEqual([WANTED]);
    expect(r.matched).toEqual([]);
    expect(r.checked).toBe(1);
  });

  it("really is a page with no error on it — which is why nothing else caught it", () => {
    expect(FALSE_PASS_PAGE).not.toMatch(/App crashed/);
    expect(FALSE_PASS_PAGE).toContain("NONE ON THE MAP YET");
  });

  it("still passes an assertion that IS satisfied, so this is not a blanket refusal", () => {
    const { rules } = compileExpect("NONE ON THE MAP YET", ["trip"]);
    expect(checkView(rules, "trip", FALSE_PASS_PAGE).missing).toEqual([]);
  });

  it("names what was wanted, for the console and the record", () => {
    expect(describeMissing("trip", [WANTED])).toContain("expected content not found");
    expect(describeMissing("trip", [WANTED])).toContain(WANTED);
  });
});

/**
 * BACK-COMPATIBILITY IS THE CONSTRAINT, not a nicety: the feedback bot writes
 * its own recipes, and a mandatory assertion would break every one of them.
 */
describe("a recipe that declares nothing behaves exactly as before", () => {
  it("compiles to no rules and no errors", () => {
    for (const nothing of [undefined, null]) {
      const { rules, errors } = compileExpect(nothing, ["trip", "map"]);
      expect(rules).toEqual([]);
      expect(errors).toEqual([]);
    }
  });

  it("checks nothing, so no view can fail on content", () => {
    const { rules } = compileExpect(undefined, ["trip"]);
    expect(rulesFor(rules, "trip")).toEqual([]);
    expect(checkView(rules, "trip", FALSE_PASS_PAGE).missing).toEqual([]);
    expect(unevaluatedRules(rules, [])).toEqual([]);
  });
});

describe("the shapes a declaration may take", () => {
  it("takes a string, a list, or a per-view object", () => {
    expect(compileExpect("by \\d", ["trip"]).rules.map((r) => r.view)).toEqual([null]);
    expect(compileExpect(["a", "b"], ["trip"]).rules).toHaveLength(2);
    const perView = compileExpect({ trip: "by \\d", map: ["x", "y"] }, ["trip", "map"]);
    expect(perView.errors).toEqual([]);
    expect(perView.rules.map((r) => r.view)).toEqual(["trip", "map", "map"]);
  });

  it("applies an unscoped rule to every view and a scoped one only to its own", () => {
    const { rules } = compileExpect({ trip: "only-trip" }, ["trip", "map"]);
    expect(rulesFor(rules, "trip")).toHaveLength(1);
    expect(rulesFor(rules, "map")).toHaveLength(0);
    const all = compileExpect("everywhere", ["trip", "map"]).rules;
    expect(rulesFor(all, "trip")).toHaveLength(1);
    expect(rulesFor(all, "map")).toHaveLength(1);
  });

  it("matches case-insensitively, since the app SHOUTS some of its own labels", () => {
    const { rules } = compileExpect("none on the map yet", ["trip"]);
    expect(checkView(rules, "trip", FALSE_PASS_PAGE).missing).toEqual([]);
  });
});

/**
 * A CHECK THAT FINDS NOTHING LOOKS EXACTLY LIKE A CHECK THAT PASSED. That is
 * the failure behind #111, #123, and the eight days eta-accuracy.mjs spent
 * matching nothing, so a declaration that was never evaluated fails the run.
 */
describe("the guard on the guard", () => {
  it("rejects a declaration aimed at a view the run never shoots", () => {
    const { errors } = compileExpect({ favorites: "x" }, ["trip", "map"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("would never be checked");
  });

  it("reports a rule no view evaluated — the view died before the check", () => {
    const { rules } = compileExpect({ trip: "by x" }, ["trip", "map"]);
    expect(unevaluatedRules(rules, ["map"])).toEqual(["by x"]);
    expect(unevaluatedRules(rules, ["trip"])).toEqual([]);
  });

  it("reports an unscoped rule when not one view was ever checked", () => {
    const { rules } = compileExpect("anything", ["trip"]);
    expect(unevaluatedRules(rules, [])).toEqual(["anything"]);
    expect(unevaluatedRules(rules, ["trip"])).toEqual([]);
  });

  it("refuses a malformed declaration rather than silently asserting nothing", () => {
    expect(compileExpect("(unclosed", ["trip"]).errors[0]).toContain("not a valid regular expression");
    expect(compileExpect("", ["trip"]).errors[0]).toContain("non-empty string");
    expect(compileExpect(["ok", 42], ["trip"]).errors).toHaveLength(1);
    expect(compileExpect(42, ["trip"]).errors[0]).toContain("expect must be");
    expect(compileExpect(["ok", ""], ["trip"]).errors).toHaveLength(1);
  });
});
