import { test, expect } from '@playwright/test';
import { register, uniqueEmail , TEST_PASSWORD } from './helpers';

test.describe('Leave channel error feedback', () => {
  test('shows error when trying to leave channel as last member', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'LeaveUser', email, TEST_PASSWORD);

    // Create a new channel (user will be the only member)
    await page.locator('button').filter({ hasText: 'Add channels' }).click();
    const nameInput = page.getByPlaceholder(/plan-budget/i);
    await expect(nameInput).toBeVisible({ timeout: 5000 });
    const channelName = `leave-test-${Date.now()}`;
    await nameInput.fill(channelName);

    const responsePromise = page.waitForResponse(
      (resp) => resp.url().includes('/channels') && resp.request().method() === 'POST'
    );
    await page.getByRole('button', { name: /create$/i }).click();
    await responsePromise;

    // Wait for channel to appear in sidebar and click it
    const sidebar = page.getByTestId('sidebar');
    const channelBtn = sidebar.locator('button').filter({ has: page.locator('span.truncate', { hasText: channelName }) }).first();
    await expect(channelBtn).toBeVisible({ timeout: 5000 });
    await channelBtn.click();
    await expect(page.locator('.ql-editor')).toBeVisible({ timeout: 10_000 });

    // Open three-dot menu and click Leave channel
    await page.getByTestId('channel-header-menu').click();
    await page.getByText('Leave channel').click();

    // Error banner should appear
    await expect(page.getByTestId('leave-error')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('leave-error')).toContainText('Cannot leave channel');
  });
});
