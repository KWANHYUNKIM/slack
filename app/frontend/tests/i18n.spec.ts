import { test, expect } from '@playwright/test';
import { register, uniqueEmail, sendMessage, waitForMessage, clickChannel, waitForChannelReady, TEST_PASSWORD } from './helpers';

test.describe('i18n', () => {
  test('로그인 화면이 브라우저 언어(ko)를 따른다', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'ko-KR' });
    const page = await context.newPage();
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page.getByPlaceholder('비밀번호')).toBeVisible();
    await context.close();
  });

  test('언어를 바꾸면 화면과 html lang이 바뀌고 새로고침해도 유지된다', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByTestId('language-select').selectOption('ko');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByPlaceholder('비밀번호')).toBeVisible();

    await page.reload();
    await expect(page.getByPlaceholder('비밀번호')).toBeVisible();

    await page.getByTestId('language-select').selectOption('en');
    await expect(page.getByPlaceholder('Password')).toBeVisible();
  });

  test('한국어 상태에서 메시지 작성, 수정, 삭제가 된다', async ({ page }) => {
    await register(page, 'I18n Tester', uniqueEmail(), TEST_PASSWORD);
    await page.evaluate(() => localStorage.setItem('locale', 'ko'));
    await page.reload();
    await clickChannel(page, 'general');
    await waitForChannelReady(page);

    const original = `안녕하세요 ${Date.now()}`;
    await sendMessage(page, original);
    await waitForMessage(page, original);

    const messageEl = page.locator('.group.relative.flex.px-5').filter({ hasText: original });
    await messageEl.hover();
    await page.locator('.absolute.-top-4.end-5').locator('button').last().click();
    await page.getByText('메시지 수정').click();
    const edited = `${original} 수정`;
    await page.keyboard.press('Control+a');
    await page.keyboard.type(edited);
    await page.keyboard.press('Enter');
    await waitForMessage(page, edited);

    await messageEl.hover();
    await page.locator('.absolute.-top-4.end-5').locator('button').last().click();
    await page.getByText('메시지 삭제').click();
    await page.getByRole('button', { name: '삭제' }).click();
    await expect(page.getByText(edited)).toHaveCount(0);
  });
});
