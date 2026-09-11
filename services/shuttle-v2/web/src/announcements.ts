// Service banners from Yale's own shuttle map (routes_announcements.php),
// relayed through /api/buses. The upstream shape names the affected routes
// only as free text in `title` — "Red, Brown" — so matching them to our route
// configs is this module's whole job.

import { ROUTE_LISTS, type RouteListConfig } from "./routes";

export interface ServiceAnnouncement {
  id: number;
  title: string;
  message: string;
}

/**
 * Which routes a banner's title names.
 *
 * Tokens are comma/ampersand-separated route family names, matched as label
 * prefixes: "Blue" affects every Blue variant (Day, Weekend, Night, West) —
 * which is how Yale uses it, their site groups whole families under one name —
 * while "Blue Night" affects only that one. Unrecognised tokens match nothing;
 * a title that matches nothing is a general notice, and the caller should show
 * it un-targeted rather than drop it.
 */
export function announcementRouteLabels(
  title: string,
  lists: readonly RouteListConfig[] = ROUTE_LISTS,
): Set<string> {
  const out = new Set<string>();
  const tokens = title
    .split(/[,;&/]|\band\b/i)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  for (const cfg of lists) {
    const label = cfg.label.toLowerCase();
    for (const t of tokens) {
      // Prefix in either direction: "Blue" names "Blue Night"; upstream's
      // fuller "Orange - Night" also names our "Orange Night".
      const norm = t.replace(/\s*-\s*/g, " ");
      if (label.startsWith(norm) || norm.startsWith(label)) {
        out.add(cfg.label);
        break;
      }
    }
  }
  return out;
}

/** The banners that name this route, plus general ones that name no route. */
export function announcementsForRoute(
  routeLabel: string,
  all: readonly ServiceAnnouncement[],
): ServiceAnnouncement[] {
  return all.filter((a) => {
    const labels = announcementRouteLabels(a.title);
    return labels.size === 0 || labels.has(routeLabel);
  });
}

/**
 * The banners that name no route at all — a system-wide notice.
 *
 * Yale posts closures this way: on 2026-09-07 the feed carried
 * `{title: "Labor Day", message: "On 09/07/2026, Yale Shuttles will be closed
 * … All services will resume on 09/08/2026"}`, which names no route family, so
 * `announcementRouteLabels` returns nothing and the per-route banners never
 * showed it. A rider opening the app on a holiday morning saw only "No
 * shuttles running right now" and no reason — the app looked broken when it
 * was right. These are the notices to show when nothing is running.
 */
export function generalAnnouncements(
  all: readonly ServiceAnnouncement[],
): ServiceAnnouncement[] {
  return all.filter((a) => announcementRouteLabels(a.title).size === 0);
}
