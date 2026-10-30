import { test, expect } from '@playwright/test';
import { register, uniqueEmail, sendMessage, clickChannel , TEST_PASSWORD } from './helpers';

test.describe('Search result scrolls to matched message', () => {
  test('clicking a search result scrolls to and highlights the message', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'SearchScroller', email, TEST_PASSWORD);

    await clickChannel(page, 'general');
    await page.waitForTimeout(500);

    // Send a uniquely identifiable message
    const unique = `scrolltarget-${Date.now()}`;
    await sendMessage(page, unique);

    // Wait for it to appear
    const messageRow = page.locator('.group.relative.flex.px-5').filter({ hasText: unique });
    await expect(messageRow.first()).toBeVisible({ timeout: 10000 });

    // Send a couple more messages so the list has content
    for (let i = 0; i < 3; i++) {
      await sendMessage(page, `filler ${i} ${Date.now()}`);
      await page.waitForTimeout(300);
    }

    // Use the search bar to find the target message
    const searchInput = page.locator('header input[placeholder="Search"]');
    await searchInput.click();
    await searchInput.fill(unique);
    await page.keyboard.press('Enter');

    // Wait for search results dropdown
    const dropdown = page.getByTestId('search-results-dropdown');
    await expect(dropdown).toBeVisible({ timeout: 10000 });

    // Click the search result
    const resultItem = dropdown.getByTestId('search-result-item').first();
    await resultItem.click();

    // The message should be highlighted with yellow background
    await expect(messageRow.first()).toBeVisible({ timeout: 5000 });

    // Verify the highlight class is applied (bg-yellow-100)
    const wrapper = messageRow.first().locator('xpath=./ancestor::div[contains(@class, "bg-yellow-100")]');
    await expect(wrapper).toBeVisible({ timeout: 3000 });

    // After 2s the highlight should fade (class removed by React state)
    await page.waitForTimeout(3000);
    await expect(wrapper).not.toBeVisible({ timeout: 3000 });
  });
});
