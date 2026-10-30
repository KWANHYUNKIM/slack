import { test, expect } from '@playwright/test';
import { register, uniqueEmail, sendMessage, waitForMessage, clickChannel, waitForChannelReady , TEST_PASSWORD } from './helpers';

test.describe('Delete confirmation dialog', () => {
  test('deleting a message shows confirmation dialog (#83)', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, `DeleteTest_${Date.now()}`, email, TEST_PASSWORD);

    await clickChannel(page, 'general');
    await waitForChannelReady(page);

    const uniqueText = `delete-confirm-${Date.now()}`;
    await sendMessage(page, uniqueText);
    await waitForMessage(page, uniqueText);

    // Hover over the message
    const messageRow = page.locator('.group.relative.flex.px-5').filter({ hasText: uniqueText }).first();
    await messageRow.hover();

    // Click "..." more button
    const hoverToolbar = page.locator('.absolute.-top-4.right-5').first();
    await hoverToolbar.locator('[title="More actions"]').click();

    // Click "Delete message"
    await page.getByText('Delete message').click();

    // Confirmation dialog should appear
    const dialog = page.getByTestId('delete-confirm-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await expect(dialog.getByText("Are you sure you want to delete this message?")).toBeVisible();

    // Cancel should close the dialog without deleting
    await page.getByTestId('delete-cancel-btn').click();
    await expect(dialog).not.toBeVisible({ timeout: 3000 });

    // Message should still be there
    await expect(page.getByText(uniqueText)).toBeVisible();

    // Now actually delete: hover and click delete again
    await page.waitForTimeout(500);
    await messageRow.hover();
    await page.waitForTimeout(300);
    const moreBtn2 = page.locator('.absolute.-top-4.right-5').first().locator('[title="More actions"]');
    await expect(moreBtn2).toBeVisible({ timeout: 3000 });
    await moreBtn2.click();
    await page.getByText('Delete message').click();
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await page.getByTestId('delete-confirm-btn').click();

    // Message should be deleted
    await expect(page.getByText(uniqueText)).not.toBeVisible({ timeout: 5000 });
  });
});
