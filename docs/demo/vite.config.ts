import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  resolve: {
    alias: {
      '@jr200-labs/xstate-nats': fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
    },
  },
  build: { outDir: '../demo-assets', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 3001 },
})
