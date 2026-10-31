import { test, expect } from '@playwright/test';
import { register, sendMessage, waitForMessage, uniqueEmail, clickChannel, waitForChannelReady, TEST_PASSWORD } from './helpers';

/**
 * 규칙 17: 실행 중에 외부 출처로 요청하지 않는다.
 * 이모지 피커로 리액션을 달고(Create), 보고(Read), 지우는(Delete) 흐름을 두 번 반복하고,
 * ko 로캘로 피커를 한 번 열면서(emoji-mart i18n 번들 경로) 허용 출처 밖으로 나가는 HTTP 요청과 웹소켓이 없는지 확인한다.
 */

/** 허용 출처의 origin 집합: BASE_URL(앱)과 VITE_API_URL(API가 다를 때). */
function allowedOrigins(baseURL: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const value of [baseURL ?? 'http://localhost:5173', process.env.VITE_API_URL]) {
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // 상대 경로 등 URL이 아닌 값은 무시한다
    }
  }
  return origins;
}

/** http는 ws, https는 wss로 짝지어 같은 출처의 소켓도 허용한다. */
function isAllowed(url: string, origins: Set<string>): boolean {
  if (/^(data|blob|about):/.test(url)) return true;
  const u = new URL(url);
  const swapped = u.protocol === 'ws:' ? `http://${u.host}` : u.protocol === 'wss:' ? `https://${u.host}` : u.origin;
  return origins.has(swapped);
}

test('emoji picker reaction CRUD (en and ko) makes no external requests', async ({ page, baseURL }) => {
  const origins = allowedOrigins(baseURL);
  const external: string[] = [];
  page.on('request', (req) => {
    if (!isAllowed(req.url(), origins)) external.push(req.url());
  });
  page.on('websocket', (ws) => {
    if (!isAllowed(ws.url(), origins)) external.push(ws.url());
  });

  await register(page, 'No External', uniqueEmail(), TEST_PASSWORD);
  await clickChannel(page, 'general');
  await waitForChannelReady(page);

  const msg = `No external ${Date.now()}`;
  await sendMessage(page, msg);
  await waitForMessage(page, msg);
  const row = page.locator('.group.relative.flex.px-5').filter({ hasText: msg });

  const openPicker = async () => {
    await row.hover();
    await page.locator('.absolute.-top-4.end-5').locator('button').first().click();
  };

  for (let i = 0; i < 2; i++) {
    // Create
    await openPicker();
    const search = page.getByRole('searchbox', { name: 'Search' });
    await expect(search).toBeVisible({ timeout: 5_000 });
    await search.fill('thumbsup');
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: '👍', exact: true }).click();

    // Read
    const pill = row.locator('button').filter({ hasText: /👍/ });
    await expect(pill).toBeVisible({ timeout: 5_000 });
    await expect(pill).toContainText('1');

    // Delete: 같은 pill을 다시 눌러 내 리액션을 제거한다
    await pill.click();
    await expect(pill).toHaveCount(0, { timeout: 5_000 });
  }

  // ko 로캘: emoji-mart i18n(ko)을 번들에서 읽는지(CDN 요청이 없는지) 확인한다
  await page.evaluate(() => localStorage.setItem('locale', 'ko'));
  await page.reload();
  await clickChannel(page, 'general');
  await waitForChannelReady(page);
  await waitForMessage(page, msg);
  await openPicker();
  // 피커가 그려질 때까지 기다린다(검색창 이름은 로캘에 따라 다르므로 role만 본다)
  await expect(page.getByRole('searchbox').first()).toBeVisible({ timeout: 5_000 });

  expect(external, `외부 요청 발견: ${external.join(', ')}`).toEqual([]);
});
