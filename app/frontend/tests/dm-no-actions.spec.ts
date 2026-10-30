import { test, expect } from '@playwright/test';
import { login , TEST_PASSWORD } from './helpers';

test.describe('DM message actions', () => {
  test('other user messages do not show "..." more button (#79)', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);

    // Open DM with Eve Johnson (seed DM conversation)
    const sidebar = page.getByTestId('sidebar');
    await sidebar.getByText('Eve Johnson').click();

    // Wait for DM conversation to load
    await expect(page.getByTestId('dm-conversation')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(1000);

    // Find a message container that is NOT from the current user
    // We need to find the current user's ID first, then find a message from someone else
    const allMsgContainers = page.locator('[data-testid^="dm-message-"]');
    await expect(allMsgContainers.first()).toBeVisible({ timeout: 5000 });

    // Get the current user ID from the auth store
    const currentUserId = await page.evaluate(() => {
      const raw = localStorage.getItem('auth-storage');
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data?.state?.user?.id;
    });

    // Find a message from someone other than the current user
    const otherUserMsg = page.locator(`[data-testid^="dm-message-"]:not([data-from="${currentUserId}"])`).first();
    await expect(otherUserMsg).toBeVisible({ timeout: 5000 });
    await otherUserMsg.hover();
    await page.waitForTimeout(500);

    // The toolbar should appear but the "..." more button should NOT be present
    const toolbar = page.locator('[data-testid="dm-message-toolbar"]');
    await expect(toolbar).toBeVisible({ timeout: 3000 });
    const moreBtn = page.locator('[data-testid="dm-more-btn"]');
    await expect(moreBtn).toHaveCount(0);
  });
});
