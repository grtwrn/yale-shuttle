import {test,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('guardian evidence survives rotation, preserves pending incidents, and retries failed captures',()=>{
 const output=execFileSync('python3',['-m','unittest','discover','-s',fileURLToPath(new URL('.',import.meta.url)),'-p','test_*.py','-v'],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
 expect(output).toBe('');
});
