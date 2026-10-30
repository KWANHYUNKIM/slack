import { test, expect } from '@playwright/test';
import { login, clickChannel, waitForChannelReady , TEST_PASSWORD } from './helpers';

test.describe('Notification bell', () => {
  test('clicking bell opens activity panel and clicking again closes it', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);
    await clickChannel(page, 'announcements');
    await waitForChannelReady(page);

    // Bell should be visible
    const bell = page.getByTestId('notification-bell');
    await expect(bell).toBeVisible({ timeout: 5000 });

    // Click bell — notifications panel should open
    await bell.click();
    await expect(page.getByTestId('notifications-panel')).toBeVisible({ timeout: 3000 });

    // Panel should have the "Activity" heading
    await expect(page.getByTestId('notifications-panel').getByText('Activity')).toBeVisible();

    // Click bell again — panel should close
    await bell.click();
    await expect(page.getByTestId('notifications-panel')).not.toBeVisible();
  });
});
