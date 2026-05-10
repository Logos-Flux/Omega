import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// `VITE_BASE_PATH` lets a deploy mount the SPA under a sub-path (e.g.
// `/chat/`) without forking the build. Default `/` matches a root-mounted
// SPA. Trailing slash is required by Vite when set.
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5175,
    host: '0.0.0.0',
    proxy: {
      // Order matters: most-specific prefixes first, since Vite picks the
      // first match. Mirrors apps/chat-frontend/Caddyfile so /api/controller/*
      // is not caught by /api/* and silently routed to chat-api.
      '/api/controller': {
        target: process.env.VITE_CONTROLLER_URL || 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/controller/, ''),
      },
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
