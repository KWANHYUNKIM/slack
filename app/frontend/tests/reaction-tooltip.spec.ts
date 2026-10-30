import { test, expect } from '@playwright/test';
import { login , TEST_PASSWORD } from './helpers';

test.describe('Reaction tooltip', () => {
  test('hovering a reaction pill shows tooltip with user names', async ({ page }) => {
    // Login as the seeded user (Nathan Cavaglione) who has channels with reactions
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);

    // Navigate to #product which has reactions in the seed data
    const sidebar = page.getByTestId('sidebar');
    await sidebar
      .locator('button')
      .filter({ has: page.locator('span.truncate', { hasText: 'product' }) })
      .first()
      .click();

    // Wait for messages to load
    await expect(page.locator('.group.relative.flex.px-5').first()).toBeVisible({ timeout: 10_000 });

    // Find a reaction button with a title attribute (tooltip)
    const reactionBtn = page.locator('button[title*="reacted with"]').first();
    await expect(reactionBtn).toBeVisible({ timeout: 5_000 });

    // Verify the tooltip contains user name(s) and "reacted with"
    const title = await reactionBtn.getAttribute('title');
    expect(title).toMatch(/reacted with/);
    // Should contain at least one name
    expect(title!.split('reacted with')[0].trim().length).toBeGreaterThan(0);
  });
});
