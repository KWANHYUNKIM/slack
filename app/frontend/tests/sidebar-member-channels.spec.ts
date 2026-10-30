import { test, expect } from '@playwright/test';
import { login, register, uniqueEmail , TEST_PASSWORD } from './helpers';

test.describe('Sidebar member channels filter', () => {
  test('logged-in user only sees channels they are a member of', async ({ page }) => {
    // Log in as Nathan who is a member of all 8 public channels but not the
    // private "founders" channel (Hank, Iris, Jack only).
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);

    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();

    // All 8 public seeded channels that Nathan belongs to should appear.
    const memberChannels = [
      'general',
      'random',
      'engineering',
      'ml-research',
      'product',
      'design',
      'devops',
      'announcements',
    ];
    for (const name of memberChannels) {
      await expect(
        sidebar.locator('button').filter({ has: page.locator('span.truncate', { hasText: name }) }).first()
      ).toBeVisible({ timeout: 10_000 });
    }

    // "founders" is private and Nathan is NOT a member — it must not appear.
    await expect(
      sidebar.locator('button').filter({ has: page.locator('span.truncate', { hasText: 'founders' }) }).first()
    ).not.toBeVisible({ timeout: 3_000 });
  });

  test('newly registered user only sees default member channels, not all channels', async ({ page }) => {
    // Register a fresh user. New users are auto-joined to general + random only.
    const email = uniqueEmail();
    await register(page, 'Sidebar Tester', email, TEST_PASSWORD);

    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();

    // The user should see general and random (auto-joined).
    await expect(
      sidebar.locator('button').filter({ has: page.locator('span.truncate', { hasText: 'general' }) }).first()
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      sidebar.locator('button').filter({ has: page.locator('span.truncate', { hasText: 'random' }) }).first()
    ).toBeVisible({ timeout: 10_000 });

    // Create a second channel via the API in another context — this simulates a
    // channel the user is NOT a member of. Then verify the sidebar channel count
    // does not include non-member channels.
    //
    // Count only the channel buttons rendered inside the sidebar's Channels section.
    // We do this by counting buttons with a '#' prefix icon sibling, which is how
    // public channels are rendered via ChannelItem.
    const channelButtons = sidebar.locator('button').filter({
      has: page.locator('span.truncate'),
    });

    // After registration the user is in general + random → count should be 2.
    // (Private channels the user belongs to would appear under the same section,
    // but a fresh user has none.)
    const count = await channelButtons.count();
    // There may be additional UI buttons (e.g. "Add channels") but those don't
    // have a span.truncate child, so the count reflects member channels only.
    expect(count).toBe(2);
  });

  test('non-member channel created by another user does not appear in sidebar', async ({ page }) => {
    // Register user A who will create a channel.
    const emailA = uniqueEmail();
    await register(page, 'Channel Creator', emailA, TEST_PASSWORD);
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();

    // Create a channel as user A (they become a member).
    const channelName = `non-member-${Date.now()}`;
    await page.locator('button').filter({ hasText: 'Add channels' }).click();
    const nameInput = page.getByPlaceholder(/plan-budget/i);
    await expect(nameInput).toBeVisible({ timeout: 3_000 });
    await nameInput.fill(channelName);
    const responsePromise = page.waitForResponse(
      (resp) => resp.url().includes('/channels') && resp.request().method() === 'POST'
    );
    await page.getByRole('button', { name: /create$/i }).click();
    await responsePromise;

    // The channel should appear for user A (they are the creator/member).
    await expect(
      sidebar.locator('button').filter({ has: page.locator('span.truncate', { hasText: channelName }) }).first()
    ).toBeVisible({ timeout: 5_000 });

    // Now register a fresh user B in a new context and verify the channel does
    // NOT appear in their sidebar (they are not a member).
    const emailB = uniqueEmail();
    const contextB = await page.context().browser()!.newContext();
    const pageB = await contextB.newPage();
    await register(pageB, 'Non Member User', emailB, TEST_PASSWORD);

    const sidebarB = pageB.getByTestId('sidebar');
    await expect(sidebarB).toBeVisible({ timeout: 10_000 });

    // The channel created by A should not be visible for B.
    await expect(
      sidebarB.locator('button').filter({ has: pageB.locator('span.truncate', { hasText: channelName }) }).first()
    ).not.toBeVisible({ timeout: 3_000 });

    await contextB.close();
  });
});
