import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: '.',
  server: {
    port: 5199,
    fs: {
      // Allow serving files from the repo root (for assets)
      allow: [
        path.resolve(__dirname, '../../..'),
      ],
    },
  },
  optimizeDeps: {
    // Don't scan the cloned reference repo
    exclude: [],
    entries: ['src/main.js'],
  },
  resolve: {
    alias: {
      '@assets': path.resolve(__dirname, '../../../assets'),
    },
  },
});
