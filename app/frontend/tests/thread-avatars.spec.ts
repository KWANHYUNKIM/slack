import { test, expect } from '@playwright/test';
import { login, clickChannel , TEST_PASSWORD } from './helpers';

test.describe('Bug fix: Thread panel avatars', () => {
  test('thread panel shows profile photo img elements (not just initials)', async ({ page }) => {
    // Log in as the seeded user who has existing threaded messages
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);

    // Navigate to #engineering which has seeded thread replies
    // Seeded users in engineering have randomuser.me avatars, so their threads will have img elements
    await clickChannel(page, 'engineering');
    await expect(page.locator('.ql-editor')).toBeVisible({ timeout: 5000 });

    // Wait for at least one threaded message to appear (seeded data has threads in engineering)
    const messageRowLocator = page
      .locator('.group.relative.flex.px-5')
      .filter({ has: page.locator('[data-testid="thread-avatars"]') })
      .first();

    // Wait up to 8s for seeded threads to appear; seeded users have avatars
    await expect(messageRowLocator).toBeVisible({ timeout: 8000 });
    const messageRow = messageRowLocator;

    // Click the thread indicator button to open the thread panel
    const threadButton = messageRow.locator('[data-testid="thread-avatars"]').locator('..');
    await threadButton.click();

    // Thread panel should open
    const threadPanel = page.getByTestId('thread-panel');
    await expect(threadPanel).toBeVisible({ timeout: 5000 });

    // Wait for thread content to load (loading state gone)
    await expect(threadPanel.getByText('Loading thread...')).toHaveCount(0, { timeout: 5000 });

    // The parent message section is the first block in the thread panel scroll area
    // The Avatar with src renders an <img> tag; without src it renders a <span> with initials
    // Verify the parent message avatar is an <img> with a real src
    const parentSection = threadPanel.locator('.mb-4.pb-3').first();
    await expect(parentSection).toBeVisible({ timeout: 5000 });

    const parentAvatarImg = parentSection.locator('img').first();
    await expect(parentAvatarImg).toBeVisible({ timeout: 5000 });

    const parentSrc = await parentAvatarImg.getAttribute('src');
    expect(parentSrc).toBeTruthy();
    expect(parentSrc).not.toBe('');

    // If there are replies, verify reply avatars also render as <img> with a real src
    const replySections = threadPanel.locator('.mb-3');
    const replyCount = await replySections.count();
    if (replyCount > 0) {
      const replyAvatarImg = replySections.first().locator('img').first();
      const replyImgCount = await replyAvatarImg.count();
      if (replyImgCount > 0) {
        const replySrc = await replyAvatarImg.getAttribute('src');
        expect(replySrc).toBeTruthy();
        expect(replySrc).not.toBe('');
      }
    }
  });
});
