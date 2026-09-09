"""Causal availability and target pairing regression checks; no data scores."""
import importlib.util, pathlib, unittest
spec=importlib.util.spec_from_file_location("operator_compare",pathlib.Path(__file__).with_name("compare-operator.py"))
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class CausalPairing(unittest.TestCase):
    def row(self, at, eta=300, name="#1", calc=None):
        return dict(id=at,sampled_at=at,calc_at=at if calc is None else calc,stop_id=11,route_id=3,bus_name=name,eta_sec=eta)

    def query(self, at=12000):
        return dict(issuedAt=at,stopId=11,routeId=3,busKey="#1",targetArrivalId="next")

    def arrivals(self): return {(3,"#1",11):([500000],[dict(id="next")])}

    def test_request_start_is_not_available(self):
        source,_=m.batches([self.row(10000),self.row(13000)])
        self.assertEqual(m.source_for(self.query(),source,self.arrivals(),30,False)[1],"noAvailableResponse")
        s,_=m.source_for(self.query(13000),source,self.arrivals(),30,False)
        self.assertEqual(s["pointSec"],297)

    def test_new_response_omission_supersedes_older_bus(self):
        source,_=m.batches([self.row(10000),self.row(13000,name=None),self.row(16000)])
        self.assertEqual(m.source_for(self.query(16000),source,self.arrivals(),30,False)[1],"busAbsentLatestResponse")

    def test_calculation_after_start_but_before_availability_is_allowed(self):
        source,_=m.batches([self.row(10000,calc=11000),self.row(13000)])
        s,_=m.source_for(self.query(13000),source,self.arrivals(),30,False)
        self.assertEqual(s["pointSec"],298)

    def test_calculation_after_availability_is_invalid(self):
        source,_=m.batches([self.row(10000,calc=14000),self.row(13000)])
        self.assertEqual(m.source_for(self.query(15000),source,self.arrivals(),30,False)[1],"invalidCalculationClock")

    def test_intervening_previous_occurrence_rejected(self):
        source,_=m.batches([self.row(10000),self.row(13000)])
        arrivals={(3,"#1",11):([11000,500000],[dict(id="previous"),dict(id="next")])}
        self.assertEqual(m.source_for(self.query(13000),source,arrivals,30,False)[1],"differentPhysicalOccurrence")

    def test_clock_reversal_fails_closed(self):
        with self.assertRaises(ValueError): m.batches([self.row(10000),self.row(9000)])

    def test_equal_arrival_scoring_does_not_weight_long_capture_more(self):
        rows=[]
        for target,n,err in [("short",1,10),("long",10,100)]:
            rows.extend(dict(targetArrivalId=target,day="d",busKey="#1",actualSec=100,pointsSec=dict(baseline=100+err,selected=100,operator=100)) for _ in range(n))
        self.assertEqual(m.score(rows,0)["equalArrival"]["baseline"]["maeSec"],55)


if __name__=="__main__": unittest.main()
