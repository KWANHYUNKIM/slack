import { test, expect } from '@playwright/test';
import { login, clickChannel, sendMessage, waitForMessage, waitForChannelReady , TEST_PASSWORD } from './helpers';

test.describe('Mention click opens profile', () => {
  test('clicking an @mention of a real user opens their profile popup', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);
    await clickChannel(page, 'general');
    await waitForChannelReady(page);

    // Send a message with an @mention of a real user
    const msg = `Hey @Eve Johnson check this out ${Date.now()}`;
    await sendMessage(page, msg);
    await waitForMessage(page, msg);

    // Click the @mention
    const mention = page.locator('[data-mention-name="Eve Johnson"]').last();
    await expect(mention).toBeVisible({ timeout: 5_000 });
    await mention.click();

    // Profile modal should open showing Eve Johnson
    await expect(page.getByTestId('profile-modal')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('profile-modal').getByText('Eve Johnson')).toBeVisible();
  });
});
