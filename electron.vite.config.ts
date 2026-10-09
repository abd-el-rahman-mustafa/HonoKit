import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve('src/shared')

/**
 * The renderer's Content-Security-Policy, added to the built page only: the dev server
 * needs inline scripts and a websocket for hot reload. Pictures come from the page
 * protocol; nothing is ever fetched from the network.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: pdfpage:",
  "font-src 'self'",
  "connect-src 'self' pdfpage:",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'"
].join('; ')

const contentSecurityPolicy = {
  name: 'powerpdf-csp',
  apply: 'build' as const,
  transformIndexHtml(html: string): string {
    return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
  }
}
const alias = { '@shared': shared, '@engine': resolve('src/engine'), '@ops': resolve('src/ops') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      // Two entries: the Electron main process, and the worker it forks for all PDF work.
      rollupOptions: { input: { index: resolve('src/main/index.ts'), worker: resolve('src/worker/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // CommonJS so the window can run with `sandbox: true`.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), tailwindcss(), contentSecurityPolicy],
    resolve: { alias: { ...alias, '@': resolve('src/renderer/src') } },
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    }
  }
})
