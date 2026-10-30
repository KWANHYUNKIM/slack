import { test, expect } from '@playwright/test';
import { register, uniqueEmail , TEST_PASSWORD } from './helpers';

test.describe('DM formatting toolbar', () => {
  test('DM composer has formatting toolbar and action buttons', async ({ browser }) => {
    const ts = Date.now();
    const email1 = uniqueEmail();
    const email2 = uniqueEmail();

    // Register two users
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    await register(page1, `Sender${ts}`, email1, TEST_PASSWORD);

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await register(page2, `Receiver${ts}`, email2, TEST_PASSWORD);

    // User 1 opens Add teammates dialog and starts DM
    await page1.getByText('Add teammates').click();
    await expect(page1.getByRole('heading', { name: 'Direct message' })).toBeVisible({ timeout: 5000 });
    await page1.getByTestId('teammate-search').fill(`Receiver${ts}`);
    const userButton = page1.getByRole('button', { name: new RegExp(`Receiver${ts}`) }).first();
    await expect(userButton).toBeVisible({ timeout: 5000 });
    await userButton.click();

    // DM conversation should be visible
    await expect(page1.getByTestId('dm-conversation')).toBeVisible({ timeout: 5000 });

    // Formatting toolbar should be present
    await expect(page1.getByTestId('formatting-toolbar')).toBeVisible({ timeout: 5000 });

    // Quill editor should be present
    await expect(page1.locator('.ql-editor')).toBeVisible({ timeout: 5000 });

    await context1.close();
    await context2.close();
  });
});
