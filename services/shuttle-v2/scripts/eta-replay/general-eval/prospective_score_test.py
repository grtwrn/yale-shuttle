import importlib.util, pathlib, unittest

FILE = pathlib.Path(__file__).with_name("prospective-score.py")
spec = importlib.util.spec_from_file_location("prospective", FILE)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class Served:
    def classify(self,row):
        return {"servedRoutePatternId":"1:pattern","servedStopIndex":0,"servedOccurrencesAhead":1},None


def query(t=10_000,arm=module.ARMS[0]):
    return {"arm":arm,"routeId":1,"routePatternId":"1:pattern","busKey":"bus","stopId":1,"stopIndex":0,
            "day":"2026-09-09","issuedAt":t,"recordedAt":t+1,"fixAt":t-100,"tableSha":"table","servedContextSha":"wire",
            "quantileLevels":[.1,.5,.9],"quantilesSec":[20.,40.,60.],"elapsedSec":t/1000,
            "shown":{"remaining":True,"sec":40.,"typicalSec":50.}}


def source(row):
    return {"fixAt":row["fixAt"],"tableSha":"table","servedContextSha":"wire","futureContextClock":False,
            "stableGeometry":True,"routePatternId":"1:pattern","contextPresent":True,"lat":41.,"lon":-72.,"appendUpperBoundAt":row["issuedAt"]+5000}


class ProspectiveScoring(unittest.TestCase):
    def test_exact_input_provenance_and_future_context(self):
        row=query(arm=module.ARMS[1]); key=module.issue_key(row); inputs={key:source(row)}
        self.assertIsNone(module.integrity(row,inputs))
        inputs[key]["futureContextClock"]=True
        self.assertEqual(module.integrity(row,inputs),"futureContextClock")
        inputs[key]["futureContextClock"]=False; row["servedContextSha"]="different"
        self.assertEqual(module.integrity(row,inputs),"servedWireHashMismatch")

    def test_continuity_and_recording_time_exclusions(self):
        rows=[query(arm=a) for a in module.ARMS]; inputs={module.issue_key(rows[0]):source(rows[0])}
        target={"id":"arrival","routeId":1,"busKey":"bus","stopId":1,"arrivedAt":50_000,"trackStartAt":20_000}
        _,_,coverage=module.pair_forecasts(rows,inputs,[target],Served(),{1:{"lat":41.01,"lon":-72.}})
        self.assertEqual(coverage[module.ARMS[0]]["captureGapBeforeTarget"],1)
        target["trackStartAt"]=0
        for r in rows:r["recordedAt"]=50_000
        _,_,coverage=module.pair_forecasts(rows,inputs,[target],Served(),{1:{"lat":41.01,"lon":-72.}})
        self.assertEqual(coverage[module.ARMS[0]]["recordedAfterTarget"],1)

    def test_outcome_absence_is_censoring_and_current_radius_exclusion(self):
        row=query(); inputs={module.issue_key(row):source(row)}
        _,_,coverage=module.pair_forecasts([row],inputs,[],Served(),{1:{"lat":41.01,"lon":-72.}})
        self.assertEqual(coverage[module.ARMS[0]]["noObservedFutureTargetRightCensored"],1)
        _,_,coverage=module.pair_forecasts([row],inputs,[],Served(),{1:{"lat":41.,"lon":-72.}})
        self.assertEqual(coverage[module.ARMS[0]]["alreadyWithin50m"],1)

    def test_computation_timestamp_does_not_claim_append_before_target(self):
        row=query(); inputs={module.issue_key(row):source(row)}
        target={"id":"arrival","routeId":1,"busKey":"bus","stopId":1,"arrivedAt":12_000,"trackStartAt":0}
        _,_,coverage=module.pair_forecasts([row],inputs,[target],Served(),{1:{"lat":41.01,"lon":-72.}})
        self.assertEqual(coverage[module.ARMS[0]]["unprovenAppendBeforeTarget"],1)

    def test_physical_target_pairs_and_negative_published_lower_bound(self):
        rows=[query(arm=a) for a in module.ARMS]; rows[0]["quantilesSec"][0]=-5
        inputs={module.issue_key(rows[0]):source(rows[0])}
        target={"id":"arrival","routeId":1,"busKey":"bus","stopId":1,"arrivedAt":50_000,"trackStartAt":0}
        pairs,_,_=module.pair_forecasts(rows,inputs,[target],Served(),{1:{"lat":41.01,"lon":-72.}})
        self.assertEqual(len(pairs),1); self.assertEqual(pairs[0][0]["actualSec"],40.)
        self.assertEqual(pairs[0][0]["quantilesSec"][0],-5)

    def test_first_display_is_not_replaced_by_later_shared_query(self):
        rows=[query(10_000,module.ARMS[0]),query(20_000,module.ARMS[1])]+[query(30_000,a) for a in module.ARMS]
        inputs={module.issue_key(r):source(r) for r in rows}
        label={"id":"visit","day":"2026-09-09","routeId":1,"routePatternId":"1:pattern","busKey":"bus","stopId":1,
               "stopIndex":0,"canonicalStopIds":[1],"labelStatus":"complete","outcome":"stopped","pinnedAt":0,"departedAt":100_000}
        result,_=module.paired_stands(rows,inputs,{"visit":label},0)
        self.assertEqual(result["pairedMoments"],1)
        self.assertEqual(result["pairedOriginalFirstDisplays"],0)

    def test_invalid_original_first_cannot_promote_later_first(self):
        rows=[query(t,a) for t in (10_000,30_000) for a in module.ARMS]
        rows[1]["servedContextSha"]="bad"
        inputs={module.issue_key(r):source(r) for r in rows}
        label={"id":"visit","day":"2026-09-09","routeId":1,"routePatternId":"1:pattern","busKey":"bus","stopId":1,
               "stopIndex":0,"canonicalStopIds":[1],"labelStatus":"complete","outcome":"stopped","pinnedAt":0,"departedAt":100_000}
        result,_=module.paired_stands(rows,inputs,{"visit":label},0)
        self.assertEqual(result["pairedMoments"],1)
        self.assertEqual(result["pairedOriginalFirstDisplays"],0)


if __name__=="__main__":unittest.main()
