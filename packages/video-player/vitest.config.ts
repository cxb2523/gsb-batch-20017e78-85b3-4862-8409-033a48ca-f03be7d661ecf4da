import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
    // `forks` workers fail to boot under Yarn's Windows shell in this repo; threads are
    // lighter and sufficient for these DOM-level tests.
    pool: 'threads',
  },
});
