import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// base: '' makes the built asset paths relative, so the same build works at
// https://user.github.io/repo/ and at any other sub-path without edits.
export default defineConfig({
  base: '',
  plugins: [
    nodePolyfills({
      // GramJS reaches for these Node built-ins; the polyfills let it run
      // unchanged in the browser.
      include: ['buffer', 'crypto', 'stream', 'util', 'process', 'path', 'events'],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 4000,
  },
});
