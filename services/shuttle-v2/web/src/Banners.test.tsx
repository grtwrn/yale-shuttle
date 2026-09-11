import { describe, expect, it, vi } from "vitest";

import {
  ABOUT_HREF, ABOUT_LABEL, AffiliationDisclaimer, BETA_LABEL, BetaBanner,
  DISCLAIMER_TEXT,
} from "./Banners";

// Rendered without a DOM library: these are a handful of elements, so
// inspecting the returned React tree keeps this test dependency-free (this
// project has no jsdom/testing-library setup) — same approach as
// ContributeButton.test.tsx.
type El = { type: unknown; props: Record<string, unknown> };

/** Every element in the returned tree, parents first. */
function flatten(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const el = node as El;
  if (!("props" in el)) return out;
  out.push(el);
  flatten((el.props as { children?: unknown }).children, out);
  return out;
}

const betaTree = () =>
  flatten(BetaBanner({ onSendFeedback: () => {} }) as unknown);

/** Concatenated text of the whole tree. */
const textOf = (els: El[]) =>
  els
    .map((e) => (e.props as { children?: unknown }).children)
    .filter((c): c is string => typeof c === "string")
    .join(" ");

describe("BetaBanner", () => {
  it("says it is in beta and asks for reports", () => {
    const text = textOf(betaTree());
    expect(text).toContain(BETA_LABEL);
    expect(text.toLowerCase()).toContain("beta");
    expect(text.toLowerCase()).toContain("report");
  });

  it("is a button that opens the feedback composer", () => {
    // The whole point: a banner that mentions feedback without leading to it
    // is half a feature.
    const onSendFeedback = vi.fn();
    const button = flatten(
      BetaBanner({ onSendFeedback }) as unknown,
    ).find((e) => e.type === "button");
    expect(button).toBeTruthy();
    expect(button!.props.type).toBe("button");
    (button!.props.onClick as () => void)();
    expect(onSendFeedback).toHaveBeenCalledTimes(1);
  });

  it("meets the project's 44 px minimum touch target", () => {
    const button = betaTree().find((e) => e.type === "button")!;
    const style = button.props.style as Record<string, unknown>;
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  });

  it("names the action for a screen reader — the chevron is decoration", () => {
    const button = betaTree().find((e) => e.type === "button")!;
    expect(String(button.props["aria-label"])).toMatch(/feedback|report/i);
    // The emoji and the chevron carry no meaning and must not be read out.
    const decorations = betaTree().filter(
      (e) => e.props["aria-hidden"] === "true",
    );
    expect(decorations.length).toBeGreaterThanOrEqual(2);
  });

  it("sets background AND text colour, so a darkening browser cannot hide it", () => {
    const button = betaTree().find((e) => e.type === "button")!;
    const style = button.props.style as Record<string, unknown>;
    expect(style.background).toBeTruthy();
    expect(style.color).toBeTruthy();
  });

  it("wraps rather than overflowing a narrow phone", () => {
    // 390 px is the reference width; nowrap here would push the chevron off
    // the screen on a 320 px device instead.
    const button = betaTree().find((e) => e.type === "button")!;
    const style = button.props.style as Record<string, unknown>;
    expect(style.whiteSpace).toBeUndefined();
  });
});

describe("AffiliationDisclaimer", () => {
  it("disclaims both affiliation and endorsement", () => {
    const text = textOf(flatten(AffiliationDisclaimer() as unknown));
    expect(text).toContain(DISCLAIMER_TEXT);
    expect(text).toMatch(/not affiliated/i);
    expect(text).toMatch(/endorse/i);
    expect(text).toMatch(/Yale University/);
  });

  it("has nothing to dismiss, and no control but the About link", () => {
    // The sentence is a standing fact, so it is still plain text: no button,
    // no handler, nothing that could hide it. The one anchor is the About
    // link added below, which navigates rather than changing app state.
    const els = flatten(AffiliationDisclaimer() as unknown);
    expect(els.some((e) => e.type === "button")).toBe(false);
    expect(els.some((e) => "onClick" in e.props)).toBe(false);
    expect(els.filter((e) => e.type === "a")).toHaveLength(1);
  });

  it("renders the About link to the standalone page", () => {
    const link = flatten(AffiliationDisclaimer() as unknown)
      .find((e) => e.type === "a");
    expect(link).toBeTruthy();
    expect(link!.props.href).toBe(ABOUT_HREF);
    expect(link!.props.href).toBe("/about");
    expect(link!.props.children).toBe(ABOUT_LABEL);
    expect(ABOUT_LABEL).toBe("About");
    // Same tab: /about is a page a rider reads once and backs out of, and a
    // new tab would leave the app stranded behind it on a phone.
    expect(link!.props.target).toBeUndefined();
  });

  it("gives the About link the project's 44 px minimum touch target", () => {
    const link = flatten(AffiliationDisclaimer() as unknown)
      .find((e) => e.type === "a")!;
    const style = link.props.style as Record<string, unknown>;
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    // A bare inline anchor's box is only as tall as its text, so the height
    // is only real with a flex/block display.
    expect(String(style.display)).toMatch(/flex|block/);
    // Colour alone does not read as a link at 12 px in a muted grey.
    expect(style.textDecoration).toBe("underline");
    expect(style.color).toBeTruthy();
  });

  it("keeps the disclaimer sentence byte-identical", () => {
    expect(DISCLAIMER_TEXT)
      .toBe("Not affiliated with or endorsed by Yale University.");
  });

  it("stays quiet: small and muted, with an explicit colour", () => {
    const root = flatten(AffiliationDisclaimer() as unknown)[0];
    const style = root.props.style as Record<string, unknown>;
    expect(style.fontSize).toBeLessThanOrEqual(12);
    expect(style.color).toBeTruthy();
  });
});
