import { test, expect } from '@playwright/test';
import { register, uniqueEmail, login , TEST_PASSWORD } from './helpers';

test.describe('DM search result navigation', () => {
  const suffix = Date.now().toString();

  test('clicking a DM search result navigates to the DM conversation', async ({ browser }) => {
    const senderEmail = uniqueEmail();
    const senderName = `DMSender_${suffix}`;
    const receiverEmail = uniqueEmail();
    const receiverName = `DMReceiver_${suffix}`;
    const dmContent = `dm-search-nav-${suffix}`;

    // Register sender
    const senderCtx = await browser.newContext();
    const senderPage = await senderCtx.newPage();
    await register(senderPage, senderName, senderEmail, TEST_PASSWORD);

    // Register receiver
    const receiverCtx = await browser.newContext();
    const receiverPage = await receiverCtx.newPage();
    await register(receiverPage, receiverName, receiverEmail, TEST_PASSWORD);

    // Sender sends a DM to receiver
    // First, find the receiver's user ID by clicking "Add teammates"
    const sidebar = senderPage.getByTestId('sidebar');
    await sidebar.getByText('Add teammates').click();
    await senderPage.getByPlaceholder('Search by name').fill(receiverName);
    await senderPage.getByText(receiverName).click();
    await senderPage.waitForTimeout(1000);

    // Type and send the DM
    const editor = senderPage.locator('.ql-editor');
    await editor.click();
    await senderPage.keyboard.type(dmContent, { delay: 10 });
    await senderPage.keyboard.press('Enter');
    await senderPage.waitForTimeout(1500);

    // Navigate receiver to a channel first
    await receiverPage.waitForTimeout(1000);
    // Receiver should now see the DM in sidebar or can search for it

    // Receiver: navigate to a channel first (to verify search navigates away from it)
    const receiverSidebar = receiverPage.getByTestId('sidebar');
    await receiverSidebar.locator('button').filter({ has: receiverPage.locator('span.truncate', { hasText: 'general' }) }).first().click();
    await receiverPage.waitForTimeout(500);

    // Verify we're on a channel, not a DM
    await expect(receiverPage.locator('[data-testid="channel-name-button"]')).toBeVisible({ timeout: 5000 });

    // Search for the DM content
    const searchInput = receiverPage.getByPlaceholder('Search');
    await searchInput.click();
    await searchInput.fill(dmContent);
    await receiverPage.waitForTimeout(2000);

    // Click the DM search result
    const resultItem = receiverPage.locator('[data-testid="search-result-item"]').first();
    await expect(resultItem).toBeVisible({ timeout: 5000 });
    await resultItem.click();
    await receiverPage.waitForTimeout(1000);

    // Verify we navigated to the DM conversation
    // The URL should contain /d/ and the DM header should show the sender's name
    await expect(receiverPage).toHaveURL(/\/d\//, { timeout: 5000 });

    await senderCtx.close();
    await receiverCtx.close();
  });
});
