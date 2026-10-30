import { test, expect } from '@playwright/test';
import { register, uniqueEmail, sendMessage, clickChannel, waitForMessage , TEST_PASSWORD } from './helpers';

test.describe('Plain URL auto-linking', () => {
  test('plain URLs in messages are rendered as clickable links', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'URLTestUser', email, TEST_PASSWORD);

    await clickChannel(page, 'general');
    await page.waitForTimeout(500);

    const suffix = Date.now();
    const url = `https://example.com/test-${suffix}`;
    await sendMessage(page, `Check this ${url} for details`);

    // Wait for message to appear
    const messageRow = page.locator('.group.relative.flex.px-5').filter({ hasText: `Check this` }).filter({ hasText: `${suffix}` });
    await expect(messageRow.first()).toBeVisible({ timeout: 10000 });

    // The URL should be rendered as a clickable <a> tag
    const link = messageRow.first().locator(`a[href="${url}"]`);
    await expect(link).toBeVisible({ timeout: 5000 });
    await expect(link).toHaveAttribute('target', '_blank');
  });

  test('http URLs are also auto-linked', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'HTTPURLUser', email, TEST_PASSWORD);

    await clickChannel(page, 'general');
    await page.waitForTimeout(500);

    const suffix = Date.now();
    const url = `http://example.com/http-${suffix}`;
    await sendMessage(page, `Visit ${url} now`);

    const messageRow = page.locator('.group.relative.flex.px-5').filter({ hasText: `Visit` }).filter({ hasText: `${suffix}` });
    await expect(messageRow.first()).toBeVisible({ timeout: 10000 });

    const link = messageRow.first().locator(`a[href="${url}"]`);
    await expect(link).toBeVisible({ timeout: 5000 });
  });

  test('markdown links still work alongside plain URLs', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'MixedURLUser', email, TEST_PASSWORD);

    await clickChannel(page, 'general');
    await page.waitForTimeout(500);

    const suffix = Date.now();
    await sendMessage(page, `See [docs](https://docs.example.com/${suffix}) and https://plain.example.com/${suffix}`);

    const messageRow = page.locator('.group.relative.flex.px-5').filter({ hasText: `See` }).filter({ hasText: `${suffix}` });
    await expect(messageRow.first()).toBeVisible({ timeout: 10000 });

    // Markdown link
    const mdLink = messageRow.first().locator(`a[href="https://docs.example.com/${suffix}"]`);
    await expect(mdLink).toBeVisible({ timeout: 5000 });
    await expect(mdLink).toHaveText('docs');

    // Plain URL
    const plainLink = messageRow.first().locator(`a[href="https://plain.example.com/${suffix}"]`);
    await expect(plainLink).toBeVisible({ timeout: 5000 });
  });
});
