import { test, expect, type Page } from '@playwright/test';
import { login, TEST_PASSWORD } from './helpers';

// 관리자 대화상자의 실패 경로: 실패하면 대화상자를 닫지 않고 번역된 문구를 보여 주며,
// 처리 중에는 Esc나 배경 클릭으로 닫히지 않는다.

async function openChannelsTab(page: Page) {
  await login(page, 'alice@slawk.dev', TEST_PASSWORD);
  await page.getByTestId('nav-item-admin').click({ force: true });
  const main = page.locator('main');
  await expect(main.getByText('Admin Panel')).toBeVisible({ timeout: 10_000 });
  await main.getByRole('button', { name: /Channels/ }).click();
  await expect(main.locator('table tbody tr').first()).toBeVisible({ timeout: 10_000 });
  return main;
}

test.describe('관리자 대화상자 실패 처리', () => {
  test('채널 삭제가 실패하면 대화상자는 열린 채 문구를 보여 준다', async ({ page }) => {
    const main = await openChannelsTab(page);

    // 삭제 API만 실패하게 바꾼다(서버 내부 문구는 노출되지 않아야 한다)
    await page.route(/\/admin\/channels\/\d+$/, async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue();
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Failed to delete channel' }) });
    });

    await main.getByRole('button', { name: 'Delete channel' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(dialog.getByTestId('confirm-dialog-error')).toHaveText('Failed to delete channel');
    await expect(dialog).toBeVisible();

    // 실패 뒤 Esc로는 닫힌다
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('처리 중에는 Esc와 배경 클릭으로 대화상자가 닫히지 않는다', async ({ page }) => {
    const main = await openChannelsTab(page);

    // 응답을 직접 풀 때까지 요청을 붙잡아 둔다
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(/\/admin\/channels\/\d+$/, async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue();
      await gate;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Failed to delete channel' }) });
    });

    await main.getByRole('button', { name: 'Delete channel' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

    // 처리 중: Esc와 배경 클릭을 해도 남아 있다
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();

    // 응답이 실패로 끝나면 대화상자는 그대로이고 문구가 보인다
    release();
    await expect(dialog.getByTestId('confirm-dialog-error')).toBeVisible();
    await expect(dialog).toBeVisible();
  });
});
