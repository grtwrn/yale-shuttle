export default { test: {
  include: ['../../research/synthetic-selection/*.test.ts'],
  environment: 'node', fileParallelism: false, reporters: ['default','json'],
  outputFile: {json:'../../research/synthetic-selection/results/fixtures.json'},
}, esbuild:{jsx:'automatic'} };
