import { defineConfig, devices } from '@playwright/test';
import { devApiTargetPort, resolveDevApiTarget, resolveDevPort } from './scripts/vite-dev-env.ts';

// 백엔드·개발 서버 포트는 vite.config.ts와 같은 환경 변수를 쓴다.
// VITE_DEV_API_TARGET(백엔드 주소, 기본 http://localhost:3000), VITE_DEV_PORT(개발 서버, 기본 5173), BASE_URL(테스트 대상 주소, 우선).
const apiTarget = resolveDevApiTarget(process.env.VITE_DEV_API_TARGET);
const devPort = resolveDevPort(process.env.VITE_DEV_PORT);
const baseUrl = process.env.BASE_URL || `http://localhost:${devPort}`;
const webPort = Number(new URL(baseUrl).port || devPort);

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
