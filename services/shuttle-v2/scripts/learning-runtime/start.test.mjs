import { expect, it } from 'vitest';
import { containerArguments } from './start.mjs';
import { FORECAST_RUNTIME } from '../learning-loop/runtime-policy.mjs';

it('keeps application source and credentials read-only while isolating Linux dependencies and writable scientific evidence',()=>{
 const args=containerArguments({owner:{id:'owner'},service:'/source',root:'/evidence',archive:'/archive',token:'/credential',base:'https://example.test',publish:'1'});
 const mounts=args.flatMap((v,i)=>v==='--mount'?[args[i+1]]:[]);
 expect(mounts).toContain('type=bind,source=/source,target=/source,readonly');
 expect(mounts).toContain('type=bind,source=/credential,target=/credential,readonly');
 expect(mounts).toContain('type=bind,source=/archive,target=/archive,readonly');
 expect(mounts).toContain('type=bind,source=/evidence,target=/evidence');
 expect(mounts).toContain('type=volume,source=yale-shuttle-eval-node-modules,target=/source/node_modules');
 expect(args).toContain(FORECAST_RUNTIME.image);
 expect(args).toContain('LEARNING_RUNTIME_OWNER_ID=owner');
 expect(args.at(-1)).toBe('/source/scripts/learning-loop/start.ts');
 expect(args.some(x=>x.startsWith('SHUTTLE_ADMIN_TOKEN='))).toBe(false);
 expect(args).not.toContain('--once');
});
