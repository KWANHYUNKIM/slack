import { test, expect } from '@playwright/test';
import { register, uniqueEmail, clickChannel , TEST_PASSWORD } from './helpers';

test.describe('Compose button', () => {
  test('compose button opens new message dialog', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'ComposeUser', email, TEST_PASSWORD);

    await clickChannel(page, 'general');
    await page.waitForTimeout(500);

    // The compose button should be in the sidebar header (a SquarePen icon button)
    const sidebar = page.getByTestId('sidebar');
    const composeButton = sidebar.locator('button').filter({ has: page.locator('.lucide-square-pen') });
    await expect(composeButton).toBeVisible({ timeout: 5000 });

    // Click the compose button
    await composeButton.click();

    // The Direct message dialog should appear
    await expect(page.getByRole('heading', { name: 'Direct message' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('teammate-search')).toBeVisible({ timeout: 5000 });
  });
});
