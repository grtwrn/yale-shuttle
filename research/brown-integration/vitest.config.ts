import {fileURLToPath} from 'node:url';
export default {test:{include:['./integration.test.ts','./sealed.test.ts'].map(p=>fileURLToPath(new URL(p,import.meta.url))),environment:'node',
  fileParallelism:false,testTimeout:120000,reporters:['default','json'],
  outputFile:{json:fileURLToPath(new URL('./results/tests.json',import.meta.url))}},esbuild:{jsx:'automatic'}};
