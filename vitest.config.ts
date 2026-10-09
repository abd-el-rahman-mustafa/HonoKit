import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@engine': resolve('src/engine'),
      '@ops': resolve('src/ops')
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // WASM start-up and large fixtures make the first test in a file slow.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks'
  }
})
