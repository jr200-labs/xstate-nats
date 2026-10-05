import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@jr200-labs/xstate-nats': fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['docs/demo/src/**/*.test.ts'], environment: 'node' },
})
