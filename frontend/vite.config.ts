import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Forward /api/* to the dev backend (server.mjs), which talks to Tavus
    // server-side so the browser never sees TAVUS_API_KEY.
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.FRONTEND_BACKEND_PORT || '8788'}`,
        changeOrigin: true,
      },
    },
  },
})
