import { test, expect } from '@playwright/test';
import { login, clickChannel, waitForChannelReady , TEST_PASSWORD } from './helpers';

test.describe('mind_blown shortcode rendering', () => {
  test('mind_blown reaction renders as emoji not text', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);
    await clickChannel(page, 'general');
    await waitForChannelReady(page);

    // Find all reaction emoji spans
    const reactionEmojis = page.locator('[data-testid="reaction-emoji"]');
    await expect(reactionEmojis.first()).toBeVisible({ timeout: 10_000 });

    // None of the reaction emoji spans should display the raw text "mind_blown"
    const allTexts = await reactionEmojis.allTextContents();
    for (const text of allTexts) {
      expect(text).not.toBe('mind_blown');
    }

    // Verify at least one reaction shows the 🤯 emoji (exploding_head)
    expect(allTexts.some((t) => t === '🤯')).toBe(true);
  });
});
