import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The API port resolves the same way as server/src/index.ts (CIVICFOLIO_PORT,
// default 8787) so the proxy never drifts from the backend.
const API_PORT = process.env.CIVICFOLIO_PORT || '8787'

// Dev server binds localhost only; /api is proxied to the local backend from
// the same origin (no CORS needed).
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: false,
      },
    },
  },
})