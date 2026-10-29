import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` serves the UI on 5173 and forwards /api to the Node server, so
// the browser sees one origin and the session cookie behaves exactly as it
// does in production. `npm run build` emits dist/, which server.js serves.
export default defineConfig({
  // Relative asset urls: aislop.cloud serves each project from a path prefix
  // (/spriteforge/), not the domain root, so absolute /assets/… would 404.
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.API_PORT || 5180}`,
        changeOrigin: false   // keep Host intact; the server checks nothing else
      }
    }
  },
  build: { outDir: 'dist', emptyOutDir: true }
});
