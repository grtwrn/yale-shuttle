"""Add the repository-ready test to the runtime virtual manifest."""
from pathlib import Path
import difflib,hashlib,json
O=Path(__file__).resolve().parent
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17')
test=O/'livePickupSelection.test.ts';m=json.loads((O/'overlay.json').read_text())
m[str(repo/'services/shuttle-v2/web/src/livePickupSelection.test.ts')]={'artifact':str(test),'sha256':hashlib.sha256(test.read_bytes()).hexdigest()}
(O/'overlay.json').write_text(json.dumps(m,indent=2)+'\n')
(O/'eta-tests.patch').write_text(''.join(difflib.unified_diff([],test.read_text().splitlines(True),fromfile='/dev/null',tofile='b/services/shuttle-v2/web/src/livePickupSelection.test.ts')))
print('Virtual test path and repository-ready test patch prepared')
