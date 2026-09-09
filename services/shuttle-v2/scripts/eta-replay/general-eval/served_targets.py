"""Corroborate geographic crossings with recorded served-visit occurrences.

This is a scoring-only label adapter. Never expose its future visits/ranks to a
forecasting model. The independent 50m GPS crossing remains the target clock.
"""
import bisect, collections
from inventory import lines

PAD_MS = 30_000
MAX_SERVED_AHEAD = 5

class ServedTargets:
    def __init__(self, dataset, day):
        episodes = list(lines(dataset / day / "episodes.jsonl.gz"))
        physical = list(lines(dataset / day / "physical-arrivals.jsonl.gz"))
        self.groups = collections.defaultdict(list)
        by_stop = collections.defaultdict(list)
        for e in episodes:
            self.groups[e["routeId"], e["busKey"]].append(e)
            by_stop[e["routeId"], e["busKey"], e["stopId"]].append(e)
        self.ordinals = {}; self.anchors = {}
        for key, group in self.groups.items():
            group.sort(key=lambda e: (e["anchoredAt"], e["id"]))
            self.anchors[key] = [e["anchoredAt"] for e in group]
            for i, e in enumerate(group): self.ordinals[e["id"]] = i
        self.by_target = {}; self.by_visit = {}; self.counts = collections.Counter(); candidates = []
        for a in physical:
            valid = []
            for e in by_stop[a["routeId"], a["busKey"], a["stopId"]]:
                end = max(x for x in (e["anchoredAt"], e["pinnedAt"], e["arrivedAt"], e["departedAt"]) if x is not None)
                if e["anchoredAt"] - PAD_MS <= a["arrivedAt"] <= end + PAD_MS: valid.append(e)
            if len(valid) != 1:
                self.counts["unmatchedPhysicalTargets" if not valid else "ambiguousVisitPhysicalTargets"] += 1; continue
            candidates.append((a, valid[0]))
        for a, e in sorted(candidates, key=lambda p: (p[0]["arrivedAt"], p[0]["id"])):
            if e["id"] in self.by_visit:
                self.counts["laterCrossingSameVisit"] += 1; continue
            label = {**a, "servedVisitId": e["id"], "servedOrdinal": self.ordinals[e["id"]],
                     "servedStopIndex": e["stopIndex"], "servedRoutePatternId": e["routePatternId"], "patternResolved": e["patternResolved"]}
            self.by_target[a["id"]] = label; self.by_visit[e["id"]] = label
            self.counts["corroboratedPhysicalTargets"] += 1

    def classify(self, row):
        label = self.by_target.get(row["targetArrivalId"])
        if not label: return None, "notCorroboratedServedTarget"
        t = row["issuedAt"]
        if t < label["trackStartAt"]: return None, "captureGapBeforeTarget"
        key = row["routeId"], row["busKey"]; group = self.groups[key]
        current = bisect.bisect_right(self.anchors[key], t) - 1
        first_future = max(0, current)
        if current >= 0:
            visit = group[current]; crossing = self.by_visit.get(visit["id"])
            arrived = crossing["arrivedAt"] if crossing else (visit["arrivedAt"] or visit["pinnedAt"] or visit["anchoredAt"])
            if arrived <= t or (visit["departedAt"] is not None and visit["departedAt"] <= t): first_future = current + 1
        ahead = label["servedOrdinal"] - first_future + 1
        if ahead < 1: return None, "servedOccurrenceAlreadyArrived"
        if ahead > MAX_SERVED_AHEAD: return None, "beyondNextFiveServedOccurrences"
        return {**label, "servedOccurrencesAhead": ahead}, None

    def policy(self):
        return {"clock": "independent first50m GPS crossing", "visitCorroboration": "same bus/route/stop and anchoredAt−30s through physical episode end+30s",
                "oneTargetPerVisit": "retain earliest uniquely associated crossing; reject later recrossings and ambiguous associations",
                "horizon": "next1..5 actual served visit occurrences, <=30min, on same continuous GPS track",
                "cohortUsesLabelsOnly": True, "counts": dict(self.counts)}
