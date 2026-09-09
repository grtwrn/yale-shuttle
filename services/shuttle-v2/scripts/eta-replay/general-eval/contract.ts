/** Offline evaluation data only. Outcomes must never be used as current-visit features. */
export type Split = "train" | "validation" | "regression" | "reserved_confirmation" | "reserved_partial";

export interface Episode {
  id: string;
  routeId: number;
  routePatternId: string;
  stopId: number;
  /** Canonical occurrence in the route sequence: repeated stop IDs are distinct. */
  stopIndex: number;
  busKey: string;
  busId: number;
  day: string;
  split: Split;
  patternResolved: boolean;
  anchoredAt: number;
  pinnedAt: number | null;
  arrivedAt: number | null;
  departedAt: number | null;
  outcome: string;
  /** Conservative proxy; historical database insertion timestamps were not recorded. */
  knownAt: number | null;
  availabilityKind: "two_subsequent_anchors_plus_120s" | "archive_observed_by" | "unresolved";
  observedBy: number;
  nextStopId: number | null;
  nextStopIndex: number | null;
  /** Independent first 50m GPS crossing, including passes, with bounded observation gap. */
  nextPhysicalArrivalAt: number | null;
  nextPhysicalArrivalKnownAt: number | null;
  nextPhysicalArrivalId: string | null;
  /** Null targets are retained, not silently treated as zero or a later lap. */
  targetCensoring: "observed" | "no_departure" | "no_geometry" | "no_observed_crossing";
  sourceVisitId: number;
}

export interface Position {
  bus_id: number;
  bus_name: string;
  route_id: number;
  lat: number;
  lon: number;
  heading: number | null;
  last_stop_id: number | null;
  collected_at: number;
}

export interface PhysicalArrival {
  id: string;
  routeId: number;
  routePatternId: string;
  busKey: string;
  day: string;
  stopId: number;
  /** A proximity crossing cannot by itself resolve repeated sequence occurrences. */
  stopIndices: number[];
  arrivedAt: number;
  knownAt: number;
  lowerBoundAt: number;
  upperBoundAt: number;
  gapMs: number;
  /** Query must be at or after this clock, or an earlier missed arrival is possible. */
  trackStartAt: number;
  trackSegmentId: string;
  radiusM: 50;
}

/** A common scored forecast; positive error means the forecast gave the rider too much time. */
export interface Forecast {
  id: string;
  episodeId: string;
  issuedAt: number;
  routeId: number;
  routePatternId: string;
  stopId: number;
  stopIndex: number;
  busKey: string;
  targetArrivalId: string;
  targetArrivalAt: number;
  quantileLevels: readonly number[];
  quantilesSec: readonly number[];
}

/** Common input to score.py, for departure components or full future arrivals. */
export interface ScoredForecast {
  id: string;
  episodeId: string;
  issuedAt: number;
  day: string;
  routeId: number;
  routePatternId: string;
  busKey: string;
  stopId: number;
  stopIndex: number;
  target: "departure" | "physical_arrival";
  targetAt: number;
  actualSec: number;
  quantileLevels: readonly number[];
  quantilesSec: readonly number[];
}
