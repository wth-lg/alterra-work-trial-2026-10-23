import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { copyDataPlugin } from './build/copy-data.ts';

// The CSP meta in each page blocks the inline scripts and styles the dev server injects
// for HMR, so it is removed in `vite dev` only. Built pages keep it.
function stripCspInDev(): Plugin {
  return {
    name: 'strip-csp-in-dev',
    apply: 'serve',
    transformIndexHtml: (html) => html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, ''),
  };
}

export default defineConfig({
  base: '/alterra-work-trial-2026-10-23/',
  plugins: [react(), tailwindcss(), stripCspInDev(), copyDataPlugin()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        harness: resolve(import.meta.dirname, 'harness.html'),
        probe: resolve(import.meta.dirname, 'probe.html'),
      },
    },
  },
});
