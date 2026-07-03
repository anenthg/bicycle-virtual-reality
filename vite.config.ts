import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so a build can be dropped on any static host (or opened locally).
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
