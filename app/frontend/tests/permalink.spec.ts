import { test, expect, type Page } from '@playwright/test';
import { register, uniqueEmail, sendMessage, waitForMessage, clickChannel, waitForChannelReady, TEST_PASSWORD } from './helpers';

const API = 'http://localhost:3000';

async function token(page: Page): Promise<string> {
  return (await page.evaluate(() => localStorage.getItem('token')))!;
}

const row = (page: Page, text: string) =>
  page.locator('.group.relative.flex.px-5').filter({ hasText: text }).first();

test.describe('Message permalink', () => {
  test('copy link, open it, highlight, edit keeps it, delete makes it not found', async ({ browser }) => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    await register(page, `PermalinkUser_${Date.now()}`, uniqueEmail(), TEST_PASSWORD);
    await clickChannel(page, 'general');
    await waitForChannelReady(page);

    // Create
    const text = `permalink-${Date.now()}`;
    await sendMessage(page, text);
    await waitForMessage(page, text);
    const id = Number(await row(page, text).getAttribute('data-message-id'));

    // 링크 복사
    await row(page, text).hover();
    await page.locator('.absolute.-top-4.end-5').first().locator('[title="More actions"]').click();
    await page.getByTestId('copy-link-btn').click();
    await expect(page.getByTestId('toast')).toBeVisible();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toBe(`${new URL(page.url()).origin}${new URL(link).pathname}`);
    expect(new URL(link).pathname).toMatch(new RegExp(`^/c/\\d+/m/${id}$`));

    // Read: 링크로 이동하면 메시지가 강조됐다가 사라진다
    await page.goto(link);
    await waitForMessage(page, text);
    await expect(row(page, text).locator('xpath=..')).toHaveClass(/bg-yellow-100/);
    await expect(row(page, text).locator('xpath=..')).not.toHaveClass(/bg-yellow-100/, { timeout: 5000 });

    // Update: 수정해도 링크가 유효하다
    const auth = { Authorization: `Bearer ${await token(page)}` };
    const edited = `${text}-edited`;
    expect((await page.request.patch(`${API}/messages/${id}`, { headers: auth, data: { content: edited } })).ok()).toBeTruthy();
    await page.goto(link);
    await waitForMessage(page, edited);

    // Delete: 삭제 뒤에는 not found
    expect((await page.request.delete(`${API}/messages/${id}`, { headers: auth })).ok()).toBeTruthy();
    await page.goto(link);
    await expect(page.getByTestId('permalink-not-found')).toBeVisible({ timeout: 10_000 });
    await context.close();
  });

  test('a non-member of a private channel sees the same not-found screen', async ({ browser }) => {
    const ownerCtx = await browser.newContext();
    const owner = await ownerCtx.newPage();
    await register(owner, `PlkOwner_${Date.now()}`, uniqueEmail(), TEST_PASSWORD);
    const auth = { Authorization: `Bearer ${await token(owner)}` };
    const channel = await (await owner.request.post(`${API}/channels`, {
      headers: auth,
      data: { name: `plk-${Date.now()}`, isPrivate: true },
    })).json();
    const msg = await (await owner.request.post(`${API}/channels/${channel.id}/messages`, {
      headers: auth,
      data: { content: 'secret permalink' },
    })).json();

    const outsiderCtx = await browser.newContext();
    const outsider = await outsiderCtx.newPage();
    await register(outsider, `PlkOutsider_${Date.now()}`, uniqueEmail(), TEST_PASSWORD);
    await outsider.goto(`/c/${channel.id}/m/${msg.id}`);
    await expect(outsider.getByTestId('permalink-not-found')).toBeVisible({ timeout: 10_000 });
    await expect(outsider.getByText('secret permalink')).toHaveCount(0);

    await ownerCtx.close();
    await outsiderCtx.close();
  });
});
