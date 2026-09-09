/** Read-only operator evidence. Times are epoch milliseconds; durations are seconds. */
export interface StopDataSelection {
  day: string;
  routeId: number;
  stopId: number;
  /** Zero-based position in the detector's route sequence, never just a stop id. */
  stopIndex: number;
}

export interface StopDataPrediction {
  model: string;
  issuedAt: number;
  target: "departure" | "physical_arrival";
  targetStopId: number | null;
  predictedTotalSec: number | null;
  predictedRemainingSec: number | null;
  actualRemainingSec: number | null;
}

export interface StopDataVisit {
  id: string;
  day: string;
  routeId: number;
  stopId: number;
  stopIndex: number;
  busId: number;
  busKey: string;
  busName: string;
  anchoredAt: number;
  pinnedAt: number | null;
  recordedPinnedAt: number | null;
  arrivedAt: number | null;
  departedAt: number | null;
  /** Stored detector duration on arrivedAt; not the client pinned clock. */
  recordedStandSec: number | null;
  /** Departure minus pinnedAt, only for a completed stopped visit. */
  pinnedStandSec: number | null;
  outcome: string;
  how: string | null;
  confidence: number | null;
  qualityNotes: string[];
  /** Earlier departure from this same occurrence and bus on this ET day. */
  previousDepartureAt: number | null;
  /** Posthoc observed departure-to-departure interval; never a prediction. */
  loopSec: number | null;
  predictions?: StopDataPrediction[];
}

export interface StopDataStop {
  stopId: number;
  stopIndex: number;
  name: string;
  lat: number | null;
  lon: number | null;
  visitCount: number;
  /** Current topology cannot certify the topology at the historical visit. */
  currentTopologyMatch: boolean;
}

export interface StopDataCatalog {
  schemaVersion: 1;
  source: "retained_database" | "saved_study";
  generatedAt: number;
  timezone: "America/New_York";
  days: { day: string; visitCount: number }[];
  routes: { routeId: number; name: string; shortName: string; occurrences: StopDataStop[] }[];
  availability: {
    visitsFrom: number | null;
    visitsTo: number | null;
    positionsFrom: number | null;
    positionsTo: number | null;
  };
  limits: { catalogDays: number; visits: number; positions: number; positionWindowHours: number };
  warnings: string[];
}

export interface StopDataDay {
  schemaVersion: 1;
  source: "retained_database" | "saved_study";
  selection: StopDataSelection;
  dayStartAt: number;
  dayEndAt: number;
  visits: StopDataVisit[];
  totalVisits: number;
  truncated: boolean;
  warnings: string[];
}

export interface StopDataPosition {
  at: number;
  lat: number;
  lon: number;
  busId: number;
  distanceM: number | null;
  /** Null for the first point, not zero. */
  gapSec: number | null;
}

export interface StopDataDetail {
  schemaVersion: 1;
  source: "retained_database" | "saved_study";
  visit: StopDataVisit;
  stop: { stopId: number; name: string; lat: number | null; lon: number | null };
  positions: StopDataPosition[];
  coverage: {
    requestedFrom: number;
    requestedTo: number;
    actualFrom: number | null;
    actualTo: number | null;
    missingBefore: boolean;
    missingAfter: boolean;
    maxGapSec: number | null;
    truncated: boolean;
    windowCapped: boolean;
    identityAmbiguous: boolean;
  };
  warnings: string[];
}
