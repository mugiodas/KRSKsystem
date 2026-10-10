import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    server: { deps: { external: ['node:sqlite'] } },
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 20_000,
    coverage: { reporter: ['text', 'html'] },
  },
});
