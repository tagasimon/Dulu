import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    // In dev, the multiplayer server runs separately (npm run dev:server).
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
