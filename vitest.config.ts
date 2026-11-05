import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Rendering tests trace thousands of rays, which coverage instrumentation slows down a lot.
    testTimeout: 120000,
    coverage: {
      include: ['src/**/*.ts'],
    },
  },
});
