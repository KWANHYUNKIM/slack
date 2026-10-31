import { defineConfig, devices } from '@playwright/test';
import { devApiTargetPort, resolveDevApiTarget, resolveDevPort } from './scripts/vite-dev-env.ts';

// 백엔드·개발 서버 포트는 vite.config.ts와 같은 환경 변수를 쓴다.
// VITE_DEV_API_TARGET(백엔드 주소, 기본 http://localhost:3000), VITE_DEV_PORT(개발 서버, 기본 5173), BASE_URL(테스트 대상 주소, 우선).
const apiTarget = resolveDevApiTarget(process.env.VITE_DEV_API_TARGET);
const devPort = resolveDevPort(process.env.VITE_DEV_PORT);
// 테스트가 띄우는 백엔드는 평문 HTTP다. https 대상은 이 설정으로 띄울 수 없으므로 시작 시 막는다.
if (apiTarget.startsWith('https:')) {
  throw new Error('playwright.config.ts는 백엔드를 HTTP로 띄운다. VITE_DEV_API_TARGET은 http://로 지정하라.');
}
const baseUrl = process.env.BASE_URL || `http://localhost:${devPort}`;
// BASE_URL에 포트가 없으면 스킴 기본 포트(80/443)를 쓴다. 개발 서버도 그 포트로 띄운다.
const parsedBase = new URL(baseUrl);
const webPort = Number(parsedBase.port || (parsedBase.protocol === 'https:' ? 443 : 80));

export default defineConfig({
  testDir: './tests',
  globalSetup: './tests/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 2,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  timeout: 30_000,

  use: {
    baseURL: baseUrl,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
          ],
        },
      },
    },
  ],

  webServer: [
    {
      command: `PORT=${devApiTargetPort(apiTarget)} NODE_ENV=test npm run dev`,
      cwd: '../backend',
      port: devApiTargetPort(apiTarget),
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
    {
      command: `npm run dev -- --port ${webPort} --strictPort`,
      port: webPort,
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
  ],
});
