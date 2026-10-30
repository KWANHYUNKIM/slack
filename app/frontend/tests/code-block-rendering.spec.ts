import { test, expect } from '@playwright/test';
import { register, uniqueEmail, clickChannel, waitForChannelReady , TEST_PASSWORD } from './helpers';

test.describe('Code block rendering', () => {
  test('code block toolbar button creates properly rendered code block', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'CodeBlockUser', email, TEST_PASSWORD);
    await clickChannel(page, 'general');
    await waitForChannelReady(page);

    const editor = page.locator('.ql-editor');
    await editor.click();

    // Click the code-block toolbar button
    const toolbar = page.getByTestId('formatting-toolbar');
    const codeBlockBtn = toolbar.locator('button[title="Code Block"]');
    await codeBlockBtn.click();

    // Type code content
    await page.keyboard.type('const x = 42;', { delay: 10 });

    // Send the message
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    // Wait for message to appear and verify it renders as a code block (pre > code)
    const messageArea = page.locator('.group.relative.flex.px-5').last();
    await expect(messageArea.locator('pre code')).toBeVisible({ timeout: 10_000 });
    await expect(messageArea.locator('pre code')).toContainText('const x = 42;');
  });
});
