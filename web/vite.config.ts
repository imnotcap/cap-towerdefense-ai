import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // Game assets live at the repo root so the future Rust build can share them.
  publicDir: '../assets',
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
