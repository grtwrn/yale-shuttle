import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { berthDirectionsText, berthToggleText } from "./berthWords";
import { BERTHS } from "./berths";

/**
 * The canary's route-label pattern, copied here on purpose rather than
 * imported: `scripts/canary-metrics.mjs` is the harness's own file and this is
 * the app asserting that what it renders cannot be mistaken for a route pill.
 * A copy that drifts is caught by the captured fixture in
 * `scripts/canary-metrics.test.mjs`, which runs the real parser.
 */
const IS_LABELISH = /^[A-Za-z][A-Za-z ]{0,19}$/;

describe("the berth disclosure's words", () => {
  it("names the distance and the side, for every cell we ship", () => {
    // The chip is the whole of the folded state: a bare "!" would be a warning
    // the rider cannot act on, and the sentence it hides is two taps away.
    const byId = new Map(BERTHS.map((b) => [`${b.stopId}/${b.routeId}`, berthToggleText(b)]));
    expect(byId.get("48/3")).toBe("⚠ 55 m past");
    expect(byId.get("154/16")).toBe("⚠ 39 m before");
    expect(byId.get("1/10")).toBe("⚠ 91 m past");
    for (const b of BERTHS) {
      expect(berthToggleText(b), `${b.stopId}/${b.routeId}`)
        .toMatch(/^⚠ \d+ m (past|before)$/);
    }
  });

  it("can never be read as a route label by the canary", () => {
    // `isLabelish` is letters and spaces only, and it prefers a match found
    // BELOW the duration — which is exactly where this chip sits. "nearby"
    // (report #102) and "Contribute" both got there first; a chip reading
    // "Stops past published" would have too. The glyph and the digits are what
    // rule it out, so they are pinned rather than assumed.
    for (const b of BERTHS) expect(IS_LABELISH.test(berthToggleText(b))).toBe(false);
    expect(IS_LABELISH.test("Stops past published")).toBe(true); // the shape being avoided
  });

  it("follows the operator's own rule about WHICH stop the button names", () => {
    // "the directions to stop button should now say directions to published
    // stop SINCE WE SHOW TWO" (operator, 2026-09-11). Folded, we show one; the
    // long form returns with the second marker.
    expect(berthDirectionsText(false)).toBe("🧭 Directions to stop");
    expect(berthDirectionsText(true)).toBe("🧭 Directions to published stop");
  });

  it("never says stop sign — some stops have no sign at all", () => {
    // Operator, 2026-09-10. The header comment quotes the retired phrase,
    // which is the record of why it is retired; no line of CODE may carry it.
    const src = readFileSync(new URL("./BerthDisclosure.tsx", import.meta.url), "utf8")
      + readFileSync(new URL("./berthWords.ts", import.meta.url), "utf8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    expect(code).not.toMatch(/stop sign/i);
  });
});

describe("the berth disclosure's shape", () => {
  // No jsdom in this repo (see ContributeButton.test.tsx), so the decisions
  // that are invisible in the rendered strings are pinned at the source, the
  // way `mapFilter.test.ts` and `walk.test.ts` pin theirs.
  const src = readFileSync(new URL("./BerthDisclosure.tsx", import.meta.url), "utf8");

  it("does not MOUNT the map while folded — the point of folding it", () => {
    // Hiding it with CSS would keep a Leaflet instance, its panes and its tile
    // requests alive on every berth card. `scripts/berth-teardown-check.mjs`
    // measures that there is no container at all; this is what makes it true.
    expect(src).toMatch(/\{open && \(\s*<BerthInset/);
    expect(src).not.toMatch(/display:\s*open \?/);
    expect(src).not.toMatch(/visibility:/);
  });

  it("starts folded, and does not remember being opened", () => {
    // The component mounts when the card expands, so `useState(false)` is the
    // whole of "collapsed on every expand of the card". A persisted flag would
    // re-mount a map on a card the rider only glanced at.
    expect(src).toMatch(/useState\(false\)/);
    expect(src).not.toMatch(/localStorage/);
  });

  it("is a disclosure a screen reader can follow, and a thumb can hit", () => {
    expect(src).toMatch(/aria-expanded=\{open\}/);
    expect(src).toMatch(/aria-label=\{`\$\{routeLabel\} stops about /);
    expect(src).toMatch(/minHeight: 44/);
  });

  it("lets the row wrap rather than squeeze either control", () => {
    // Measured at 360 / 390 / 430 px by `scripts/berth-row-measure.mjs`: folded
    // the pair is 311 px and shares a line at all three; opened the longer
    // label takes it to 393 px and the chip drops below. Neither is allowed to
    // ellipsize, which is why both are `nowrap` and the ROW wraps instead.
    expect(src).toMatch(/flexWrap: "wrap"/);
    expect(src.match(/whiteSpace: "nowrap"/g)?.length).toBe(2);
  });
});
