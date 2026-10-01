import path from 'node:path';
import { createRequire } from 'node:module';
const service = process.cwd();
const require = createRequire(service + '/package.json');
const root = path.dirname(new URL(import.meta.url).pathname);
export default {
  root, cacheDir: root + '/vite-cache',
  resolve: { alias: [
    { find: 'vitest', replacement: path.dirname(require.resolve('vitest/package.json')) + '/dist/index.js' },
    ...['planner', 'arrivals', 'journeyArrival'].map(name => ({
      find: './' + name, replacement: service + '/web/src/' + name + '.ts',
    })),
  ] },
  test: { include: ['livePickupSelection.test.ts'], pool: 'forks', maxWorkers: 1, minWorkers: 1 },
};
