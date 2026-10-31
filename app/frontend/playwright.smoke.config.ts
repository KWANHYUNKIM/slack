import { defineConfig, devices } from '@playwright/test';

// 이미 떠 있는 개발 서버(백엔드와 vite)에 붙는 스모크 전용 설정. 서버를 직접 띄우지 않는다.
// 사용: BASE_URL=http://localhost:5190 npx playwright test -c playwright.smoke.config.ts e2e-smoke
export default defineConfig({
  testDir: './tests',
  globalSetup: './tests/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 60_000,
  outputDir: process.env.E2E_OUTPUT_DIR || './test-results',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5190',
    // 실패 때만 찍는다. E2E_SCREENSHOT=on이면 통과한 테스트의 마지막 화면도 찍는다.
    screenshot: process.env.E2E_SCREENSHOT === 'on' ? 'on' : 'only-on-failure',
    trace: 'off',
  },
  // 설치된 브라우저 빌드가 Playwright 기대 버전과 다를 때 PW_CHROMIUM_PATH로 실행 파일을 지정한다.
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
      },
    },
  ],
});
