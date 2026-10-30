import { test, expect } from '@playwright/test';
import { login , TEST_PASSWORD } from './helpers';

test.describe('Files page', () => {
  test('Files nav icon navigates to full-page files view', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);

    // Click the Files nav item in the left rail
    await page.getByTestId('nav-item-files').click();

    // URL should change to /files
    await expect(page).toHaveURL(/\/files/);

    // The full-page files view should be visible (not an overlay)
    await expect(page.getByTestId('files-page')).toBeVisible({ timeout: 5000 });

    // The page should show "All files" heading
    await expect(page.getByText('All files')).toBeVisible();

    // Click Files again to go back
    await page.getByTestId('nav-item-files').click();
    await expect(page).not.toHaveURL(/\/files/);
  });
});
