// Workers start independently of a test runner's loader/transform hooks.
import { tsImport } from 'tsx/esm/api';
await tsImport('./calibrationThread.ts', import.meta.url);
