import { test, expect } from '@playwright/test';
import { login, register, uniqueEmail, TEST_USER , TEST_PASSWORD } from './helpers';

test.describe('Authentication', () => {
  test('user can register with name, email, password', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'New Tester', email, 'securepass123');

    // Should be on the main app with sidebar visible
    await expect(page.getByTestId('sidebar')).toBeVisible();
    // Should see channel list (general should exist by default)
    await expect(page.getByTestId('sidebar').locator('button').filter({ has: page.locator('span.truncate', { hasText: 'general' }) }).first()).toBeVisible();
  });

  test('user can login with email and password', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);

    // Should be on the main app with the sidebar visible
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('sidebar').locator('button').filter({ has: page.locator('span.truncate', { hasText: 'general' }) }).first()).toBeVisible();
  });

  test('login fails with wrong password', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('name@work-email.com').fill(TEST_USER.email);
    await page.getByPlaceholder('Password').fill('wrongpassword999');
    await page.getByRole('button', { name: /sign in with email/i }).click();

    // Should remain on the login page (not navigate away)
    await expect(page).toHaveURL(/\/login/);

    // Should show an error indication — either an alert, toast, or inline error
    // The login page should NOT transition to the channels view
    await expect(page.getByTestId('sidebar')).not.toBeVisible({ timeout: 3_000 });
  });

  test('login shows error message on invalid credentials', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('name@work-email.com').fill('alice@slawk.dev');
    await page.getByPlaceholder('Password').fill('wrongpassword999');
    await page.getByRole('button', { name: /sign in with email/i }).click();

    // Error alert should be visible
    const errorAlert = page.getByRole('alert');
    await expect(errorAlert).toBeVisible({ timeout: 5_000 });

    // Should remain on login page
    await expect(page).toHaveURL(/\/login/);
  });

  test('after successful login, user sees channels page', async ({ page }) => {
    // Register a fresh user first, then login
    const email = uniqueEmail();
    await register(page, 'Login Tester', email, TEST_PASSWORD);

    // The Slawk workspace header should be visible
    await expect(page.locator('text=Slawk')).toBeVisible();

    // Sidebar channel list should be visible
    await expect(page.getByTestId('sidebar')).toBeVisible();

    // At least the #general channel should be present
    await expect(page.getByTestId('sidebar').locator('button').filter({ has: page.locator('span.truncate', { hasText: 'general' }) }).first()).toBeVisible();

    // The message input area should be visible for the active channel
    await expect(page.locator('.ql-editor')).toBeVisible({ timeout: 10_000 });
  });
});
