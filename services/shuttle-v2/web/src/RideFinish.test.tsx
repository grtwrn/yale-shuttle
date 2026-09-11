import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RideFinish } from "./RideFinish";
const ride = { toText: "Yale Public Health", toLat: 41.303, toLon: -72.933 };
const props = { ride, onDismiss: () => {}, onFindShuttle: () => {} };
describe("ride recovery", () => {
  it.each([
    ["bus-gone", "missing from live updates for 10 min"],
    ["off-bus", "appears to be away from the shuttle"],
    ["age", "after 2 hours"],
  ] as const)("explains %s without claiming the rider arrived", (reason, explanation) => {
    const html = renderToStaticMarkup(<RideFinish {...props} reason={reason} />);
    expect(html).toContain("Ride tracking stopped");
    expect(html).toContain(explanation);
    expect(html).toContain("Yale Public Health");
    expect(html).toContain("Find another shuttle");
    expect(html).not.toContain("Get off here");
  });
  it("starts walking from current location, not the old boarding stop", () => {
    const html = renderToStaticMarkup(<RideFinish {...props} />);
    expect(html).toContain("Ride ended");
    expect(html).toContain("destination=41.303,-72.933");
    expect(html).toContain("travelmode=walking");
    expect(html).not.toContain("origin=");
  });
  it("still explains tracking when no planned destination exists", () => {
    const html = renderToStaticMarkup(<RideFinish {...props} ride={{}} reason="bus-gone" />);
    expect(html).toContain("Ride tracking stopped");
    expect(html).toContain("Find another shuttle");
    expect(html).not.toContain("maps/dir");
  });
  it("does not offer a broken walking link for invalid coordinates", () => {
    const html = renderToStaticMarkup(<RideFinish {...props} ride={{ ...ride, toLat: NaN }} />);
    expect(html).not.toContain("maps/dir");
  });
  it("wires distinct recovery and dismissal actions", () => {
    const onFindShuttle = vi.fn(), onDismiss = vi.fn();
    const tree = RideFinish({ ...props, onFindShuttle, onDismiss }) as any;
    const buttons = tree.props.children.filter((child: any) => child?.type === "button");
    buttons[0].props.onClick();
    expect(onFindShuttle).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
    buttons[1].props.onClick();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
