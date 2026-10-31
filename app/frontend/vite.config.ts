import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { resolveDevApiTarget, resolveDevPort } from './scripts/vite-dev-env.ts'

// https://vite.dev/config/
// 프록시 대상과 포트는 환경 변수로 바꾼다(VITE_DEV_API_TARGET, VITE_DEV_PORT). 잘못된 값이면 여기서 시작을 멈춘다.
const apiTarget = resolveDevApiTarget(process.env.VITE_DEV_API_TARGET);
const devPort = resolveDevPort(process.env.VITE_DEV_PORT);
// 브라우저 주소창 이동(Accept: text/html)은 프록시하지 않고 SPA로 넘긴다. 새로고침해도 화면 경로가 API로 가지 않게 한다.
const spaNavigation = (req: { headers: { accept?: string }; url?: string }) =>
  req.headers.accept?.includes('text/html') ? req.url : undefined;

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        // emoji-mart 라이브러리를 이름 있는 청크(assets/emoji-mart-[hash].js)로 분리한다.
        // 라이브러리에 남는 jsdelivr 폴백 문자열을 scripts/dist-cdn.allow가 이 청크에만 허용하기 위해서다.
        manualChunks(id) {
          if (id.includes('/node_modules/emoji-mart/')) return 'emoji-mart';
        },
      },
    },
  },
  esbuild: {
    drop: ['console', 'debugger'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: 'localhost',
    port: devPort,
    proxy: {
      '/auth': { target: apiTarget, changeOrigin: true },
      '/channels': { target: apiTarget, changeOrigin: true },
      '/messages': { target: apiTarget, changeOrigin: true },
      '/search': {
        target: apiTarget,
        changeOrigin: true,
        // /search는 화면 경로이기도 하다. 새로고침 같은 문서 이동은 SPA가 처리하게 둔다.
        bypass: spaNavigation,
      },
      '/files': {
        target: apiTarget,
        changeOrigin: true,
        // Skip proxy for HTML page navigations so the /files SPA route works on refresh
        bypass: spaNavigation,
      },
      '/users': { target: apiTarget, changeOrigin: true },
      '/dms': {
        target: apiTarget,
        changeOrigin: true,
        // Skip proxy for HTML page navigations so the SPA handles /dms in the browser
        bypass: spaNavigation,
      },
      '/activity': {
        target: apiTarget,
        changeOrigin: true,
        // Skip proxy for HTML page navigations so the /activity SPA route works on refresh
        bypass: spaNavigation,
      },
      '/uploads': { target: apiTarget, changeOrigin: true },
      '/admin': {
        target: apiTarget,
        changeOrigin: true,
        // Skip proxy for HTML page navigations so the /admin SPA route works on refresh
        bypass: spaNavigation,
      },
      '/huddles': {
        target: apiTarget,
        changeOrigin: true,
        // Skip proxy for HTML page navigations so the SPA handles /huddles in the browser
        bypass: spaNavigation,
      },
      // 나중에 보기 > 리마인더(reminders)와 웹훅 관리(webhooks) API. 화면 경로와 겹치지 않는다.
      '/reminders': { target: apiTarget, changeOrigin: true },
      '/webhooks': { target: apiTarget, changeOrigin: true },
      // /threads, /unreads는 화면 경로이기도 해서 문서 이동은 SPA가 처리하게 둔다.
      '/threads': {
        target: apiTarget,
        changeOrigin: true,
        bypass: spaNavigation,
      },
      '/unreads': {
        target: apiTarget,
        changeOrigin: true,
        bypass: spaNavigation,
      },
      '/bookmarks': { target: apiTarget, changeOrigin: true },
      '/push': { target: apiTarget, changeOrigin: true },
      '/health': { target: apiTarget, changeOrigin: true },
      // 개인 액세스 토큰 API와 MCP 엔드포인트(mcp-1). 화면 경로와 겹치지 않아 bypass가 필요 없다.
      '/tokens': { target: apiTarget, changeOrigin: true },
      // OAuth 인가 서버와 메타데이터(mcp-4). 백엔드가 Host로 issuer·리소스 주소(http://localhost:5173/mcp)를 만들므로
      // changeOrigin을 끈다(켜면 :3000으로 바뀌어 토큰의 리소스가 맞지 않는다). '/oauth/'로 끝을 맞춰 화면 경로 /oauth-consent와 겹치지 않게 한다.
      '/mcp': { target: apiTarget, changeOrigin: false },
      '/oauth/': { target: apiTarget, changeOrigin: false },
      '/.well-known/oauth-': { target: apiTarget, changeOrigin: false },
      '/socket.io': { target: apiTarget, changeOrigin: true, ws: true },
    },
  },
})
