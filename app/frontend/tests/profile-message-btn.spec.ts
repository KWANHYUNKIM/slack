import { test, expect } from '@playwright/test';
import { login, clickChannel , TEST_PASSWORD } from './helpers';

test.describe('Profile Message button', () => {
  test('clicking Message button in another user profile opens DM', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);
    await clickChannel(page, 'product');

    // Wait for messages to load
    await expect(page.locator('.group.relative.flex.px-5').first()).toBeVisible({ timeout: 10_000 });

    // Click on another user's name to open their profile
    const senderName = page.locator('[data-testid="sender-name"]').filter({ hasText: /^(?!Nathan Cavaglione)/ }).first();
    await senderName.click();

    // Profile modal should appear
    await expect(page.getByTestId('profile-modal')).toBeVisible({ timeout: 5_000 });

    // Message button should be visible
    const messageBtn = page.getByTestId('profile-message-btn');
    await expect(messageBtn).toBeVisible();

    // Click the Message button
    await messageBtn.click();

    // Profile modal should close
    await expect(page.getByTestId('profile-modal')).not.toBeVisible({ timeout: 3_000 });

    // Should now be in a DM view (composer should say "Message <user>")
    await expect(page.locator('.ql-editor')).toBeVisible({ timeout: 5_000 });
  });
});
