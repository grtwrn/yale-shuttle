import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const service=path.resolve(path.dirname(new URL(import.meta.url).pathname),'../..');
const tokenFile=process.env.SHUTTLE_ADMIN_TOKEN_FILE??path.join(process.env.HOME,'.config/yale-shuttle/admin-token');
const env={...process.env,SHUTTLE_ADMIN_TOKEN:process.env.SHUTTLE_ADMIN_TOKEN??fs.readFileSync(tokenFile,'utf8').trim(),TZ:'America/New_York'};
const run=spawnSync(process.execPath,[path.join(service,'scripts/archive-day.mjs'),...process.argv.slice(2)],{cwd:service,env,stdio:'inherit'});
process.exit(run.status??1);
