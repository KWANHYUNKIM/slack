import { test, expect } from '@playwright/test';
import { login, sendMessage, waitForMessage, uniqueEmail, register, clickChannel, waitForChannelReady , TEST_PASSWORD } from './helpers';

test.describe('Channels', () => {
  test.beforeEach(async ({ page }) => {
    // Register a fresh user who will be auto-joined to #general and #random
    const email = uniqueEmail();
    await register(page, 'Channel Tester', email, TEST_PASSWORD);
    await expect(page.getByTestId('sidebar')).toBeVisible();
  });

  test('user can switch between channels', async ({ page }) => {
    // Click on #general channel
    await clickChannel(page, 'general');
    // The message input placeholder should reference general
    await expect(page.locator('.ql-editor')).toHaveAttribute(
      'data-placeholder',
      'Message #general'
    );

    // Click on #random channel
    await clickChannel(page, 'random');
    // The message input placeholder should reference random
    await expect(page.locator('.ql-editor')).toHaveAttribute(
      'data-placeholder',
      'Message #random'
    );
  });

  test('messages are different in each channel', async ({ page }) => {
    // Send a message in #general
    await clickChannel(page, 'general');
    await waitForChannelReady(page);
    const generalMsg = `General msg ${Date.now()}`;
    await sendMessage(page, generalMsg);
    await waitForMessage(page, generalMsg);

    // Switch to #random
    await clickChannel(page, 'random');
    await waitForChannelReady(page);

    // The general message should NOT be visible in #random
    await expect(
      page.locator('.group.relative.flex.px-5').filter({ hasText: generalMsg })
    ).not.toBeVisible({ timeout: 3_000 });

    // Send a message in #random
    const randomMsg = `Random msg ${Date.now()}`;
    await sendMessage(page, randomMsg);
    await waitForMessage(page, randomMsg);

    // Switch back to #general — random message should not be there
    await clickChannel(page, 'general');
    await expect(
      page.locator('.group.relative.flex.px-5').filter({ hasText: randomMsg })
    ).not.toBeVisible({ timeout: 3_000 });
  });

  test('user can create a new channel', async ({ page }) => {
    // Click the "Add channels" button in the sidebar
    await page.locator('button').filter({ hasText: 'Add channels' }).click();

    // Fill in the channel name in whatever dialog/form appears
    const channelName = `test-${Date.now()}`;
    const nameInput = page.getByPlaceholder(/plan-budget/i).or(
      page.getByLabel(/channel name/i)
    );
    await expect(nameInput).toBeVisible({ timeout: 3_000 });
    await nameInput.fill(channelName);

    // Listen for the API response
    const responsePromise = page.waitForResponse(
      (resp) => resp.url().includes('/channels') && resp.request().method() === 'POST'
    );

    // Submit / create the channel
    await page.getByRole('button', { name: /create$/i }).click();

    // Wait for the API call to complete
    await responsePromise;

    // The new channel should appear in the sidebar
    await expect(
      page.locator('button[data-active]').filter({ hasText: channelName })
    ).toBeVisible({ timeout: 5_000 });
  });

  test('channels show unread count badge when new messages arrive', async ({
    browser,
  }) => {
    // Use two browser contexts for two users
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const email1 = uniqueEmail();
    const email2 = uniqueEmail();
    await register(page1, 'Badge User 1', email1, TEST_PASSWORD);
    await register(page2, 'Badge User 2', email2, TEST_PASSWORD);

    // Both users join general and random channels via API
    for (const page of [page1, page2]) {
      await page.evaluate(async () => {
        const token = localStorage.getItem('token');
        const res = await fetch('/channels', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const channels = await res.json();
        for (const ch of channels) {
          await fetch(`/channels/${ch.id}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          });
        }
      });
    }

    // Reload so sockets reconnect and join channel rooms
    await page1.reload();
    await page2.reload();

    // Wait for app to load
    for (const page of [page1, page2]) {
      await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 10_000 });
    }

    // User 2 switches to #random so #general becomes inactive
    await clickChannel(page2, 'random');
    await expect(page2.locator('.ql-editor')).toBeVisible();

    // Give socket connections time to establish
    await page1.waitForTimeout(1_000);

    // User 1 sends a message in #general
    await clickChannel(page1, 'general');
    await expect(page1.locator('.ql-editor')).toBeVisible();
    const unreadMsg = `Unread test ${Date.now()}`;
    await sendMessage(page1, unreadMsg);

    // User 2 should see an unread badge on the #general channel in sidebar
    const generalButton = page2.getByTestId('sidebar').locator('button').filter({ has: page2.locator('span.truncate', { hasText: 'general' }) }).first();
    await expect(generalButton.locator('span').filter({ hasText: /^\d+$/ })).toBeVisible({
      timeout: 10_000,
    });

    await ctx1.close();
    await ctx2.close();
  });
});
