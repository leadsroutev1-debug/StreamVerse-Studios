import { defineConfig } from 'vite';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Vite config that mounts the Express app from index.js as middleware.
// The Bolt preview system runs `vite` (the dev script), which starts this config,
// making the StreamVerse dashboard available in the preview iframe.
export default defineConfig({
  root: '.',
  server: {
    port: 5173,
    host: '0.0.0.0',
  },
  plugins: [
    {
      name: 'streamverse-express',
      configureServer(server) {
        const { app, bootstrap } = require('./index.js');
        bootstrap();
        server.middlewares.use(app);
      },
      configurePreviewServer(server) {
        const { app, bootstrap } = require('./index.js');
        bootstrap();
        server.middlewares.use(app);
      },
    },
  ],
  optimizeDeps: {
    exclude: ['mysql2', 'sharp', 'node-cron'],
  },
});
