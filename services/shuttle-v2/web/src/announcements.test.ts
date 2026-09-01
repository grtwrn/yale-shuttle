import { describe, expect, it } from "vitest";

import { announcementRouteLabels, announcementsForRoute } from "./announcements";

describe("announcementRouteLabels", () => {
  // The live banner that motivated the feature, verbatim.
  it("maps 'Red, Brown' to exactly those two lines", () => {
    expect(announcementRouteLabels("Red, Brown")).toEqual(new Set(["Red", "Brown"]));
  });

  it("a family name covers every variant, the way Yale groups them", () => {
    expect(announcementRouteLabels("Blue")).toEqual(
      new Set(["Blue Day", "Blue Weekend", "Blue Night", "Blue West"]),
    );
  });

  it("a full variant name stays narrow", () => {
    expect(announcementRouteLabels("Blue Night")).toEqual(new Set(["Blue Night"]));
  });

  it("tolerates upstream's dashed style", () => {
    expect(announcementRouteLabels("Orange - Night")).toEqual(new Set(["Orange Night"]));
  });

  it("an unrecognised title matches nothing (treated as general)", () => {
    expect(announcementRouteLabels("Campus Notice").size).toBe(0);
  });
});

describe("announcementsForRoute", () => {
  const banners = [
    { id: 1, title: "Red, Brown", message: "State Street relocated." },
    { id: 2, title: "All riders", message: "Happy holidays." },
  ];

  it("targets named routes and includes general notices", () => {
    expect(announcementsForRoute("Red", banners).map((a) => a.id)).toEqual([1, 2]);
  });

  it("spares unaffected routes the targeted banner", () => {
    expect(announcementsForRoute("Purple", banners).map((a) => a.id)).toEqual([2]);
  });
});
