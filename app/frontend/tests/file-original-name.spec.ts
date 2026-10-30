import { test, expect } from '@playwright/test';
import { register, uniqueEmail, clickChannel , TEST_PASSWORD } from './helpers';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_FILE_DIR = path.join(__dirname, 'test-fixtures');
const TEST_TXT_PATH = path.join(TEST_FILE_DIR, 'test-document.txt');

test.beforeAll(async () => {
  if (!fs.existsSync(TEST_FILE_DIR)) {
    fs.mkdirSync(TEST_FILE_DIR, { recursive: true });
  }
  if (!fs.existsSync(TEST_TXT_PATH)) {
    fs.writeFileSync(TEST_TXT_PATH, 'Hello, this is a test document.');
  }
});

test.describe('File Original Name Display (#24)', () => {
  test('uploaded file shows original filename in message after page reload', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'FileNameUser', email, TEST_PASSWORD);

    await clickChannel(page, 'general');
    await page.waitForTimeout(500);

    // Upload a text file
    const attachButton = page.getByTestId('attach-file-button');
    await expect(attachButton).toBeVisible();

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      attachButton.click(),
    ]);

    await fileChooser.setFiles(TEST_TXT_PATH);
    await expect(page.getByTestId('file-preview')).toBeVisible({ timeout: 5000 });

    // Send message with attached file
    const uniqueText = `File name test ${Date.now()}`;
    const editor = page.locator('.ql-editor');
    await editor.click();
    await page.keyboard.type(uniqueText, { delay: 10 });
    await page.keyboard.press('Enter');

    // Wait for the message to appear
    const messageRow = page.locator('.group.relative.flex.px-5').filter({ hasText: uniqueText });
    await expect(messageRow.first()).toBeVisible({ timeout: 10000 });

    // File attachment should show original name
    const fileAttachment = messageRow.first().locator('[data-testid="message-file"]');
    await expect(fileAttachment).toBeVisible({ timeout: 10000 });
    await expect(fileAttachment).toContainText('test-document.txt');

    // Reload page to test GET endpoint (not just WebSocket response)
    await page.reload();
    await page.waitForTimeout(1000);

    // Navigate back to general channel
    await clickChannel(page, 'general');
    await page.waitForTimeout(500);

    // Find our message again after reload
    const reloadedRow = page.locator('.group.relative.flex.px-5').filter({ hasText: uniqueText });
    await expect(reloadedRow.first()).toBeVisible({ timeout: 10000 });

    // File should still show original name (not server-generated name)
    const reloadedFile = reloadedRow.first().locator('[data-testid="message-file"]');
    await expect(reloadedFile).toBeVisible({ timeout: 10000 });
    await expect(reloadedFile).toContainText('test-document.txt');

    // Verify it does NOT contain a server-generated numeric filename pattern
    const fileText = await reloadedFile.textContent();
    expect(fileText).not.toMatch(/\d{13,}-\d+\.txt/);
  });
});
