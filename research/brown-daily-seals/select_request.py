"""One append-only request per push; outputs are validated metadata only."""
import os
import subprocess
from contract import *
from sealing import validate_request

require(os.environ.get('GITHUB_ACTIONS')=='true','hosted only')
before,after=os.environ['BEFORE'],os.environ['GITHUB_SHA']
changed=subprocess.check_output(['git','diff','--name-status',before,after,'--','research/brown-daily-seals/requests'],cwd=ROOT,text=True).splitlines()
require(len(changed)==1 and changed[0].startswith('A\t'),'exactly one new immutable request per push')
path=changed[0].split('\t')[1]
require(path.startswith('research/brown-daily-seals/requests/') and path.endswith('.json') and '..' not in Path(path).parts,'request path')
digest=file_sha(ROOT/path);request,config,_=validate_request(ROOT/path,digest,now_ms())
with open(os.environ['GITHUB_OUTPUT'],'a') as output:
    for key,value in {'path':path,'sha256':digest,'day':config['day'],'request_id':request['requestId']}.items():
        require('\n' not in value and '\r' not in value,'output newline');output.write(key+'='+value+'\n')
