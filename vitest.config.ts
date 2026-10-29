import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/helpers/globalSetup.ts'],
    setupFiles: ['tests/helpers/setup.ts'],
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
