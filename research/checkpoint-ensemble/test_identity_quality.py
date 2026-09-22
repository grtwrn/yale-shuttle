import unittest
from identity_quality import IdentityQuality
class Base:
    def ok(self,*args):return True
class IdentityTests(unittest.TestCase):
    def test_sequential_rename_return(self):
        raw=[dict(collected_at=t,bus_id=1,bus_name=n) for t,n in ((10,'A'),(20,'B'),(30,'A'))]
        q=IdentityQuality(Base(),raw,40)
        self.assertFalse(q.ok('A',1,10,35));self.assertFalse(q.ok('B',1,19,31));self.assertTrue(q.ok('A',1,31,35))
    def test_simultaneous_contention(self):
        raw=[dict(collected_at=10,bus_id=1,bus_name='A'),dict(collected_at=10,bus_id=2,bus_name='A')]
        self.assertFalse(IdentityQuality(Base(),raw,20).ok('A',1,10,15))
    def test_prefix_rebuild(self):
        raw=[dict(collected_at=t,bus_id=1,bus_name=n) for t,n in ((10,'A'),(20,'B'),(30,'A'))]
        q=IdentityQuality(Base(),raw[:2],25);self.assertEqual(q.events,[('A',20),('B',20)])
        with self.assertRaises(AssertionError):IdentityQuality(Base(),raw,25)
if __name__=='__main__':unittest.main()
