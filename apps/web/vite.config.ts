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

// harness.html and probe.html are test pages: `pnpm build` builds them for the e2e runs, and
// the Pages build (`--mode pages`, .github/workflows/pages.yml) leaves them out of the artifact.
export default defineConfig(({ mode }) => ({
  base: '/clinical-agent-env/',
  plugins: [react(), tailwindcss(), stripCspInDev(), copyDataPlugin()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        ...(mode === 'pages'
          ? {}
          : { harness: resolve(import.meta.dirname, 'harness.html'), probe: resolve(import.meta.dirname, 'probe.html') }),
      },
    },
  },
}));
