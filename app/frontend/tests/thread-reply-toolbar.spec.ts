import { test, expect } from '@playwright/test';
import { register, uniqueEmail, clickChannel , TEST_PASSWORD } from './helpers';

test.describe('Thread reply formatting toolbar (#21)', () => {
  test('thread reply composer has formatting toolbar and action buttons', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'ThreadToolbarUser', email, TEST_PASSWORD);

    await clickChannel(page, 'general');
    await page.waitForTimeout(500);

    // Find a message with thread replies and click it
    const threadButton = page.locator('button').filter({ hasText: /repl/ }).first();
    await expect(threadButton).toBeVisible({ timeout: 10000 });
    await threadButton.click();

    // Wait for thread panel to open
    const threadPanel = page.getByTestId('thread-panel');
    await expect(threadPanel).toBeVisible({ timeout: 5000 });

    // Verify formatting toolbar exists in thread panel
    const toolbar = threadPanel.getByTestId('formatting-toolbar');
    await expect(toolbar).toBeVisible({ timeout: 5000 });

    // Verify action buttons exist (attach file, emoji, mention)
    await expect(threadPanel.getByTestId('thread-attach-file-button')).toBeVisible();
    await expect(threadPanel.locator('button[title="Emoji"]')).toBeVisible();
    await expect(threadPanel.getByTestId('thread-mention-button')).toBeVisible();

    // Verify the Quill editor is present (not a plain text input)
    const quillEditor = threadPanel.locator('.ql-editor');
    await expect(quillEditor).toBeVisible();
  });
});
