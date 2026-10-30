import { test, expect } from '@playwright/test';
import { register, uniqueEmail, sendMessage, clickChannel , TEST_PASSWORD } from './helpers';

test.describe('Markdown rendering in thread panel, pins, and search', () => {
  test('thread panel renders bold, italic, and code markdown as HTML elements', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'MarkdownUser', email, TEST_PASSWORD);

    await clickChannel(page, 'general');
    await page.waitForTimeout(500);

    // Send a message with markdown
    const uniqueSuffix = Date.now();
    const rawMessage = `MDtest${uniqueSuffix} **bold** *italic* \`code\``;
    await sendMessage(page, rawMessage);

    // Wait for the message to appear in the channel
    const messageRow = page.locator('.group.relative.flex.px-5').filter({ hasText: `MDtest${uniqueSuffix}` });
    await expect(messageRow.first()).toBeVisible({ timeout: 10000 });

    // Open the thread panel for this message
    await messageRow.first().hover();
    const replyButton = messageRow.first().locator('button').filter({ has: page.locator('.lucide-message-square') });
    await replyButton.click();

    const threadPanel = page.getByTestId('thread-panel');
    await expect(threadPanel).toBeVisible({ timeout: 5000 });

    // The parent message in thread panel should render markdown as HTML elements
    // Bold: **bold** → <strong>bold</strong>
    const boldEl = threadPanel.locator('strong').filter({ hasText: 'bold' });
    await expect(boldEl).toBeVisible({ timeout: 5000 });

    // Italic: *italic* → <em>italic</em>
    const italicEl = threadPanel.locator('em').filter({ hasText: 'italic' });
    await expect(italicEl).toBeVisible({ timeout: 5000 });

    // Code: `code` → <code>code</code>
    const codeEl = threadPanel.locator('code').filter({ hasText: 'code' });
    await expect(codeEl).toBeVisible({ timeout: 5000 });

    // Raw markdown should NOT appear as plain text
    await expect(threadPanel.getByText('**bold**', { exact: false })).not.toBeVisible();
    await expect(threadPanel.getByText('`code`', { exact: false })).not.toBeVisible();

    // Send a reply with markdown too
    const threadEditor = threadPanel.locator('.ql-editor');
    const replyText = `Reply **strong** \`snippet\``;
    await threadEditor.click();
    await page.keyboard.type(replyText, { delay: 10 });
    await page.keyboard.press('Enter');

    // Wait for the reply to appear
    await expect(threadPanel.locator('strong').filter({ hasText: 'strong' })).toBeVisible({ timeout: 5000 });
    await expect(threadPanel.locator('code').filter({ hasText: 'snippet' })).toBeVisible({ timeout: 5000 });
  });
});
