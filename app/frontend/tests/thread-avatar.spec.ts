import { test, expect } from '@playwright/test';
import { login, clickChannel, waitForChannelReady , TEST_PASSWORD } from './helpers';

test.describe('Thread avatar indicator', () => {
  test('thread indicator shows real avatars, not "?" placeholders', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);
    await clickChannel(page, 'random');
    await waitForChannelReady(page);

    // Find thread indicators (buttons showing "X replies")
    const threadIndicators = page.locator('[data-testid="thread-avatars"]');
    await expect(threadIndicators.first()).toBeVisible({ timeout: 10_000 });

    // Check each thread indicator's avatars — none should show "?" fallback
    const count = await threadIndicators.count();
    for (let i = 0; i < count; i++) {
      const indicator = threadIndicators.nth(i);
      // Get all avatar fallback spans (the ones showing initials)
      const fallbacks = indicator.locator('span.flex.h-full.w-full');
      const fallbackCount = await fallbacks.count();
      for (let j = 0; j < fallbackCount; j++) {
        const text = await fallbacks.nth(j).textContent();
        expect(text).not.toBe('?');
      }
    }
  });
});
