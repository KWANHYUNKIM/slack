import { test, expect } from '@playwright/test';
import { register, uniqueEmail, sendMessage , TEST_PASSWORD } from './helpers';

test.describe('Threads', () => {
  test('user can reply to a message and see the thread panel', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'ThreadUser', email, TEST_PASSWORD);

    // Click general channel (scope to sidebar to avoid matching channel header)
    await page.getByTestId('sidebar').locator('button').filter({ has: page.locator('span.truncate', { hasText: 'general' }) }).first().click();
    await page.waitForTimeout(500);

    // Send a unique message
    const uniqueText = `Thread parent ${Date.now()}`;
    await sendMessage(page, uniqueText);

    // Wait for the specific message to appear
    const messageRow = page.locator('.group.relative.flex.px-5').filter({ hasText: uniqueText });
    await expect(messageRow.first()).toBeVisible({ timeout: 10000 });

    // Hover over the message to show the action toolbar
    await messageRow.first().hover();

    // Click the reply/thread button (MessageSquare icon)
    const replyButton = messageRow.first().locator('button').filter({ has: page.locator('.lucide-message-square') });
    await replyButton.click();

    // Thread panel should open
    const threadPanel = page.getByTestId('thread-panel');
    await expect(threadPanel).toBeVisible({ timeout: 5000 });

    // Thread panel should show the parent message
    await expect(threadPanel.getByText(uniqueText)).toBeVisible();

    // Type a reply in the thread Quill editor
    const threadEditor = threadPanel.locator('.ql-editor');
    await threadEditor.click();
    await page.keyboard.type('This is a reply', { delay: 10 });
    await page.keyboard.press('Enter');

    // Reply should appear in the thread panel
    await expect(threadPanel.getByText('This is a reply')).toBeVisible({ timeout: 5000 });

    // Original message should now show "1 reply"
    await expect(messageRow.first().getByText('1 reply')).toBeVisible({ timeout: 5000 });
  });

  test('thread panel shows multiple replies', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'MultiReply', email, TEST_PASSWORD);

    await page.getByTestId('sidebar').locator('button').filter({ has: page.locator('span.truncate', { hasText: 'general' }) }).first().click();
    await page.waitForTimeout(500);

    // Send unique parent message
    const uniqueText = `Multi-reply ${Date.now()}`;
    await sendMessage(page, uniqueText);

    const messageRow = page.locator('.group.relative.flex.px-5').filter({ hasText: uniqueText });
    await expect(messageRow.first()).toBeVisible({ timeout: 10000 });

    // Open thread
    await messageRow.first().hover();
    const replyButton = messageRow.first().locator('button').filter({ has: page.locator('.lucide-message-square') });
    await replyButton.click();

    const threadPanel = page.getByTestId('thread-panel');
    await expect(threadPanel).toBeVisible({ timeout: 5000 });

    // Send two replies
    const threadEditor = threadPanel.locator('.ql-editor');
    await threadEditor.click();
    await page.keyboard.type('Reply one', { delay: 10 });
    await page.keyboard.press('Enter');
    await expect(threadPanel.getByText('Reply one')).toBeVisible({ timeout: 5000 });

    await threadEditor.click();
    await page.keyboard.type('Reply two', { delay: 10 });
    await page.keyboard.press('Enter');
    await expect(threadPanel.getByText('Reply two')).toBeVisible({ timeout: 5000 });

    // Should show "2 replies" on the parent message
    await expect(messageRow.first().getByText('2 replies')).toBeVisible({ timeout: 5000 });
  });
});
