import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@bid/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },

  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    fileParallelism: false,

    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
