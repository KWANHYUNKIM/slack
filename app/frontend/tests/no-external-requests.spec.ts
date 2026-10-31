import { test, expect } from '@playwright/test';
import { register, sendMessage, waitForMessage, uniqueEmail, clickChannel, waitForChannelReady, TEST_PASSWORD } from './helpers';

/**
 * 규칙 17: 실행 중에 외부 출처로 요청하지 않는다.
 * 이모지 피커로 리액션을 달고(Create), 보고(Read), 지우는(Delete) 흐름을
 * 두 번 반복하면서 앱 호스트 밖으로 나가는 요청이 없는지 확인한다.
 */
test('emoji picker reaction CRUD makes no external requests', async ({ page, baseURL }) => {
  const appHost = new URL(baseURL ?? 'http://localhost:5173').hostname;
  const external: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (/^(data|blob|about):/.test(url)) return;
    // 같은 호스트(앱, API, 소켓)만 허용한다. 백엔드는 다른 포트일 수 있다.
    if (new URL(url).hostname !== appHost) external.push(url);
  });

  await register(page, 'No External', uniqueEmail(), TEST_PASSWORD);
  await clickChannel(page, 'general');
  await waitForChannelReady(page);

  const msg = `No external ${Date.now()}`;
  await sendMessage(page, msg);
  await waitForMessage(page, msg);
  const row = page.locator('.group.relative.flex.px-5').filter({ hasText: msg });

  for (let i = 0; i < 2; i++) {
    // Create
    await row.hover();
    await page.locator('.absolute.-top-4.end-5').locator('button').first().click();
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

  expect(external, `외부 요청 발견: ${external.join(', ')}`).toEqual([]);
});
