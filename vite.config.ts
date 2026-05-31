import { defineConfig } from 'vite';

// `VITE_BASE` is set to "/tag-pdf-fixer/" by the GitHub Pages workflow; defaults
// to "/" for local dev.
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  // mupdf-wasm uses top-level await — needs a modern target.
  build: { target: 'esnext' },
  esbuild: { target: 'esnext' },
  optimizeDeps: { exclude: ['mupdf'], esbuildOptions: { target: 'esnext' } },
  worker: { format: 'es' },
});
