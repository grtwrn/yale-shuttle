import {fileURLToPath} from 'node:url';
export default {test:{include:[fileURLToPath(new URL('./integration.test.ts',import.meta.url))],environment:'node',
  fileParallelism:false,testTimeout:120000,reporters:['default','json'],
  outputFile:{json:fileURLToPath(new URL('./results/tests.json',import.meta.url))}},esbuild:{jsx:'automatic'}};
