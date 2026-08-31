import { describe, expect, it } from "vitest";

import { ROUTE_LISTS } from "./routes";
import { trackerRouteId, trackerUrl } from "./YaleTrackerPreview";

describe("YaleTrackerPreview route mapping", () => {
  it("maps a label to the upstream route id the tracker publishes", () => {
    // The tracker's URL is keyed on the upstream id, not our label.
    expect(trackerRouteId("Red")).toBe(3);
    expect(trackerRouteId("Blue Day")).toBe(1);
    expect(trackerUrl("Red")).toBe("https://yale.downtownerapp.com/routes/3");
  });

  it("resolves every route we can show, so no card gets a dead control", () => {
    for (const cfg of ROUTE_LISTS) {
      expect(trackerRouteId(cfg.label), cfg.label).toBe(cfg.busRouteIds[0]);
      expect(trackerUrl(cfg.label), cfg.label).toMatch(
        /^https:\/\/yale\.downtownerapp\.com\/routes\/\d+$/,
      );
    }
  });

  it("returns null for an unknown label rather than a broken URL", () => {
    // The component renders nothing in this case instead of linking to /null.
    expect(trackerRouteId("Not A Route")).toBeNull();
    expect(trackerUrl("Not A Route")).toBeNull();
  });
});
