import { test, expect } from '@playwright/test';
import { login, clickChannel , TEST_PASSWORD } from './helpers';

test.describe('Search result navigation', () => {
  test('clicking a search result navigates to the channel and closes the dropdown', async ({ page }) => {
    // Use the seeded user who has access to all channels with seed data
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);

    // Start on #general channel
    await clickChannel(page, 'general');
    await expect(page.locator('.ql-editor')).toBeVisible();

    // Search for "semantic" — present in seed data in #ml-research and #engineering channels
    const searchInput = page.locator('input[placeholder="Search"]');
    await searchInput.fill('semantic');
    await searchInput.press('Enter');

    // Wait for search results dropdown to appear
    const searchDropdown = page.locator('[data-testid="search-results-dropdown"]');
    await expect(searchDropdown).toBeVisible({ timeout: 10_000 });

    // There should be at least one result
    const resultItems = page.locator('[data-testid="search-result-item"]');
    await expect(resultItems.first()).toBeVisible({ timeout: 5_000 });

    // Find a result that belongs to a specific channel (has channel info)
    // Get the channel name from the first result that shows a channel
    const firstResultWithChannel = resultItems.filter({ hasText: /#\w/ }).first();
    await expect(firstResultWithChannel).toBeVisible({ timeout: 5_000 });

    // Extract the channel name from the result
    const channelNameEl = firstResultWithChannel.locator('span.font-medium').last();
    const channelText = await channelNameEl.textContent();
    // channelText is like "#ml-research" — strip the leading #
    const channelName = channelText?.replace(/^#/, '') ?? '';
    expect(channelName.length).toBeGreaterThan(0);

    // Switch to a different channel first so navigation is detectable
    if (channelName !== 'general') {
      await clickChannel(page, 'general');
      // Re-open search dropdown
      await searchInput.fill('semantic');
      await searchInput.press('Enter');
      await expect(searchDropdown).toBeVisible({ timeout: 10_000 });
      await expect(resultItems.first()).toBeVisible({ timeout: 5_000 });
    }

    // Click the first result item
    await resultItems.first().click();

    // The search dropdown should be closed
    await expect(searchDropdown).not.toBeVisible({ timeout: 5_000 });

    // The search input should be cleared
    await expect(searchInput).toHaveValue('');

    // The message editor placeholder should reflect the navigated channel
    // (i.e. something changed — the channel header should show the target channel name)
    const channelHeader = page.locator('header').first();
    await expect(channelHeader).toContainText(channelName, { timeout: 5_000 });
  });

  test('search dropdown closes and input clears after clicking a result', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);

    await clickChannel(page, 'general');
    await expect(page.locator('.ql-editor')).toBeVisible();

    const searchInput = page.locator('input[placeholder="Search"]');
    await searchInput.fill('semantic');
    await searchInput.press('Enter');

    const searchDropdown = page.locator('[data-testid="search-results-dropdown"]');
    await expect(searchDropdown).toBeVisible({ timeout: 10_000 });

    const resultItems = page.locator('[data-testid="search-result-item"]');
    await expect(resultItems.first()).toBeVisible({ timeout: 5_000 });

    // Click first result
    await resultItems.first().click();

    // Dropdown must close
    await expect(searchDropdown).not.toBeVisible({ timeout: 5_000 });

    // Input must be cleared
    await expect(searchInput).toHaveValue('');
  });
});
