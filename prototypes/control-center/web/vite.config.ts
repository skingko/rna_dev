import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// The daemon only admits Host 127.0.0.1:<port> and same-origin requests, so the
// dev proxy rewrites Host and strips Origin. Point RNA_DAEMON at a scratch
// daemon (never the production one on 4317) when developing against a backend.
const daemon = process.env.RNA_DAEMON ?? 'http://127.0.0.1:4399'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    // Long-lived vendor chunks cache across UI releases (assets are immutable).
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler|zustand|use-sync-external-store)[\\/]/, priority: 30 },
            { name: 'motion', test: /node_modules[\\/](motion|framer-motion|motion-dom|motion-utils|gsap)[\\/]/, priority: 25 },
            { name: 'radix', test: /node_modules[\\/](radix-ui|@radix-ui|@floating-ui|react-remove-scroll[\w-]*|aria-hidden|use-callback-ref|use-sidecar|tslib)[\\/]/, priority: 20 },
            { name: 'markdown', test: /node_modules[\\/](react-markdown|remark-[\w-]+|remend|marked|micromark[\w-]*|mdast-[\w-]+|hast-[\w-]+|unified|unist-[\w-]+|vfile[\w-]*|property-information|space-separated-tokens|comma-separated-tokens|html-url-attributes|decode-named-character-reference|character-entities[\w-]*|devlop|bail|trough|is-plain-obj|ccount|escape-string-regexp|markdown-table|longest-streak|zwitch|trim-lines|estree-util-is-identifier-name|style-to-js|style-to-object|inline-style-parser)[\\/]/, priority: 15 },
          ],
        },
      },
    },
  },
  server: {
    port: 4391,
    strictPort: true,
    host: '127.0.0.1',
    fs: { allow: ['..'] },
    // Native fs events miss rewrites in this non-ASCII path; poll instead.
    watch: process.env.VITE_POLL ? { usePolling: true, interval: 250 } : undefined,
    proxy: {
      '/api': {
        target: daemon,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => { req.removeHeader('origin'); req.removeHeader('sec-fetch-site') })
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.ts'], // .spec so the host's node --test glob skips them
    setupFiles: ['src/vitest-setup.ts'],
  },
} as import('vite').UserConfig)
