import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const service=process.cwd(), out='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/ux-09';
const require=createRequire(service+'/web/package.json');
const {build}=await import(require.resolve('vite'));
const main=await fs.readFile(out+'/baseline-main.tsx','utf8');
await build({root:service+'/web',configFile:service+'/web/vite.config.ts',plugins:[{name:'preserved-baseline-entry',enforce:'pre',load(id){if(id===service+'/web/src/main.tsx')return main;}}],build:{outDir:out+'/baseline-dist',emptyOutDir:false}});
