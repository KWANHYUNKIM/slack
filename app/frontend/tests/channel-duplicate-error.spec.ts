import { test, expect } from '@playwright/test';
import { uniqueEmail, register, login, TEST_PASSWORD } from './helpers';

test.describe('Channel duplicate name error', () => {
  test.beforeEach(async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'Dup Tester', email, TEST_PASSWORD);
    await expect(page.getByTestId('sidebar')).toBeVisible();
  });

  test('shows error when creating a channel with a duplicate name and keeps dialog open', async ({ page }) => {
    // Open the Add Channel dialog
    await page.locator('button').filter({ hasText: 'Add channels' }).click();

    const nameInput = page.getByPlaceholder(/plan-budget/i);
    await expect(nameInput).toBeVisible({ timeout: 3_000 });

    // Try to create a channel with the name "general" which already exists
    await nameInput.fill('general');

    const responsePromise = page.waitForResponse(
      (resp) => resp.url().includes('/channels') && resp.request().method() === 'POST'
    );

    await page.getByRole('button', { name: /create$/i }).click();
    await responsePromise;

    // Error message should be visible
    await expect(page.getByTestId('channel-error')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByTestId('channel-error')).toHaveText('A channel with that name already exists.');

    // Dialog should still be open (the input is still visible)
    await expect(nameInput).toBeVisible();

    // Error should clear when user starts typing
    await nameInput.fill('general-');
    await expect(page.getByTestId('channel-error')).not.toBeVisible();
  });
});

test.describe('Admin channel rename duplicate error', () => {
  // 시드 관리자(alice)로 관리자 채널 탭에서 이름 변경을 시도한다.
  // 중복 이름은 서버가 거부하므로 DB 상태는 바뀌지 않는다(성공 경로는 시드 채널을 바꾸므로 여기서 하지 않는다).
  test('shows the translated error and keeps the edit row open when renaming to a taken name', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);
    await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('nav-item-admin').click({ force: true });
    const main = page.locator('main');
    await expect(main.getByText('Admin Panel')).toBeVisible({ timeout: 10_000 });
    await main.getByRole('button', { name: /Channels/ }).click();

    const row = main.locator('tr').filter({ hasText: 'random' }).first();
    await row.getByRole('button', { name: 'Rename channel' }).click();

    const input = row.locator('input[type="text"]');
    await expect(input).toBeVisible();
    await input.fill('general');

    const responsePromise = page.waitForResponse(
      (resp) => resp.url().includes('/admin/channels/') && resp.request().method() === 'PATCH'
    );
    await input.press('Enter');
    const resp = await responsePromise;
    expect(resp.status()).toBe(409);

    // 번역된 오류가 보이고, 편집 행은 열린 채 입력값이 남아 있다
    await expect(main.getByTestId('channel-edit-error')).toHaveText('A channel with that name already exists.');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('general');
  });
});
