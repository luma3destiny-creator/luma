import { build } from 'esbuild';
await build({ entryPoints: ['tests/membership/workerd/worker.mjs'], bundle: true,
  format: 'esm', platform: 'browser', outfile: 'outputs/membership-worker.mjs' });
