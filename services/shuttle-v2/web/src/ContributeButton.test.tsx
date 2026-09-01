import { describe, expect, it } from "vitest";

import { ContributeButton, REPO_URL } from "./ContributeButton";

// Rendered without a DOM library: the component is a single element, so
// inspecting the returned React element keeps this test dependency-free
// (this project has no jsdom/testing-library setup).
type El = { type: unknown; props: Record<string, unknown> };
const render = () => ContributeButton() as unknown as El;

describe("ContributeButton", () => {
  it("points at the repository over https", () => {
    const el = render();
    expect(el.props.href).toBe(REPO_URL);
    expect(String(el.props.href).startsWith("https://github.com/")).toBe(true);
  });

  it("opens in a new tab without handing it a reference back", () => {
    // Missing noopener lets the opened page navigate this one via window.opener.
    const el = render();
    expect(el.props.target).toBe("_blank");
    expect(String(el.props.rel)).toContain("noopener");
    expect(String(el.props.rel)).toContain("noreferrer");
  });

  it("has an accessible name — an icon alone is invisible to a screen reader", () => {
    const el = render();
    expect(String(el.props["aria-label"]).toLowerCase()).toContain("github");
    expect(String(el.props["aria-label"])).toMatch(/new tab/i);
  });

  it("meets the project's 44 px minimum touch target", () => {
    const el = render();
    const style = el.props.style as Record<string, unknown>;
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  });

  it("keeps its label at or above the 16 px iOS zoom threshold or is not an input", () => {
    // Only inputs trigger iOS zoom-on-focus; a link may be smaller. Pin the
    // element type so this stays true if the component is ever reworked.
    const el = render();
    expect(el.type).toBe("a");
  });
});

