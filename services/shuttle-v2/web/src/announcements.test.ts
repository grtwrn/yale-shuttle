import { describe, expect, it } from "vitest";

import { announcementRouteLabels, announcementsForRoute, generalAnnouncements, isGroceryTransitionAnnouncement } from "./announcements";

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

  it.each(['Grocery Route', 'Grocery Routes', 'Grocery Line', 'Grocery Lines'])("targets %s to both grocery lines", title => {
    expect(announcementRouteLabels(title)).toEqual(new Set(['Grocery TJ', 'Grocery Ham']));
  });
});

describe('live grocery-transition notice', () => {
  const notice = { id: 27, title: 'Grocery Route', message: "Beginning 9/19/2026, the Hamden Grocery route will be the main Grocery Line which now offers Trader Joes's. The Milford route is discontinued." };
  it('reaches both grocery lines without appearing on unrelated routes or as a general notice', () => {
    expect(announcementsForRoute('Grocery Ham', [notice])).toEqual([notice]);
    expect(announcementsForRoute('Grocery TJ', [notice])).toEqual([notice]);
    expect(announcementsForRoute('Red', [notice])).toEqual([]);
    expect(generalAnnouncements([notice])).toEqual([]);
  });
  it('recognizes only the notice replaced by the date-aware message', () => {
    expect(isGroceryTransitionAnnouncement(notice)).toBe(true);
    expect(isGroceryTransitionAnnouncement({ ...notice, message: notice.message.replace('9/19/2026', '10/19/2026') })).toBe(false);
    expect(isGroceryTransitionAnnouncement({ ...notice, message: 'Hamden grocery pickup relocated today.' })).toBe(false);
    expect(isGroceryTransitionAnnouncement({ ...notice, title: 'Red' })).toBe(false);
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

describe("general (system-wide) announcements", () => {
  it("keeps a notice that names no route family, and drops the route-targeted ones", () => {
    // Both rows verbatim from the live feed on 2026-09-07 (Labor Day).
    const all = [
      { id: 23, title: "Red, Brown", message: "State Street Station relocated to Chapel and Union." },
      { id: 26, title: "Labor Day", message: "On 09/07/2026, Yale Shuttles will be closed om observance of the Yale designated holiday Labor day. All services will resume on 09/08/2026" },
    ];
    expect(generalAnnouncements(all).map((a) => a.id)).toEqual([26]);
  });

  it("is empty when every notice names a route", () => {
    expect(generalAnnouncements([{ id: 1, title: "Blue", message: "detour" }])).toEqual([]);
  });
});
