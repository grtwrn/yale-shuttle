/**
 * Blue Day #44's stand at 333 Cedar on 2026-09-04, exactly as `raw_positions`
 * recorded it — the feed behind report #100, the first from an outside rider.
 *
 * Seventy-four unedited rows, `bus_id` 65959 throughout (no id reissue). The
 * bus turns in off Congress, comes within the pin radius of stop 10 at +18842,
 * stands motionless for nine minutes, and creeps 30 m up to the kerb. THREE
 * holes in it are process restarts — six deploys landed between 15:48 and
 * 15:58 UTC — and `arrivals` holds four rows for the one stand because of them.
 *
 * Shared by `detector.report100.test.ts` (the rule) and
 * `collector.report100.test.ts` (the wiring) so the two cannot replay
 * different feeds and agree with each other about the wrong one.
 */

/** 2026-09-04T15:53:20.751Z — the last poll before #44 turns in toward the stop. */
export const T0 = Date.parse("2026-09-04T15:53:20.751Z");

/** Milliseconds after {@link T0}, latitude, longitude — the feed, unedited. */
export const FEED: Array<[number, number, number]> = [
  [0, 41.301950, -72.933273],
  [13810, 41.302422, -72.933829],
  [18842, 41.302702, -72.933986],
  [23829, 41.302702, -72.933986],
  [28839, 41.302702, -72.933986],
  [33777, 41.302953, -72.934122],
  [38872, 41.302953, -72.934122],
  [43803, 41.302953, -72.934122],
  [48762, 41.302953, -72.934122],
  [53999, 41.302953, -72.934122],
  [58782, 41.302953, -72.934122],
  [63871, 41.302953, -72.934122],
  [68866, 41.302953, -72.934122],
  [74225, 41.302953, -72.934122],
  [79279, 41.302953, -72.934122],
  [84187, 41.302953, -72.934122],
  [89183, 41.302953, -72.934122],
  [94251, 41.302953, -72.934122],
  // 16.9 s hole: the process restarted under it.
  [111159, 41.302953, -72.934122],
  [116196, 41.302953, -72.934122],
  [121134, 41.302953, -72.934122],
  [126245, 41.302953, -72.934122],
  [131344, 41.302953, -72.934122],
  [136187, 41.302953, -72.934122],
  [141137, 41.302953, -72.934122],
  [146258, 41.302953, -72.934122],
  [151173, 41.302953, -72.934122],
  [156119, 41.302953, -72.934122],
  [161177, 41.302953, -72.934122],
  [166158, 41.302953, -72.934122],
  [171804, 41.302953, -72.934122],
  [176806, 41.302953, -72.934122],
  [181921, 41.302953, -72.934122],
  [186893, 41.302953, -72.934122],
  [191745, 41.302953, -72.934122],
  [196762, 41.302953, -72.934122],
  // 16.4 s hole: the restart the rider's payload caught.
  [213152, 41.302953, -72.934122],
  [218071, 41.302953, -72.934122],
  [223165, 41.302953, -72.934122],
  [228103, 41.302953, -72.934122],
  [233093, 41.302953, -72.934122],
  [238245, 41.302953, -72.934122],
  [243131, 41.302953, -72.934122],
  [248101, 41.302953, -72.934122],
  [253145, 41.302953, -72.934122],
  [258098, 41.302953, -72.934122],
  [263111, 41.302953, -72.934122],
  [268252, 41.302953, -72.934122],
  [273421, 41.302953, -72.934122],
  [278451, 41.302953, -72.934122],
  [283420, 41.302953, -72.934122],
  [288406, 41.302953, -72.934122],
  [293405, 41.302953, -72.934122],
  [298357, 41.302953, -72.934122],
  [303367, 41.302953, -72.934122],
  [308639, 41.302953, -72.934122],
  [313393, 41.302953, -72.934122],
  [318408, 41.302953, -72.934122],
  [323378, 41.302953, -72.934122],
  [328395, 41.302953, -72.934122],
  [333397, 41.302953, -72.934122],
  [338648, 41.302953, -72.934122],
  // 15.0 s hole: another restart.
  [353684, 41.302953, -72.934122],
  [358679, 41.302953, -72.934122],
  [363654, 41.302953, -72.934122],
  [368697, 41.302953, -72.934122],
  [373678, 41.302953, -72.934122],
  [378705, 41.302953, -72.934122],
  [383764, 41.302953, -72.934122],
  [388628, 41.302953, -72.934122],
  [393792, 41.302953, -72.934122],
  // The bus creeps 30 m up to the kerb. Same stop, same wait.
  [398704, 41.303208, -72.934242],
  [403647, 41.303208, -72.934242],
  [408883, 41.303208, -72.934242],
];

/** The poll on which the bus first comes within the pin radius of stop 10. */
export const STAND_BEGAN = 18842;

/** 333 Cedar. */
export const CEDAR_333 = 10;

/** Production `routes.stops_json` for route 1 (Blue - Weekday Daytime). */
export const BLUE_DAY = [
  106, 34, 101, 47, 100, 102, 105, 69, 139, 136, 130, 129, 140, 133, 135, 138,
  97, 118, 42, 98, 38, 39, 72, 43, 10, 2, 5, 52, 41, 20, 108,
];

/**
 * The three holes the deploys left, as offsets from {@link T0} — the first poll
 * AFTER each one. A process that restarts under a hole meets the bus as a first
 * sighting, which is the whole subject of report #100.
 */
export const RESTARTS = [111159, 213152, 353684];

/** Where #44 sits for most of the stand — 35 m short of the 333 Cedar sign. */
export const RESTING = { lat: 41.302953, lon: -72.934122 };

/**
 * The next stop up the line (Cedar / Congress). A test drives the bus there to
 * make the detector move its anchor, which is what CLOSES the stand: the dwell
 * patch and the `stop_visits` row are both written on the transition, never
 * while the bus is still standing.
 */
export const NEXT_STOP = 2;
