import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    env: {
      VITE_PROXY_URL: 'http://localhost:8787',
      VITE_PROXY_API_KEY: 'test-key',
    },
  },
})
