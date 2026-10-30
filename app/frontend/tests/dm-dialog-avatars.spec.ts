import { test, expect } from '@playwright/test';
import { login , TEST_PASSWORD } from './helpers';

test.describe('DM dialog avatars', () => {
  test('direct message dialog shows real user avatars instead of initials', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);

    // Click the compose/pencil icon to open the DM dialog
    const composeBtn = page.getByTestId('sidebar').locator('button').filter({ has: page.locator('.lucide-square-pen') });
    await composeBtn.click();

    // Wait for the dialog to appear
    const dialog = page.getByText('Direct message').first();
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // The teammate list should load
    const searchInput = page.getByTestId('teammate-search');
    await expect(searchInput).toBeVisible();

    // Wait for teammates to load (at least one user should appear)
    const userButtons = page.locator('button').filter({ has: page.locator('img') });
    await expect(userButtons.first()).toBeVisible({ timeout: 10000 });

    // Verify that user avatars are real <img> elements, not just initial letters
    const avatarImages = page.locator('.fixed img');
    const count = await avatarImages.count();
    expect(count).toBeGreaterThan(0);
  });
});
