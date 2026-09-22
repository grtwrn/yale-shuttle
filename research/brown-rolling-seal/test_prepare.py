import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('capture_prepare',Path(__file__).with_name('prepare.py'))
p=importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class CaptureTests(unittest.TestCase):
    def fixture(self,directory,rows):
        header=dict(table='raw_positions',day='2026-09-21',from_=p.DAY_START,to=p.CUTOFF,columns=p.COLS,build='fixture')
        header['from']=header.pop('from_')
        trailer=dict(end=True,rows=len(rows))
        body=b''.join(json.dumps(r).encode()+b'\n' for r in [header,*rows,trailer])
        target=Path(directory)/'raw.gz'
        target.write_bytes(gzip.compress(body,mtime=0))
        return target,dict(header=header,trailer=trailer,sha256=p.digest(target),rawSha256=hashlib.sha256(body).hexdigest(),
                           rawBytes=len(body),observedRows=len(rows),transportComplete=True)

    def row(self):
        return dict(id=1,bus_id=2,bus_name='fixture',route_id=19,lat=41.3,lon=-72.9,heading=None,last_stop_id=None,collected_at=p.DAY_START)

    def test_exact_transport_and_optional_null_fields(self):
        with tempfile.TemporaryDirectory() as d:
            file,meta=self.fixture(d,[self.row()])
            self.assertEqual(p.decode_capture(file,meta),[self.row()])

    def test_duplicate_id_future_and_nonfinite_refused(self):
        for rows in ([self.row(),self.row()],[dict(self.row(),collected_at=p.CUTOFF)],[dict(self.row(),lat=float('nan'))]):
            with tempfile.TemporaryDirectory() as d:
                file,meta=self.fixture(d,rows)
                with self.assertRaises(AssertionError):p.decode_capture(file,meta)

    def test_transport_mismatch_refused(self):
        with tempfile.TemporaryDirectory() as d:
            file,meta=self.fixture(d,[self.row()])
            meta['observedRows']=2
            with self.assertRaises(AssertionError):p.decode_capture(file,meta)
            meta['observedRows']=1
            file.write_bytes(file.read_bytes()[:-5])
            with self.assertRaises(AssertionError):p.decode_capture(file,meta)


if __name__=='__main__':unittest.main()
