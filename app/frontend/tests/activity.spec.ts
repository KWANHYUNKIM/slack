import { test, expect, type Page } from '@playwright/test';
import { register, uniqueEmail, waitForMessage, clickChannel, waitForChannelReady, TEST_PASSWORD } from './helpers';

const ROW = '.group.relative.flex.px-5';

async function editMessage(page: Page, current: string, next: string) {
  await page.locator(ROW).filter({ hasText: current }).hover();
  await page.locator('.absolute.-top-4.right-5').locator('button').last().click();
  await page.getByText('Edit message').click();
  await page.locator('textarea').fill(next);
  await page.keyboard.press('Enter');
}

test.describe('Activity: mentions', () => {
  test('mention -> badge and activity item -> edit removes it -> delete cleans up', async ({ browser }) => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const targetName = `Mentee${suffix}`;

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await register(pageB, targetName, uniqueEmail(), TEST_PASSWORD);
    // B waits on the Files page so #general is not the open channel
    await pageB.getByTestId('nav-item-files').click();

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await register(pageA, `Mentioner${suffix}`, uniqueEmail(), TEST_PASSWORD);
    await clickChannel(pageA, 'general');
    await waitForChannelReady(pageA);

    // Create: A mentions B through the autocomplete
    const body = `ping ${Date.now()}`;
    const editor = pageA.locator('.ql-editor');
    await editor.click();
    await pageA.keyboard.type(`@${targetName}`, { delay: 10 });
    await expect(pageA.getByTestId('mention-dropdown')).toBeVisible();
    await pageA.keyboard.press('Enter');
    await pageA.keyboard.type(` ${body}`, { delay: 10 });
    await pageA.keyboard.press('Enter');
    await waitForMessage(pageA, body);

    // Read: B sees the rail badge, the channel mention badge and the activity item
    await expect(pageB.getByTestId('nav-item-activity')).toContainText('1', { timeout: 15_000 });
    await expect(pageB.getByTestId('mention-badge').first()).toBeVisible();
    await pageB.getByTestId('nav-item-activity').click();
    const item = pageB.getByTestId('activity-item').filter({ hasText: body });
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('data-unread', 'true');

    // Other tabs filter by type
    await pageB.getByTestId('activity-tab-reactions').click();
    await expect(pageB.getByTestId('activity-empty')).toBeVisible();
    await pageB.getByTestId('activity-tab-mentions').click();
    await expect(item).toBeVisible();

    // Update: A edits the mention away -> the item disappears for B
    await editMessage(pageA, body, `no mention now ${suffix}`);
    await expect(item).toHaveCount(0, { timeout: 15_000 });

    // Mention again, then B opens it: navigates to the channel and marks it read
    const body2 = `again ${Date.now()}`;
    await editor.click();
    await pageA.keyboard.type(`@${targetName}`, { delay: 10 });
    await expect(pageA.getByTestId('mention-dropdown')).toBeVisible();
    await pageA.keyboard.press('Enter');
    await pageA.keyboard.type(` ${body2}`, { delay: 10 });
    await pageA.keyboard.press('Enter');
    await waitForMessage(pageA, body2);

    const item2 = pageB.getByTestId('activity-item').filter({ hasText: body2 });
    await expect(item2).toBeVisible({ timeout: 15_000 });
    await item2.click();
    await expect(pageB).toHaveURL(/\/c\/\d+/);
    await waitForMessage(pageB, body2);
    await pageB.getByTestId('nav-item-activity').click();
    await expect(pageB.getByTestId('activity-item').filter({ hasText: body2 })).toHaveAttribute('data-unread', 'false');

    // Delete: A deletes the message -> item gone for B
    await pageA.locator(ROW).filter({ hasText: body2 }).hover();
    await pageA.locator('.absolute.-top-4.right-5').locator('button').last().click();
    await pageA.getByText('Delete message').click();
    const confirmButton = pageA.getByRole('button', { name: /delete|confirm/i });
    if (await confirmButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await confirmButton.click();
    }
    await expect(pageB.getByTestId('activity-item').filter({ hasText: body2 })).toHaveCount(0, { timeout: 15_000 });

    await ctxA.close();
    await ctxB.close();
  });
});
