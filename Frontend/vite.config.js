import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Backend runs on 3100 locally (see BackEnd/ecosystem.config.js) — 3000
      // is taken by the wiwynn-rack-monitor frontend dev server.
      '/api': 'http://localhost:3100'
    }
  }
})
