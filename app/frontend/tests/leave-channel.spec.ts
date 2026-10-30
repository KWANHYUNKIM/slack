import { test, expect } from '@playwright/test';
import { login, clickChannel, waitForChannelReady , TEST_PASSWORD } from './helpers';

test.describe('Leave channel', () => {
  test('leaving a channel marks it as non-member but keeps it in browse list (#81)', async ({ page }) => {
    // Use seed user who is a member of multiple channels
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);

    // Navigate to #random (has multiple members from seed)
    await clickChannel(page, 'random');
    await waitForChannelReady(page);

    // Leave the channel via the menu
    await page.getByTestId('channel-header-menu').click();
    await page.getByText('Leave channel').click();
    await page.waitForTimeout(2000);

    // Channel should no longer be in the sidebar channels section
    const sidebar = page.getByTestId('sidebar');
    const randomInSidebar = sidebar.locator('button').filter({ has: page.locator('span.truncate', { hasText: 'random' }) });
    await expect(randomInSidebar).toHaveCount(0, { timeout: 5000 });

    // But channel should still be available in Browse Channels
    await sidebar.locator('button').filter({ hasText: 'Add channels' }).click();
    await page.getByText('Browse channels').click();
    await page.waitForTimeout(1000);

    const channelRow = page.locator('[data-channel-name="random"]');
    await expect(channelRow).toBeVisible({ timeout: 5000 });
  });
});
