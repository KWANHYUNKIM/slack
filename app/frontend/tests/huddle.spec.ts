import { test, expect, type Page } from '@playwright/test';
import { login , TEST_PASSWORD } from './helpers';

// Huddle tests need two browser contexts communicating in real-time.
// Run serially to avoid state conflicts between tests.
test.describe.configure({ mode: 'serial' });

// Use seed users to avoid registration rate limits.
const USER_A = { email: 'bob@slawk.dev', password: TEST_PASSWORD, name: 'Bob Martinez' };
const USER_B = { email: 'carol@slawk.dev', password: TEST_PASSWORD, name: 'Carol Smith' };

/**
 * Get the current user's ID and find the other user's ID from the users API.
 */
async function getUserId(page: Page, targetName: string): Promise<number> {
  return page.evaluate(async (name) => {
    const token = localStorage.getItem('token');
    const res = await fetch('/users', { headers: { Authorization: `Bearer ${token}` } });
    const users = await res.json();
    const user = users.find((u: any) => u.name === name);
    return user?.id;
  }, targetName);
}

/**
 * Set up two seed users logged in, both viewing their mutual DM via URL navigation.
 */
async function setupTwoUsersInDM(browser: import('@playwright/test').Browser) {
  const ctx1 = await browser.newContext({ permissions: ['microphone'] });
  const ctx2 = await browser.newContext({ permissions: ['microphone'] });
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();

  await login(page1, USER_A.email, USER_A.password);
  await login(page2, USER_B.email, USER_B.password);

  // Get user IDs for direct URL navigation
  const userBId = await getUserId(page1, USER_B.name);
  const userAId = await getUserId(page2, USER_A.name);

  // Bootstrap the DM conversation by sending an initial message via API.
  // This ensures both users have the DM in their sidebar/store.
  await page1.evaluate(async (toUserId) => {
    const token = localStorage.getItem('token');
    await fetch('/dms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ toUserId, content: 'hey' }),
    });
  }, userBId);

  // Navigate directly to the DM conversation via URL
  await page1.goto(`/d/${userBId}`);
  await expect(page1.getByTestId('dm-conversation')).toBeVisible({ timeout: 10000 });

  await page2.goto(`/d/${userAId}`);
  await expect(page2.getByTestId('dm-conversation')).toBeVisible({ timeout: 10000 });

  // Wait for WebSocket connections to establish
  await page1.waitForTimeout(1000);
  await page2.waitForTimeout(1000);

  return { ctx1, ctx2, page1, page2 };
}

/**
 * Click the huddle (headphones) button in the DM header.
 */
async function clickStartHuddle(page: Page): Promise<void> {
  const btn = page.locator('button[title="Start huddle"]');
  await expect(btn).toBeVisible({ timeout: 5000 });
  await btn.click();
}

/**
 * Start a huddle between two users (invite + accept).
 */
async function startHuddle(page1: Page, page2: Page): Promise<void> {
  await clickStartHuddle(page1);
  await expect(page2.getByTestId('huddle-incoming-call')).toBeVisible({ timeout: 15000 });
  await page2.getByRole('button', { name: 'Accept' }).click();
  await expect(page1.locator('button[title="Leave huddle"]')).toBeVisible({ timeout: 15000 });
  await expect(page2.locator('button[title="Leave huddle"]')).toBeVisible({ timeout: 15000 });
}

test.describe('Huddle', () => {
  test('invite and accept flow shows huddle bar on both sides', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2 } = await setupTwoUsersInDM(browser);

    await clickStartHuddle(page1);

    // User A should see "Calling..." state
    await expect(page1.getByText('Calling...')).toBeVisible({ timeout: 5000 });

    // User B should see incoming call notification
    await expect(page2.getByTestId('huddle-incoming-call')).toBeVisible({ timeout: 15000 });

    // User B accepts
    await page2.getByRole('button', { name: 'Accept' }).click();

    // Both should see the HuddleBar with leave button
    await expect(page1.locator('button[title="Leave huddle"]')).toBeVisible({ timeout: 15000 });
    await expect(page2.locator('button[title="Leave huddle"]')).toBeVisible({ timeout: 15000 });

    // User A leaves
    await page1.locator('button[title="Leave huddle"]').click();

    // HuddleBar should disappear for both
    await expect(page1.locator('button[title="Leave huddle"]')).not.toBeVisible({ timeout: 10000 });
    await expect(page2.locator('button[title="Leave huddle"]')).not.toBeVisible({ timeout: 10000 });

    // "Huddle ended" message should appear in DM (use .last() since prior tests may leave messages)
    await expect(page1.getByText(/Huddle ended/).last()).toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('decline removes the incoming call and notifies sender', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2 } = await setupTwoUsersInDM(browser);

    await clickStartHuddle(page1);
    await expect(page1.getByText('Calling...')).toBeVisible({ timeout: 5000 });
    await expect(page2.getByTestId('huddle-incoming-call')).toBeVisible({ timeout: 15000 });

    await page2.getByRole('button', { name: 'Decline' }).click();

    await expect(page2.getByTestId('huddle-incoming-call')).not.toBeVisible({ timeout: 5000 });
    await expect(page1.getByTestId('huddle-error')).toBeVisible({ timeout: 5000 });
    await expect(page1.getByText('Calling...')).not.toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('sender can cancel an outgoing invite', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2 } = await setupTwoUsersInDM(browser);

    await clickStartHuddle(page1);
    await expect(page1.getByText('Calling...')).toBeVisible({ timeout: 5000 });
    await expect(page2.getByTestId('huddle-incoming-call')).toBeVisible({ timeout: 15000 });

    await page1.locator('button[title="Cancel invite"]').click();

    await expect(page1.getByText('Calling...')).not.toBeVisible({ timeout: 5000 });
    await expect(page2.getByTestId('huddle-incoming-call')).not.toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('leaving huddle ends it for both users', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2 } = await setupTwoUsersInDM(browser);

    await startHuddle(page1, page2);

    // User B leaves
    await page2.locator('button[title="Leave huddle"]').click();

    await expect(page1.locator('button[title="Leave huddle"]')).not.toBeVisible({ timeout: 10000 });
    await expect(page2.locator('button[title="Leave huddle"]')).not.toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('mute toggle works during huddle', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2 } = await setupTwoUsersInDM(browser);

    await startHuddle(page1, page2);

    // User A mutes
    await page1.locator('button[title="Mute"]').click();
    await expect(page1.locator('button[title="Unmute"]')).toBeVisible({ timeout: 3000 });

    // User B should see that User A is muted
    await expect(page2.getByText('(muted)')).toBeVisible({ timeout: 5000 });

    // User A unmutes
    await page1.locator('button[title="Unmute"]').click();
    await expect(page1.locator('button[title="Mute"]')).toBeVisible({ timeout: 3000 });

    await page1.locator('button[title="Leave huddle"]').click();
    await ctx1.close();
    await ctx2.close();
  });

  test('disconnecting ends the huddle for the other user', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2 } = await setupTwoUsersInDM(browser);

    await startHuddle(page1, page2);

    // User A closes their tab (simulates disconnect)
    await page1.close();

    await expect(page2.locator('button[title="Leave huddle"]')).not.toBeVisible({ timeout: 15000 });

    await ctx1.close();
    await ctx2.close();
  });

  test('huddle system messages render in DM', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2 } = await setupTwoUsersInDM(browser);

    await clickStartHuddle(page1);

    // Invite system message (use .last() since prior tests accumulate messages)
    await expect(page1.getByText('You sent a huddle invite.').last()).toBeVisible({ timeout: 10000 });
    await expect(page2.getByText('Sent you a huddle invite.').last()).toBeVisible({ timeout: 10000 });

    // Accept
    await page2.getByRole('button', { name: 'Accept' }).click();
    await expect(page1.locator('button[title="Leave huddle"]')).toBeVisible({ timeout: 15000 });

    // Started message
    await expect(page1.getByText('Huddle started').last()).toBeVisible({ timeout: 5000 });

    // Leave
    await page1.locator('button[title="Leave huddle"]').click();

    // Ended message
    await expect(page1.getByText(/Huddle ended/).last()).toBeVisible({ timeout: 5000 });

    await ctx1.close();
    await ctx2.close();
  });
});
