// Trimmed slice of a real `GET /api/buses` payload (captured 2026-08-31),
// reduced to two routes so the fixture stays a few KB rather than a blob:
//
//   "1" Blue Day     — 31 stops WITH calibrated segment times (n >= 1), so
//                      planner/ETA tests exercise the observed-data path
//                      rather than the distance fallback.
//   "4" Blue Weekend — 31 stops, kept for its pathological geometry:
//                      Broadway/York (index 22) and Elm/York (index 24) are
//                      ~23 m apart on the ground but TWO stops apart in the
//                      sequence. That pair is what findRouteAnchor exists to
//                      survive (reports #37/#38). Its segment stats are
//                      priors (n = 0) because the route only runs weekends.

import type { DwellTimes, SegmentTimes } from "../arrivals";
import type { LatLon } from "../geo";
import type { BusData } from "../map-data";

export const BLUE_DAY = { routeId: "1", busRouteId: 1, label: "Blue Day" } as const;
export const BLUE_WEEKEND = { routeId: "4", busRouteId: 4, label: "Blue Weekend" } as const;

export const routeStops: Record<string, number[]> = {
  "1": [106, 34, 101, 47, 100, 102, 105, 69, 139, 136, 130, 129, 140, 133, 135, 138, 97, 118, 42, 98, 38, 39, 72, 43, 10, 2, 5, 52, 41, 20, 108],
  "4": [100, 105, 129, 28, 82, 95, 83, 85, 88, 92, 93, 86, 63, 42, 98, 32, 122, 14, 13, 10, 2, 150, 21, 116, 53, 41, 20, 106, 34, 101, 47],
};

export const stopCoords: Record<number, LatLon> = {
  2: { lat: 41.306539, lon: -72.933001 },    // 129 York
  5: { lat: 41.30872, lon: -72.931417 },    // 180 York (A&A)
  10: { lat: 41.303254, lon: -72.934247 },    // 333 Cedar
  13: { lat: 41.300236, lon: -72.932021 },    // Amistad / Cedar
  14: { lat: 41.300531, lon: -72.929866 },    // Amistad / Church St South
  20: { lat: 41.312609, lon: -72.925331 },    // Becton / 15 Prospect
  21: { lat: 41.311002, lon: -72.930344 },    // Broadway / York
  28: { lat: 41.323937, lon: -72.913996 },    // Canner / Livingston
  32: { lat: 41.304876, lon: -72.923138 },    // Chapel / State Elm City Market
  34: { lat: 41.318492, lon: -72.923687 },    // Chemistry / 225 Prospect
  38: { lat: 41.306177, lon: -72.929592 },    // College / Crown
  39: { lat: 41.305293, lon: -72.930255 },    // College / George
  41: { lat: 41.310583, lon: -72.926188 },    // College / Wall (N)
  42: { lat: 41.310836, lon: -72.926148 },    // College / Wall (S)
  43: { lat: 41.30199, lon: -72.933299 },    // Congress / Cedar
  47: { lat: 41.323538, lon: -72.923285 },    // Divinity / 409 Prospect
  52: { lat: 41.31049, lon: -72.930123 },    // Elm / York
  53: { lat: 41.31086, lon: -72.93054 },    // Elm / York (TYCO)
  63: { lat: 41.311134, lon: -72.924022 },    // Grove / Temple
  69: { lat: 41.329965, lon: -72.917606 },    // Huntington / Edgehill (E)
  72: { lat: 41.303422, lon: -72.931698 },    // LEPH / 60 College
  82: { lat: 41.323303, lon: -72.910898 },    // Orange / Canner
  83: { lat: 41.320062, lon: -72.913347 },    // Orange / Cottage
  85: { lat: 41.318385, lon: -72.914615 },    // Orange / Edwards (S)
  86: { lat: 41.310003, lon: -72.920939 },    // Orange / Grove
  88: { lat: 41.316338, lon: -72.916176 },    // Orange / Humphrey (S)
  92: { lat: 41.314826, lon: -72.917319 },    // Orange / Pearl (S)
  93: { lat: 41.312323, lon: -72.919177 },    // Orange / Trumbull
  95: { lat: 41.32224, lon: -72.911692 },    // Orange / Willow (S)
  97: { lat: 41.315675, lon: -72.920859 },    // Peabody Museum / Whitney / Sachem
  98: { lat: 41.308356, lon: -72.927978 },    // Phelps Gate
  100: { lat: 41.325351, lon: -72.922891 },    // Prospect / Canner
  101: { lat: 41.320038, lon: -72.923299 },    // Prospect / Edwards
  102: { lat: 41.328261, lon: -72.921951 },    // Prospect / Highland (N)
  105: { lat: 41.330366, lon: -72.921482 },    // Prospect / Huntington
  106: { lat: 41.315749, lon: -72.924393 },    // Prospect / Sachem (N)
  108: { lat: 41.314021, lon: -72.924894 },    // Prospect / Trumbull
  116: { lat: 41.315041, lon: -72.938202 },    // Stop & Shop
  118: { lat: 41.311184, lon: -72.923753 },    // Temple / Grove
  122: { lat: 41.297929, lon: -72.926912 },    // Union Station (S)
  129: { lat: 41.324692, lon: -72.916817 },    // Whitney / Canner
  130: { lat: 41.326294, lon: -72.915854 },    // Whitney / Cold Spring (S)
  133: { lat: 41.321281, lon: -72.918194 },    // Whitney / Cottage (S)
  135: { lat: 41.319793, lon: -72.918903 },    // Whitney / Edwards (S)
  136: { lat: 41.328281, lon: -72.914879 },    // Whitney / Highland
  138: { lat: 41.318019, lon: -72.919756 },    // Whitney / Humphrey (S)
  139: { lat: 41.329605, lon: -72.914275 },    // Whitney / Huntington
  140: { lat: 41.323205, lon: -72.917287 },    // Whitney / Linden
  150: { lat: 41.308511, lon: -72.931505 },    // York / Chapel
};

export const stopNames: Record<number, string> = {
  2: "129 York",
  5: "180 York (A&A)",
  10: "333 Cedar",
  13: "Amistad / Cedar",
  14: "Amistad / Church St South",
  20: "Becton / 15 Prospect",
  21: "Broadway / York",
  28: "Canner / Livingston",
  32: "Chapel / State Elm City Market",
  34: "Chemistry / 225 Prospect",
  38: "College / Crown",
  39: "College / George",
  41: "College / Wall (N)",
  42: "College / Wall (S)",
  43: "Congress / Cedar",
  47: "Divinity / 409 Prospect",
  52: "Elm / York",
  53: "Elm / York (TYCO)",
  63: "Grove / Temple",
  69: "Huntington / Edgehill (E)",
  72: "LEPH / 60 College",
  82: "Orange / Canner",
  83: "Orange / Cottage",
  85: "Orange / Edwards (S)",
  86: "Orange / Grove",
  88: "Orange / Humphrey (S)",
  92: "Orange / Pearl (S)",
  93: "Orange / Trumbull",
  95: "Orange / Willow (S)",
  97: "Peabody Museum / Whitney / Sachem",
  98: "Phelps Gate",
  100: "Prospect / Canner",
  101: "Prospect / Edwards",
  102: "Prospect / Highland (N)",
  105: "Prospect / Huntington",
  106: "Prospect / Sachem (N)",
  108: "Prospect / Trumbull",
  116: "Stop & Shop",
  118: "Temple / Grove",
  122: "Union Station (S)",
  129: "Whitney / Canner",
  130: "Whitney / Cold Spring (S)",
  133: "Whitney / Cottage (S)",
  135: "Whitney / Edwards (S)",
  136: "Whitney / Highland",
  138: "Whitney / Humphrey (S)",
  139: "Whitney / Huntington",
  140: "Whitney / Linden",
  150: "York / Chapel",
};

export const segmentTimes: SegmentTimes = {
  "1": {
    "106-34": { avg: 71.4, sd: 27.9, n: 58 },
    "34-101": { avg: 40.4, sd: 13.8, n: 57 },
    "101-47": { avg: 75.5, sd: 31.7, n: 56 },
    "47-100": { avg: 52.1, sd: 40.8, n: 56 },
    "100-102": { avg: 51, sd: 20.4, n: 56 },
    "102-105": { avg: 84.9, sd: 171.2, n: 54 },
    "105-69": { avg: 64.8, sd: 49.1, n: 53 },
    "69-139": { avg: 49.4, sd: 7.3, n: 44 },
    "139-136": { avg: 80.9, sd: 25.5, n: 45 },
    "136-130": { avg: 33, sd: 20.4, n: 57 },
    "130-129": { avg: 37, sd: 15.7, n: 57 },
    "129-140": { avg: 45.4, sd: 20.7, n: 57 },
    "140-133": { avg: 31.1, sd: 13.7, n: 57 },
    "133-135": { avg: 36.4, sd: 14.9, n: 57 },
    "135-138": { avg: 73.2, sd: 34, n: 56 },
    "138-97": { avg: 52.3, sd: 23.6, n: 55 },
    "97-118": { avg: 89.5, sd: 5, n: 1 },
    "118-42": { avg: 78.5, sd: 26.3, n: 46 },
    "42-98": { avg: 90, sd: 5, n: 0 },
    "98-38": { avg: 88.9, sd: 42.8, n: 56 },
    "38-39": { avg: 48.5, sd: 25.2, n: 56 },
    "39-72": { avg: 116.1, sd: 31.8, n: 56 },
    "72-43": { avg: 56.1, sd: 21.8, n: 57 },
    "43-10": { avg: 68, sd: 17.3, n: 58 },
    "10-2": { avg: 495.9, sd: 199.6, n: 58 },
    "2-5": { avg: 101.1, sd: 31.7, n: 58 },
    "5-52": { avg: 77.6, sd: 37.8, n: 58 },
    "52-41": { avg: 115, sd: 5, n: 1 },
    "41-20": { avg: 43, sd: 21.5, n: 0 },
    "20-108": { avg: 34.3, sd: 17.4, n: 56 },
    "108-106": { avg: 58.1, sd: 24.8, n: 58 },
  },
  "4": {
    "100-105": { avg: 70.2, sd: 5, n: 0 },
    "105-129": { avg: 135, sd: 5, n: 0 },
    "129-28": { avg: 145, sd: 5, n: 0 },
    "28-82": { avg: 50.1, sd: 5, n: 0 },
    "82-95": { avg: 45, sd: 5, n: 0 },
    "95-83": { avg: 52.6, sd: 5, n: 0 },
    "83-85": { avg: 50, sd: 5, n: 0 },
    "85-88": { avg: 50, sd: 5, n: 0 },
    "88-92": { avg: 50, sd: 5, n: 0 },
    "92-93": { avg: 40.1, sd: 5, n: 0 },
    "93-86": { avg: 60, sd: 5, n: 0 },
    "86-63": { avg: 95.2, sd: 5, n: 0 },
    "63-42": { avg: 60, sd: 5, n: 0 },
    "42-98": { avg: 57.4, sd: 28.7, n: 0 },
    "98-32": { avg: 180.1, sd: 5, n: 0 },
    "32-122": { avg: 232.5, sd: 5, n: 0 },
    "122-14": { avg: 142.5, sd: 5, n: 0 },
    "14-13": { avg: 45, sd: 5, n: 0 },
    "13-10": { avg: 69.8, sd: 34.9, n: 0 },
    "10-2": { avg: 475.2, sd: 5, n: 0 },
    "2-150": { avg: 90.2, sd: 5, n: 0 },
    "150-21": { avg: 53.4, sd: 26.7, n: 0 },
    "21-116": { avg: 55, sd: 5, n: 0 },
    "116-53": { avg: 365.2, sd: 5, n: 0 },
    "53-41": { avg: 66.4, sd: 33.2, n: 0 },
    "41-20": { avg: 43, sd: 21.5, n: 0 },
    "20-106": { avg: 65, sd: 5, n: 0 },
    "106-34": { avg: 70, sd: 5, n: 0 },
    "34-101": { avg: 25, sd: 5, n: 0 },
    "101-47": { avg: 64.9, sd: 5, n: 0 },
    "47-100": { avg: 39.9, sd: 5, n: 0 },
  },
};

export const dwellTimes: DwellTimes = {
  "1": {
    "2": { med: 105, sd: 38.2, n: 23 },
    "5": { med: 85, sd: 36.8, n: 24 },
    "10": { med: 480.1, sd: 324.2, n: 23 },
    "20": { med: 39.9, sd: 19.7, n: 22 },
    "34": { med: 42.5, sd: 28, n: 24 },
    "38": { med: 55, sd: 43.5, n: 24 },
    "39": { med: 130, sd: 28.5, n: 24 },
    "41": { med: 54.9, sd: 43.2, n: 45 },
    "42": { med: 45.1, sd: 36, n: 39 },
    "43": { med: 65, sd: 38.4, n: 24 },
    "47": { med: 50, sd: 34.1, n: 23 },
    "52": { med: 110, sd: 52.1, n: 24 },
    "69": { med: 57.4, sd: 22.2, n: 22 },
    "72": { med: 57.5, sd: 29.4, n: 24 },
    "97": { med: 90, sd: 33, n: 23 },
    "98": { med: 65, sd: 95.3, n: 40 },
    "100": { med: 50, sd: 30, n: 23 },
    "101": { med: 70.1, sd: 64.2, n: 23 },
    "102": { med: 45, sd: 30, n: 21 },
    "105": { med: 64.9, sd: 10.2, n: 21 },
    "106": { med: 79.9, sd: 30.1, n: 23 },
    "108": { med: 59.9, sd: 25.2, n: 33 },
    "118": { med: 95, sd: 51.7, n: 28 },
    "129": { med: 50.1, sd: 24, n: 23 },
    "130": { med: 35, sd: 20, n: 23 },
    "133": { med: 35, sd: 19.5, n: 22 },
    "135": { med: 85, sd: 43, n: 23 },
    "136": { med: 30.2, sd: 50.7, n: 23 },
    "138": { med: 55.1, sd: 33.8, n: 22 },
    "139": { med: 77.5, sd: 32.6, n: 16 },
    "140": { med: 35, sd: 20, n: 23 },
  },
  "4": {
    "2": { med: 92.6, sd: 42, n: 0 },
    "10": { med: 432.8, sd: 557.5, n: 0 },
    "13": { med: 65.1, sd: 24.4, n: 0 },
    "14": { med: 40.1, sd: 34.9, n: 0 },
    "20": { med: 65.2, sd: 31.9, n: 0 },
    "21": { med: 70.1, sd: 60, n: 0 },
    "28": { med: 52.6, sd: 16.9, n: 0 },
    "32": { med: 227.6, sd: 62.4, n: 0 },
    "34": { med: 25.1, sd: 20.1, n: 0 },
    "41": { med: 40.1, sd: 35, n: 0 },
    "42": { med: 35.1, sd: 36.5, n: 0 },
    "47": { med: 45, sd: 26.4, n: 0 },
    "53": { med: 60, sd: 85.1, n: 0 },
    "63": { med: 65.1, sd: 33.8, n: 0 },
    "82": { med: 45, sd: 24.5, n: 0 },
    "83": { med: 47.5, sd: 21.5, n: 0 },
    "85": { med: 55, sd: 34.1, n: 0 },
    "86": { med: 92.5, sd: 57.5, n: 0 },
    "88": { med: 60, sd: 25, n: 0 },
    "92": { med: 40, sd: 29.4, n: 0 },
    "93": { med: 60, sd: 34.9, n: 0 },
    "95": { med: 52.6, sd: 32.5, n: 0 },
    "98": { med: 77.6, sd: 144.9, n: 0 },
    "100": { med: 69.8, sd: 61.1, n: 0 },
    "101": { med: 59.8, sd: 45.3, n: 0 },
    "105": { med: 135.1, sd: 43.9, n: 0 },
    "106": { med: 75, sd: 20, n: 0 },
    "116": { med: 345, sd: 728.7, n: 0 },
    "122": { med: 135, sd: 69, n: 0 },
    "129": { med: 150, sd: 34.4, n: 0 },
    "150": { med: 85, sd: 108, n: 0 },
  },
};

/** Named stops, with their index in the route sequence. */
export const STOP = {
  // Blue Weekend ("4") — the near-collision pair.
  broadwayYork: 21,    // idx 22
  stopAndShop: 116,    // idx 23
  elmYorkTyco: 53,     // idx 24
  collegeWallN: 41,    // idx 25
  yorkChapel: 150,     // idx 21
  // Blue Day ("1").
  prospectSachemN: 106, // idx 0
  phelpsGate: 98,       // idx 19
  cedar333: 10,         // idx 24
  york129: 2,           // idx 25
  elmYork: 52,          // idx 27
  peabody: 97,          // idx 16
} as const;

/** A live-feed bus row with sane defaults; override what the test cares about. */
export function makeBus(
  over: Partial<BusData> & Pick<BusData, "route_id" | "lat" | "lon">,
): BusData {
  return {
    bus_id: 1,
    bus_name: "#101",
    heading: 0,
    last_stop_id: 0,
    stationary: false,
    ...over,
  };
}

/** Coordinates of a named stop, for positioning a fixture bus. */
export function at(stopId: number): LatLon {
  const c = stopCoords[stopId];
  if (!c) throw new Error(`fixture has no coords for stop ${stopId}`);
  return c;
}
