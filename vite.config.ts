import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: true, port: 5173, allowedHosts: ['floor.tianye.app'] },
  build: { chunkSizeWarningLimit: 1600 },
});
