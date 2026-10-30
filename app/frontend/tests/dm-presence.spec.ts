import { test, expect } from '@playwright/test';
import { login, waitForChannelReady , TEST_PASSWORD } from './helpers';

test.describe('DM sidebar presence', () => {
  test('DM contacts show as offline when no other users are logged in', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);
    await waitForChannelReady(page);

    // Wait for DM list items to appear
    const dmItems = page.locator('[data-testid="dm-list-item"]');
    await expect(dmItems.first()).toBeVisible({ timeout: 10_000 });

    const count = await dmItems.count();
    expect(count).toBeGreaterThan(0);

    // Check each DM item's presence dot — should be gray (offline), not green (online)
    for (let i = 0; i < count; i++) {
      const item = dmItems.nth(i);
      // The presence dot is a span inside the avatar's relative wrapper
      const greenDot = item.locator('.bg-green-500');
      const grayDot = item.locator('.bg-gray-400');

      // Should have no green (online) dot
      await expect(greenDot).toHaveCount(0);
      // Should have a gray (offline) dot
      await expect(grayDot).toHaveCount(1);
    }
  });
});
