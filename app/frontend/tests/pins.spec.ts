import { test, expect } from '@playwright/test';
import { register, uniqueEmail, sendMessage, waitForMessage, clickChannel, waitForChannelReady , TEST_PASSWORD } from './helpers';

test.describe('Pinned Messages', () => {
  test('user can pin a message and view it in pins panel', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'PinTester', email, TEST_PASSWORD);

    // Select general channel and wait for socket join to settle
    await clickChannel(page, 'general');
    await waitForChannelReady(page);

    // Send a message to pin
    const uniqueText = `Pin me ${Date.now()}`;
    await sendMessage(page, uniqueText);
    await waitForMessage(page, uniqueText);

    // Hover over the message to show action buttons
    const messageRow = page.locator('.group.relative.flex.px-5').filter({ hasText: uniqueText }).first();
    await messageRow.hover();

    // Click the more actions button (last button in hover toolbar)
    const hoverToolbar = page.locator('.absolute.-top-4.right-5');
    await hoverToolbar.locator('button').last().click();

    // Click "Pin message" from the dropdown
    await page.getByText('Pin message').click();

    // The message should now show a pin indicator
    await expect(messageRow.locator('[data-testid="pin-indicator"]')).toBeVisible({ timeout: 5000 });

    // Click the Pins tab to see pinned messages
    await page.getByRole('button', { name: 'Pins' }).click();

    // The pinned message should appear in the pins panel
    await expect(page.getByTestId('pins-panel').getByText(uniqueText)).toBeVisible({ timeout: 5000 });
  });

  test('pinning a message updates in real-time for another user in the same channel', async ({ browser }) => {
    // User 1 sends and pins a message; user 2 (in another browser context) should
    // see the pin indicator appear without refreshing.
    const email1 = uniqueEmail();
    const email2 = uniqueEmail();

    // Set up user 1
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    await register(page1, 'PinnerUser', email1, TEST_PASSWORD);
    await clickChannel(page1, 'general');
    await waitForChannelReady(page1);

    // Set up user 2 (observer)
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await register(page2, 'ObserverUser', email2, TEST_PASSWORD);
    await clickChannel(page2, 'general');
    await waitForChannelReady(page2);

    // User 1 sends a message
    const uniqueText = `RealTimePin ${Date.now()}`;
    await sendMessage(page1, uniqueText);

    // Both users should see the message
    await waitForMessage(page1, uniqueText);
    await waitForMessage(page2, uniqueText);

    // User 1 pins the message via the dropdown
    const messageRow1 = page1.locator('.group.relative.flex.px-5').filter({ hasText: uniqueText }).first();
    await messageRow1.hover();
    const hoverToolbar1 = page1.locator('.absolute.-top-4.right-5');
    await hoverToolbar1.locator('button').last().click();
    await page1.getByText('Pin message').click();

    // User 1's view: pin indicator appears (optimistic update)
    await expect(messageRow1.locator('[data-testid="pin-indicator"]')).toBeVisible({ timeout: 5000 });

    // User 2's view: pin indicator should appear in real-time via WebSocket (no page refresh)
    const messageRow2 = page2.locator('.group.relative.flex.px-5').filter({ hasText: uniqueText }).first();
    await expect(messageRow2.locator('[data-testid="pin-indicator"]')).toBeVisible({ timeout: 10000 });

    await context1.close();
    await context2.close();
  });

  test('pinned messages panel updates in real-time when a message is pinned', async ({ browser }) => {
    const email1 = uniqueEmail();
    const email2 = uniqueEmail();

    // Set up user 1 (pinner)
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    await register(page1, 'PinnerB', email1, TEST_PASSWORD);
    await clickChannel(page1, 'general');
    await waitForChannelReady(page1);

    // Set up user 2 (observer with pins panel open)
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await register(page2, 'ObserverB', email2, TEST_PASSWORD);
    await clickChannel(page2, 'general');
    await waitForChannelReady(page2);

    // User 2 opens the pins panel
    await page2.getByRole('button', { name: 'Pins' }).click();
    await expect(page2.getByTestId('pins-panel')).toBeVisible({ timeout: 5000 });

    // User 1 sends a message
    const uniqueText = `PinsPanel ${Date.now()}`;
    await sendMessage(page1, uniqueText);
    await waitForMessage(page1, uniqueText);
    await waitForMessage(page2, uniqueText);

    // User 1 pins the message
    const messageRow1 = page1.locator('.group.relative.flex.px-5').filter({ hasText: uniqueText }).first();
    await messageRow1.hover();
    const hoverToolbar1 = page1.locator('.absolute.-top-4.right-5');
    await expect(hoverToolbar1).toBeVisible({ timeout: 3000 });
    await hoverToolbar1.locator('button').last().click();
    await page1.getByText('Pin message').click();

    // User 2's pins panel should update in real-time to show the newly pinned message
    await expect(page2.getByTestId('pins-panel').getByText(uniqueText)).toBeVisible({ timeout: 10000 });

    await context1.close();
    await context2.close();
  });
});
