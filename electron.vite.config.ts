import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = { '@shared': resolve(__dirname, 'src/shared') }

// Strikte Content-Security-Policy im Produktions-Build (im Dev-Server benötigt Vite Inline-Skripte/Websocket)
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' ppm: data:",
  "media-src ppm:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function csp(): Plugin {
  return {
    name: 'ppm-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'file-worker': resolve(__dirname, 'src/main/core/file-worker.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias },
    build: { externalizeDeps: true }
  },
  renderer: {
    resolve: { alias },
    plugins: [react(), csp()]
  }
})
