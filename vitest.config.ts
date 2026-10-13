import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'tests/unit/**/*.test.ts'],

    testTimeout: 10_000
  },
});
