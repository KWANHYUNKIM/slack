import { test, expect } from '@playwright/test';
import { login, clickChannel, waitForChannelReady , TEST_PASSWORD } from './helpers';

test.describe('Composer draft isolation', () => {
  test('switching channels clears the message composer (#78)', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);
    await clickChannel(page, 'general');
    await waitForChannelReady(page);

    // Type something in the composer
    const editor = page.locator('.ql-editor');
    await editor.click();
    await page.keyboard.type('Hello engineering draft');

    // Verify text is there
    await expect(editor).toContainText('Hello engineering draft');

    // Switch to another channel
    await clickChannel(page, 'random');
    await waitForChannelReady(page);

    // Composer should be empty
    const editorAfter = page.locator('.ql-editor');
    await expect(editorAfter).not.toContainText('Hello engineering draft');
  });
});
