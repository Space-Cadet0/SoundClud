import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup/offlineNetworkGuard.ts'],
    testTimeout: 5_000,
    hookTimeout: 5_000,
    teardownTimeout: 5_000,
    clearMocks: true,
    restoreMocks: true,
  },
});
