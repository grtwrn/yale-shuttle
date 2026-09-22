"""Apply the identical highway edge clause to the unchanged action replay."""
import collections
import json
from pathlib import Path
import sys
import policy as hp

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'useful-windows'))
import rider_risk as risk
OriginalConnectivity=risk.Connectivity
OUT=HERE/'results'


def raw_point(bus,p):
    return dict(bus_name=bus,collected_at=p[0],lat=p[1],lon=p[2],route_id=p[3],bus_id=p[4])


def connectivity_factory(policy,clause,collector):
    class Connectivity(OriginalConnectivity):
        def __init__(self,path,buses):
            super().__init__(path,buses)
            original=object.__new__(OriginalConnectivity);original.data=self.data;original.invalid=self.invalid
            self.original=original;self.calls=collections.Counter();self.additions=[]
            pairs=[]
            for bus,(_,points,_) in self.data.items():
                pairs.extend((raw_point(bus,a),raw_point(bus,b)) for a,b in zip(points,points[1:]))
            if policy!='original22':clause.prepare(pairs)
            updated={}
            for bus,(times,points,_) in self.data.items():
                bad=[0]
                for a,b in zip(points,points[1:]):
                    ra,rb=raw_point(bus,a),raw_point(bus,b)
                    elapsed,metres,_=hp.diag.edge(ra,rb)
                    permit=clause.permitted(ra,rb,policy)
                    identity_change=a[4] is not None and b[4] is not None and a[4]!=b[4]
                    broken=(elapsed<=0 or elapsed*1000>risk.MAX_RAW_GAP_MS
                        or (metres/max(.001,elapsed)>22 and not permit) or a[3]!=b[3] or identity_change)
                    bad.append(bad[-1]+int(broken))
                updated[bus]=(times,points,bad)
            self.data=updated
            if policy=='original22':assert self.data==self.original.data
            collector.append(self)

        def reason(self,bus,route,start,end):
            original=self.original.reason(bus,route,start,end)
            result=super().reason(bus,route,start,end)
            self.calls['checks']+=1
            if original is None:assert result is None
            if route not in hp.TRANSFER:assert result==original
            if original is not None and result is None:
                assert original=='raw-gap-identity-route-or-speed-break'
                self.additions.append(dict(bus=bus,route=route,start=start,end=end,originalReason=original))
            return result
    return Connectivity


def main():
    clause=hp.HighwayClause()
    for policy in hp.POLICIES:
        for cohort in ('all','original-cohort'):
            if policy=='original22' and cohort=='original-cohort':continue
            directory=OUT/policy if cohort=='all' else OUT/policy/cohort
            instances=[];risk.Connectivity=connectivity_factory(policy,clause,instances)
            risk.run(directory,directory/'rider-risk')
            result=json.loads((directory/'rider-risk/rider-risk-summary.json').read_text())
            if policy=='original22':
                expected=json.loads((hp.diag.study.OUT/'rider-risk/rider-risk-summary.json').read_text())
                assert result==expected, 'original action replay changed'
            audit=dict(policy=policy,cohort=cohort,calls=sum(i.calls['checks'] for i in instances),
                admittedOnlyByHighway=[row for i in instances for row in i.additions],unchangedActionRules=True)
            (directory/'rider-risk/quality-audit.json').write_text(json.dumps(audit,indent=2))


if __name__=='__main__':main()
