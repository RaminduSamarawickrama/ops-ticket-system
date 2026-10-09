import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In local development the API runs in a separate Node process (scripts/dev-server.ts).
    // xfwd passes the original Host on as X-Forwarded-Host, which the API's same-origin check uses.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', xfwd: true },
    },
  },
});
