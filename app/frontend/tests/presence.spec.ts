import { test, expect } from '@playwright/test';
import { register, uniqueEmail , TEST_PASSWORD } from './helpers';

test.describe('User Presence', () => {
  test('logged-in user shows online status indicator', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'Presence User', email, TEST_PASSWORD);

    // The user's own avatar in the sidebar should show an online indicator (green dot)
    const avatarButton = page.getByTestId('user-menu-button');
    await expect(avatarButton).toBeVisible();

    // The status dot should be visible and green (online)
    const statusDot = avatarButton.locator('.bg-green-500');
    await expect(statusDot).toBeVisible();
  });
});
