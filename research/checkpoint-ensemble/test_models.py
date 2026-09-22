import datetime as dt
import unittest
from models import Paths,TZ,available,strict,group_prediction,CountdownLatch

class Quality:
    def ok(self,bus,rid,start,end):return end>start

class PathTests(unittest.TestCase):
    def model(self,top,rows,cut):
        occurrences={r['id']:dict(epoch=str((r['bus_name'],r['arrived_at']//86400000)),progress=r['stop_index']) for r in rows}
        return Paths(top,{1:[2]},rows,Quality(),cut,occurrences)
    def setup_data(self):
        top={1:{'stops':list(range(6))}};rows=[];ident=0
        for day in (7,8,9):
            base=int(dt.datetime(2026,9,day,12,tzinfo=TZ).timestamp()*1000)
            for bus in range(5):
                for index in range(4):
                    at=base+bus*1000+index*60000;ident+=1
                    rows.append(dict(id=ident,bus_name=str(bus),bus_id=bus,anchor_bus_id=bus,route_id=1,
                        stop_id=index,stop_index=index,anchored_at=at,pinned_at=at,arrived_at=at,
                        departed_at=at+10000,known_at=at+12000,closest_m=1,outcome='stopped',how='departed'))
        cutoff=int(dt.datetime(2026,9,10,tzinfo=TZ).timestamp()*1000)
        return top,rows,cutoff

    def test_all_offsets_and_joint_same_target(self):
        top,rows,cut=self.setup_data();m=self.model(top,rows,cut)
        for j in (0,1,2):self.assertEqual(len(m.paths[1,j,2,3]),15)
        depart=rows[0]['departed_at'];v=m.joint(1,2,2,3,(0,1,2),depart)
        self.assertTrue(v['supported']);self.assertEqual(v['completeVectors'],15)
        self.assertAlmostEqual(v['ensemble']['q90'],0);self.assertAlmostEqual(v['single']['q90'],0)

    def test_missing_offset_does_not_silently_renormalize(self):
        top,rows,cut=self.setup_data();rows=[r for r in rows if r['id'] not in (2,6,10,14)]
        m=self.model(top,rows,cut);v=m.joint(1,2,2,3,(1,2),rows[0]['departed_at'])
        self.assertEqual(v['completeVectors'],11);self.assertFalse(v['supported'])

    def test_actual_known_at_and_null_pin(self):
        top,rows,cut=self.setup_data();v=rows[0]
        self.assertFalse(available(dict(v,known_at=cut),cut))
        self.assertFalse(strict(dict(v,pinned_at=None),top))
        self.assertFalse(strict(dict(v,anchor_bus_id=99),top))
        self.assertFalse(strict(dict(v,bus_id=None,anchor_bus_id=None),top))

    def test_future_visit_deletion(self):
        top,rows,cut=self.setup_data();late=dict(rows[-1],id=999,known_at=cut+1)
        a=self.model(top,rows+[late],cut);b=self.model(top,rows,cut)
        self.assertEqual(dict(a.paths),dict(b.paths))

    def test_wait_target_overlap_is_not_a_physical_traversal(self):
        top,rows,cut=self.setup_data();rows=rows[:4]
        rows[2]=dict(rows[2],departed_at=rows[3]['departed_at']+1000,known_at=rows[3]['known_at']+1000)
        m=self.model(top,rows,cut)
        self.assertEqual(len(m.paths[1,2,2,3]),0)
        self.assertGreater(m.audit['source wait target temporal overlap'],0)

    def test_unrecorded_full_lap_cannot_join_old_source(self):
        top,rows,cut=self.setup_data();rows=rows[:4]
        proof={r['id']:dict(epoch='one',progress=r['stop_index']+(6 if r['stop_index'] else 0)) for r in rows}
        m=Paths(top,{1:[2]},rows,Quality(),cut,proof)
        self.assertFalse(m.paths[1,2,2,3]);self.assertGreater(m.audit['unwrapped same-traversal proof unavailable'],0)

class GroupTests(unittest.TestCase):
    def setup_group(self):
        class Model:
            top={1:{'stops':list(range(6))}};waits={1:[2]}
            bad=None;remaining=120
            def fit(self,rid,j,w,t,departure):return dict(supported=(j,t)!=self.bad,mean=self.remaining+100-departure/1000)
            def joint(self,*args):return dict(supported=True)
        model=Model();row=dict(route=1,bus='A',asof=100000,at=100000,targetIndex=4)
        sources={str(j):dict(name='A',route=1,index=(2-j)%6,departed=j*1000,knownAt=5000,epoch=1,provider=7) for j in (1,2)}
        membership=dict(supported=True,wait=2,k=2,offsets=[1,2],targetGroup=[3,4,5,0,1],sourceIds={j:str(j) for j in (1,2)},journey='physical-journey',regime='pre-wait')
        return model,row,membership,sources
    def test_whole_group_support_requires_each_offset_and_earlier_target(self):
        model,row,m,sources=self.setup_group();self.assertTrue(group_prediction(model,row,m,sources)['supported'])
        model.bad=(1,3);result=group_prediction(model,row,m,sources)
        self.assertFalse(result['supported']);self.assertEqual(result['unsupportedTarget'],3)
        self.assertEqual(result['reason'],'whole-group constituent support')
    def test_target_outside_group(self):
        model,row,m,sources=self.setup_group();row['targetIndex']=2
        self.assertEqual(group_prediction(model,row,m,sources)['reason'],'target outside fixed downstream group')
    def test_countdown_exact_boundary_and_irreversible_refresh_mask(self):
        model,row,m,sources=self.setup_group();latch=CountdownLatch()
        model.remaining=60.001;self.assertTrue(latch.predict('rolling',2,model,row,m,sources)['supported'])
        model.remaining=60;self.assertFalse(latch.predict('rolling',2,model,row,m,sources)['supported'])
        refreshed,_,_,_=self.setup_group();m=dict(m,offsets=[2],sourceIds={2:'2'},regime='post-wait')
        result=latch.predict('rolling',2,refreshed,row,m,sources)
        self.assertEqual(result['reason'],'whole-group countdown previously expired')
        self.assertTrue(latch.predict('frozen',2,refreshed,row,m,sources)['supported'])

if __name__=='__main__':unittest.main()
