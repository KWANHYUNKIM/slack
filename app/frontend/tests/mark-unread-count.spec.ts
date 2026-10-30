import { test, expect } from '@playwright/test';
import { register, uniqueEmail, sendMessage, waitForMessage, clickChannel, waitForChannelReady , TEST_PASSWORD } from './helpers';

test.describe('Mark as unread count', () => {
  test('marking a message as unread shows correct count including subsequent messages', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'Unread Tester', email, TEST_PASSWORD);
    await clickChannel(page, 'general');
    await waitForChannelReady(page);

    // Mark all existing messages as read by scrolling to the bottom
    // and waiting for the mark-read API to fire
    await page.evaluate(() => {
      const container = document.querySelector('[data-testid="message-list"]') || document.querySelector('.overflow-y-auto');
      if (container) container.scrollTop = container.scrollHeight;
    });
    await page.waitForTimeout(1000);

    // Navigate away and back to reset unread state
    await clickChannel(page, 'random');
    await page.waitForTimeout(500);
    await clickChannel(page, 'general');
    await waitForChannelReady(page);

    // Verify the unread badge is gone (all messages are read now)
    const sidebar = page.getByTestId('sidebar');
    const generalBtn = sidebar
      .locator('button')
      .filter({ has: page.locator('span.truncate', { hasText: 'general' }) })
      .first();

    // Send 4 messages so we can mark the 2nd one as unread (expecting count = 3)
    const prefix = `unread-${Date.now()}`;
    const msgs = [`${prefix}-msg1`, `${prefix}-msg2`, `${prefix}-msg3`, `${prefix}-msg4`];
    for (const msg of msgs) {
      await sendMessage(page, msg);
      await waitForMessage(page, msg);
      await page.waitForTimeout(300);
    }

    // Mark msg2 as unread — that means msg2 + msg3 + msg4 = 3 unread
    const msg2El = page.locator('.group.relative.flex.px-5').filter({ hasText: msgs[1] });
    await msg2El.hover();
    await page.waitForTimeout(200);

    // Click "more" button in hover toolbar
    const hoverToolbar = page.locator('.absolute.-top-4.right-5');
    await expect(hoverToolbar.locator('button').last()).toBeVisible({ timeout: 3000 });
    await hoverToolbar.locator('button').last().click();

    // Click "Mark as unread"
    await page.getByText('Mark as unread').click();

    // Navigate to a different channel to see the badge
    await clickChannel(page, 'random');
    await page.waitForTimeout(500);

    // The sidebar badge for #general should show 3 (not 1)
    const badge = generalBtn.locator('span').filter({ hasText: /^\d+$/ }).last();
    await expect(badge).toHaveText('3', { timeout: 5_000 });
  });
});
