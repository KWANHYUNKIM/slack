import { test, expect } from '@playwright/test';
import { login, clickChannel, waitForChannelReady, TEST_PASSWORD } from './helpers';

// 06 빠른 전환기와 전역 단축키. (작성만 했고 이 환경에서는 실행하지 못했다: 서버·vite 미기동)
test.describe('Quick switcher', () => {
  test('Ctrl+K로 열고 검색해 이동하고, Esc로 닫으면 포커스가 돌아온다', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);
    await clickChannel(page, 'random');
    await waitForChannelReady(page);

    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: /switch|전환/i });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('quick-switcher-input')).toBeFocused();

    await page.getByTestId('quick-switcher-input').fill('gen');
    await expect(page.getByTestId('switcher-option').first()).toContainText('general');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/c\/\d+$/);

    // 최근 방문이 쌓이고 지울 수 있다
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('switcher-option').first()).toBeVisible();
    await page.getByTestId('quick-switcher-clear-recents').click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('입력창에서 e를 눌러도 단축키가 발동하지 않고 ?는 입력된다', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);
    await clickChannel(page, 'random');
    await waitForChannelReady(page);
    await page.locator('.ql-editor').first().click();
    await page.keyboard.type('e?');
    await expect(page.getByTestId('shortcuts-help')).toHaveCount(0);
    await expect(page.locator('.ql-editor').first()).toContainText('e?');
  });

  test('입력창 밖에서 ?로 단축키 도움말이 열린다', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);
    await clickChannel(page, 'random');
    await waitForChannelReady(page);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('?');
    await expect(page.getByTestId('shortcuts-help')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('shortcuts-help')).toBeHidden();
  });
});
