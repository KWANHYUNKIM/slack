import { test, expect } from '@playwright/test';
import { login, clickChannel, waitForChannelReady , TEST_PASSWORD } from './helpers';

test.describe('Search results avatars and timestamps (#28)', () => {
  test('search results show user avatar and timestamp', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);
    await clickChannel(page, 'general');
    await waitForChannelReady(page);

    // Search for a term that should match seed data
    const searchInput = page.locator('input[placeholder="Search"]');
    await searchInput.fill('Series A');
    // 입력하면 300ms 뒤 드롭다운 미리보기가 열린다(Enter는 /search 페이지로 이동한다)

    // Wait for results
    const resultItem = page.getByTestId('search-result-item').first();
    await expect(resultItem).toBeVisible({ timeout: 5000 });

    // Should have an avatar image
    const avatar = resultItem.locator('img');
    await expect(avatar).toBeVisible();

    // Should have a timestamp
    const timestamp = resultItem.getByTestId('search-result-timestamp');
    await expect(timestamp).toBeVisible();
  });
});
