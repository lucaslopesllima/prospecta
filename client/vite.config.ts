import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { compression } from 'vite-plugin-compression2';

// Dev: proxy /api to the Fastify server. Prod: Fastify serves the built assets.
// In docker-compose.dev the API service is reachable at http://app:8080 (VITE_PROXY_TARGET).
// O fallback é para `vite dev` rodando NO HOST, fora do compose: aí a API está na
// porta publicada pelo container (APP_PORT, default 8090), não na interna.
const proxyTarget = process.env.VITE_PROXY_TARGET ?? 'http://localhost:8090';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // PWA (Fase 5.4): precache do shell/assets + cache da agenda do dia e da
    // rota ativa (NetworkFirst — online sempre tenta a rede, offline cai no
    // cache). Mutação de campo (check-in/relatório) tem fila própria em
    // lib/offline.ts; o SW NÃO intercepta POST.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon-180.png'],
      manifest: {
        name: 'Rovva — Representação Comercial',
        short_name: 'Rovva',
        description: 'Prospecção, pedidos e rotas em campo.',
        lang: 'pt-BR',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api/],
        // Os artefatos pré-comprimidos (.gz/.br) ficam fora do precache — o
        // navegador negocia a compressão via Accept-Encoding no arquivo original.
        globIgnores: ['**/*.gz', '**/*.br'],
        runtimeCaching: [
          {
            // agenda do dia + rotas: leitura cacheada p/ uso offline em campo.
            urlPattern: ({ url, request }) =>
              request.method === 'GET' && (url.pathname.startsWith('/api/activities') || url.pathname.startsWith('/api/routes')),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'rs-api-campo',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: true },
    }),
    // Emite .gz e .br pré-comprimidos no build — o Fastify serve via
    // preCompressed sem gastar CPU comprimindo a cada request.
    compression({ algorithms: ['gzip', 'brotliCompress'] }),
  ],
  server: {
    host: true, // listen on 0.0.0.0 so the container port is reachable
    port: 5173,
    // Cloudflare quick tunnels geram um subdomínio aleatório a cada execução;
    // o sufixo libera qualquer *.trycloudflare.com sem editar a config de novo.
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      // ws:true encaminha o WebSocket do espelho WhatsApp (/api/whatsapp/ws).
      '/api': { target: proxyTarget, changeOrigin: true, ws: true },
    },
    watch: {
      // inotify works for bind mounts on native Linux; flip on if HMR misses changes (e.g. on a VM/WSL)
      usePolling: process.env.VITE_USE_POLLING === '1',
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Vendor estável (react + router): muda pouco entre deploys, então o
        // hash sobrevive e o navegador reaproveita o cache. Leaflet fica no
        // split natural do dynamic import das páginas de mapa.
        manualChunks(id: string): string | undefined {
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return 'vendor';
          return undefined;
        },
      },
    },
  },
});
