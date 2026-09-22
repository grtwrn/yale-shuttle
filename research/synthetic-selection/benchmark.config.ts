export default {test:{include:['../../research/synthetic-selection/benchmark.worker.ts'],environment:'node',
  fileParallelism:false,pool:'forks',poolOptions:{forks:{singleFork:true}},maxWorkers:1,minWorkers:1,
  reporters:['default'],testTimeout:5_000_000},esbuild:{jsx:'automatic'}};
