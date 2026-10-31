import { test as base, expect, type Page, type BrowserContext } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { createHmac } from 'crypto';
import { fileURLToPath } from 'url';
import {
  login,
  register,
  uniqueEmail,
  sendMessage,
  waitForMessage,
  clickChannel,
  waitForChannelReady,
  TEST_PASSWORD,
} from './helpers';

/**
 * E2E 스모크(verify/e2e-smoke): 이번 세션에 머지된 기능의 핵심 흐름을 실제 브라우저로 만들고(Create),
 * 보고(Read), 고치고(Update), 지우는(Delete) 순서로 확인한다.
 * 문구는 하드코딩하지 않고 src/locales JSON에서 읽어 번역 키 기준으로 비교한다. 외부 URL은 쓰지 않는다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** locales/<lng>/<ns>.json에서 점 경로로 문자열을 읽는다. */
function tr(lng: 'en' | 'ko', ns: string, key: string): string {
  const json = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/locales', lng, `${ns}.json`), 'utf-8'));
  const value = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], json);
  if (typeof value !== 'string') throw new Error(`missing locale key ${lng}:${ns}:${key}`);
  return value;
}

/** 규칙 17: localhost 밖으로 나가는 요청·웹소켓이 하나도 없어야 한다(모든 테스트에 자동 적용). */
const test = base.extend<{ guard: string[] }>({
  guard: [
    async ({ context, baseURL }, use) => {
      const allowed = new URL(baseURL ?? 'http://localhost:5190').origin;
      const external: string[] = [];
      const check = (url: string) => {
        if (/^(data|blob|about):/.test(url)) return;
        const u = new URL(url);
        const origin = u.protocol === 'ws:' ? `http://${u.host}` : u.protocol === 'wss:' ? `https://${u.host}` : u.origin;
        if (origin !== allowed) external.push(url);
      };
      context.on('request', (req) => check(req.url()));
      context.on('page', (p) => p.on('websocket', (ws) => check(ws.url())));
      await use(external);
      expect(external, '외부 출처 요청').toEqual([]);
    },
    { auto: true },
  ],
});

const MSG = '.group.relative.flex.px-5';

function row(page: Page, text: string) {
  return page.locator(MSG).filter({ hasText: text }).first();
}

/** 메시지 행의 더보기(⋯) 메뉴를 연다. */
async function openActions(page: Page, text: string) {
  const r = row(page, text);
  await r.hover();
  await page.locator('.absolute.-top-4.end-5').locator('button').last().click();
}

async function openUserMenu(page: Page) {
  await page.getByTestId('user-menu-button').click();
}

async function logout(page: Page, lng: 'en' | 'ko' = 'en') {
  await openUserMenu(page);
  await page.getByRole('button', { name: tr(lng, 'sidebar', 'userMenu.signOut') }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** 새 사용자를 만들고 로그인된 상태의 페이지를 돌려준다. */
async function newUser(context: BrowserContext, name: string) {
  const page = await context.newPage();
  const email = uniqueEmail();
  await register(page, name, email, TEST_PASSWORD);
  return { page, email, name };
}

// ---- TOTP(RFC 6238, SHA-1, 6자리, 30초): 테스트 코드에서 Node crypto로 계산한다 ----
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of input.replace(/[\s=]/g, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1] & 0xf;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** 서버가 같은 시간 창의 코드를 두 번 받지 않을 수 있으므로, 이전에 쓴 창보다 뒤의 코드를 기다렸다가 돌려준다. */
let lastStep = 0;
async function freshCode(secret: string): Promise<string> {
  for (;;) {
    const step = Math.floor(Date.now() / 30_000);
    if (step > lastStep) {
      lastStep = step;
      return totp(secret, step);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

test.describe('E2E smoke', () => {
  test('가입, 로그아웃, 로그인, 틀린 비밀번호', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'Smoke Auth', email, TEST_PASSWORD);
    await logout(page);

    await login(page, email, TEST_PASSWORD);
    await logout(page);

    await page.getByPlaceholder('name@work-email.com').fill(email);
    await page.getByPlaceholder('Password').fill('definitely-wrong-1');
    await page.getByRole('button', { name: /sign in with email/i }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('채널 만들기, 메시지 작성·수정·리액션·핀·삭제', async ({ page }) => {
    await register(page, 'Smoke Chan', uniqueEmail(), TEST_PASSWORD);

    // Create channel
    const chName = `smoke-${Date.now().toString(36)}`;
    await page.getByRole('button', { name: tr('en', 'sidebar', 'sections.addChannels') }).click();
    await page.getByPlaceholder(tr('en', 'channels', 'dialog.namePlaceholder')).fill(chName);
    await page.getByRole('button', { name: tr('en', 'channels', 'dialog.create'), exact: true }).click();
    await expect(page.locator('.ql-editor')).toHaveAttribute('data-placeholder', `Message #${chName}`);
    await waitForChannelReady(page);

    // Create message
    const text = `smoke msg ${Date.now()}`;
    await sendMessage(page, text);
    await waitForMessage(page, text);

    // Update message
    await openActions(page, text);
    await page.getByText(tr('en', 'messages', 'actionsMenu.edit')).click();
    const edited = `${text} edited`;
    await page.keyboard.press('Control+a');
    await page.keyboard.type(edited);
    await page.keyboard.press('Enter');
    await waitForMessage(page, edited);

    // Reaction: create then read then delete
    await row(page, edited).hover();
    await page.locator('.absolute.-top-4.end-5').locator('button').first().click();
    const search = page.getByRole('searchbox').first();
    await expect(search).toBeVisible();
    await search.fill('thumbsup');
    await page.getByRole('button', { name: '👍', exact: true }).click();
    const pill = row(page, edited).locator('button').filter({ hasText: /👍/ });
    await expect(pill).toContainText('1');
    await pill.click();
    await expect(pill).toHaveCount(0);

    // Pin: create, read in the panel, delete
    await openActions(page, edited);
    await page.getByText(tr('en', 'messages', 'actionsMenu.pin'), { exact: true }).click();
    await expect(row(page, edited).getByTestId('pin-indicator')).toBeVisible();
    await page.getByRole('button', { name: 'Pins' }).click();
    await expect(page.getByTestId('pins-panel').getByText(edited)).toBeVisible();
    await openActions(page, edited);
    await page.getByText(tr('en', 'messages', 'actionsMenu.unpin'), { exact: true }).click();
    await expect(row(page, edited).getByTestId('pin-indicator')).toHaveCount(0);

    // Delete message
    await openActions(page, edited);
    await page.getByText(tr('en', 'messages', 'actionsMenu.delete')).click();
    await page.getByTestId('delete-confirm-btn').click();
    await expect(page.locator(MSG).filter({ hasText: edited })).toHaveCount(0);
  });

  test('스레드 답글과 채널에도 보내기, 수정·삭제', async ({ page }) => {
    await register(page, 'Smoke Thread', uniqueEmail(), TEST_PASSWORD);
    await clickChannel(page, 'general');
    await waitForChannelReady(page);

    const parent = `thread parent ${Date.now()}`;
    await sendMessage(page, parent);
    await waitForMessage(page, parent);
    await row(page, parent).hover();
    await row(page, parent).locator('button').filter({ has: page.locator('.lucide-message-square') }).click();
    const panel = page.getByTestId('thread-panel');
    await expect(panel).toBeVisible();

    // 안내 문구는 번역 키에서 나온다
    await expect(panel.locator('.ql-editor')).toHaveAttribute('data-placeholder', tr('en', 'messages', 'threadPanel.replyPlaceholder'));

    // 일반 답글
    const plain = `plain reply ${Date.now()}`;
    await panel.locator('.ql-editor').click();
    await page.keyboard.type(plain);
    await page.keyboard.press('Enter');
    await expect(panel.getByText(plain)).toBeVisible();
    await expect(page.locator(MSG).filter({ hasText: plain })).toHaveCount(0);

    // 채널에도 보내기: 앞선 답글의 전송 응답이 와도 체크 상태가 풀리지 않아야 한다
    const also = `also reply ${Date.now()}`;
    await panel.getByTestId('thread-also-send').check();
    await expect(panel.getByTestId('thread-also-send')).toBeChecked();
    await panel.locator('.ql-editor').click();
    await page.keyboard.type(also);
    await page.keyboard.press('Enter');
    await expect(panel.getByText(also)).toBeVisible();
    await expect(page.locator('main').locator(MSG).filter({ hasText: also }).first()).toBeVisible();
  });

  test('DM과 그룹 DM 만들기, 보내기, 이름 바꾸기, 나가기', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxC = await browser.newContext();
    const ts = Date.now();
    const a = await newUser(ctxA, `SmokeA${ts}`);
    const b = await newUser(ctxB, `SmokeB${ts}`);
    const c = await newUser(ctxC, `SmokeC${ts}`);

    // DM A -> B
    await a.page.getByText(tr('en', 'sidebar', 'sections.addTeammates')).click();
    await a.page.getByTestId('teammate-search').fill(b.name);
    await a.page.getByRole('button', { name: new RegExp(b.name) }).first().click();
    await expect(a.page.getByTestId('dm-conversation')).toBeVisible();
    const dm = `dm hello ${ts}`;
    await a.page.getByTestId('dm-message-input').fill(dm);
    await a.page.getByTestId('dm-message-input').press('Enter');
    await expect(a.page.getByTestId('dm-conversation').getByText(dm)).toBeVisible();
    // B가 실시간으로 사이드바에 DM을 본다
    await expect(b.page.locator('[data-testid="dm-list-item"]').filter({ hasText: a.name })).toBeVisible({ timeout: 15_000 });

    // 그룹 DM A -> B, C
    await a.page.getByText(tr('en', 'sidebar', 'sections.addTeammates')).click();
    for (const person of [b, c]) {
      await a.page.getByTestId('teammate-search').fill(person.name);
      // 검색 결과가 걸러진 뒤(해당 사용자 행)에 선택한다
      const pick = a.page.getByRole('checkbox', { name: new RegExp(person.name) });
      await expect(pick).toBeVisible();
      await pick.check();
    }
    await a.page.getByTestId('teammate-confirm').click();
    await expect(a.page.getByTestId('group-header-name')).toBeVisible();
    const gm = `group hello ${ts}`;
    await a.page.getByTestId('dm-message-input').fill(gm);
    await a.page.getByTestId('dm-message-input').press('Enter');
    await expect(a.page.getByText(gm).first()).toBeVisible();
    await expect(c.page.getByTestId('group-dm-list-item').first()).toBeVisible({ timeout: 15_000 });

    // 이름 바꾸기(구성원 패널에서)
    await a.page.getByTestId('group-members-button').click();
    await expect(a.page.getByTestId('group-members-panel')).toBeVisible();
    await a.page.getByTestId('group-rename-button').click();
    const gname = `grp${ts}`;
    await a.page.getByTestId('group-name-input').fill(gname);
    await a.page.getByTestId('group-name-save').click();
    await expect(a.page.getByTestId('group-header-name')).toContainText(gname);

    // 나가기
    await a.page.getByTestId('group-leave').click();
    await a.page.getByTestId('group-leave-confirm').click();
    await expect(a.page.getByTestId('group-dm-list-item').filter({ hasText: gname })).toHaveCount(0);

    await ctxA.close();
    await ctxB.close();
    await ctxC.close();
  });

  test('검색과 리마인더 만들기·보기·완료·삭제', async ({ page }) => {
    await register(page, 'Smoke Search', uniqueEmail(), TEST_PASSWORD);
    await clickChannel(page, 'general');
    await waitForChannelReady(page);

    const word = `zzsearch${Date.now()}`;
    const text = `find me ${word}`;
    await sendMessage(page, text);
    await waitForMessage(page, text);

    // Read: 헤더 검색 미리보기와 전체 검색 페이지
    await page.getByPlaceholder(tr('en', 'messages', 'search.placeholder')).first().fill(word);
    await expect(page.getByTestId('search-result-item').first()).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder(tr('en', 'messages', 'search.placeholder')).first().press('Enter');
    await expect(page.getByTestId('search-page')).toBeVisible();
    await expect(page.getByTestId('search-page-result').first()).toContainText(word);

    // Reminder: create
    await clickChannel(page, 'general');
    await waitForChannelReady(page);
    await openActions(page, text);
    await page.getByTestId('reminder-menu-item').click();
    await page.locator('[data-testid^="reminder-preset-"]').first().click();

    // Read: 나중에 > 리마인더
    await page.getByTestId('nav-item-later').click();
    await page.getByTestId('later-tab-reminders').click();
    await expect(page.getByTestId('reminder-item')).toHaveCount(1);
    // Update: 완료 처리
    await page.getByTestId('reminder-complete').click();
    await page.getByTestId('reminders-status-done').click();
    await expect(page.getByTestId('reminder-item')).toHaveCount(1);
    await page.getByTestId('reminder-reopen').click();
    await page.getByTestId('reminders-status-pending').click();
    // Delete
    await page.getByTestId('reminder-delete').click();
    await expect(page.getByTestId('reminder-item')).toHaveCount(0);
  });

  test('언어 전환(en to ko to en)이 스레드 입력창 안내 문구와 채널 입력창에 바로 반영된다', async ({ page }) => {
    await register(page, 'Smoke Lang', uniqueEmail(), TEST_PASSWORD);
    await clickChannel(page, 'general');
    await waitForChannelReady(page);

    const parent = `lang parent ${Date.now()}`;
    await sendMessage(page, parent);
    await waitForMessage(page, parent);
    await row(page, parent).hover();
    await row(page, parent).locator('button').filter({ has: page.locator('.lucide-message-square') }).click();
    const threadEditor = page.getByTestId('thread-panel').locator('.ql-editor');
    await expect(threadEditor).toHaveAttribute('data-placeholder', tr('en', 'messages', 'threadPanel.replyPlaceholder'));

    // 프로필 창의 언어 선택으로 전환한다. 스레드 패널은 열어 둔 채로 바뀌어야 한다(새로고침 없이).
    for (const [from, to] of [['en', 'ko'], ['ko', 'en']] as const) {
      await openUserMenu(page);
      await page.getByRole('button', { name: tr(from, 'sidebar', 'userMenu.profile'), exact: true }).click();
      await page.getByTestId('language-select').selectOption(to);
      await expect(page.locator('html')).toHaveAttribute('lang', to);
      await page.getByTestId('profile-modal').getByRole('button', { name: tr(to, 'settings', 'profile.close') }).click();
      await expect(page.getByTestId('profile-modal')).toHaveCount(0);
      await expect(threadEditor).toHaveAttribute('data-placeholder', tr(to, 'messages', 'threadPanel.replyPlaceholder'));
      await expect(page.getByTestId('thread-panel').getByText(tr(to, 'messages', 'threadPanel.alsoSendToChannel'))).toBeVisible();
      await expect(page.locator('.ql-editor').first()).toHaveAttribute('data-placeholder', /general/);
    }
  });

  test('비밀번호 변경: 틀린 현재 비밀번호는 오류만 보이고 로그아웃되지 않는다', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'Smoke Pw', email, TEST_PASSWORD);
    const next = `${TEST_PASSWORD}-new1`;

    await openUserMenu(page);
    await page.getByTestId('change-password-menu-item').click();
    await expect(page.getByTestId('change-password-dialog')).toBeVisible();

    // 틀린 비밀번호
    await page.getByTestId('change-password-current').fill('not-the-password-1');
    await page.getByTestId('change-password-new').fill(next);
    await page.getByTestId('change-password-confirm').fill(next);
    await page.getByTestId('change-password-submit').click();
    await expect(page.getByTestId('change-password-error')).toBeVisible();
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);

    // 올바른 비밀번호
    await page.getByTestId('change-password-current').fill(TEST_PASSWORD);
    await page.getByTestId('change-password-submit').click();
    await expect(page.getByTestId('change-password-dialog')).toHaveCount(0);
    await expect(page.getByTestId('sidebar')).toBeVisible();

    // 새 비밀번호로만 로그인된다
    await logout(page);
    await page.getByPlaceholder('name@work-email.com').fill(email);
    await page.getByPlaceholder('Password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: /sign in with email/i }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await login(page, email, next);
  });

  test('2단계 인증: 켜기(QR), 로그아웃, 2단계 로그인, 복구 코드 재발급(저장 확인 전 닫힘 방지), 끄기, 다른 탭 유지', async ({ context }) => {
    test.setTimeout(300_000);
    const { page, email } = await newUser(context, 'Smoke Mfa');
    await clickChannel(page, 'general');
    await waitForChannelReady(page);

    // 같은 컨텍스트(저장소 공유)의 두 번째 탭
    const tab2 = await context.newPage();
    await tab2.goto('/');
    await expect(tab2.getByTestId('sidebar')).toBeVisible();
    await clickChannel(tab2, 'general');
    await waitForChannelReady(tab2);

    const dialog = page.getByTestId('two-factor-dialog');
    const closeBtn = page.getByRole('button', { name: tr('en', 'settings', 'twoFactor.close'), exact: true });
    await openUserMenu(page);
    await page.getByTestId('two-factor-menu-item').click();
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('mfa-status')).toHaveText(tr('en', 'settings', 'twoFactor.statusOff'));

    // 켜기: QR과 설정 키가 보인다
    await page.getByTestId('mfa-setup-start').click();
    await expect(page.getByTestId('mfa-setup-qr').locator('svg')).toBeVisible();
    const box = await page.getByTestId('mfa-setup-qr').boundingBox();
    expect(box!.width).toBeGreaterThan(80);
    const secret = ((await page.getByTestId('mfa-setup-key').textContent()) ?? '').replace(/\s/g, '');
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    await page.getByTestId('mfa-setup-code').fill(await freshCode(secret));
    await page.getByTestId('mfa-setup-password').fill(TEST_PASSWORD);
    await page.getByTestId('mfa-setup-verify').click();
    await expect(page.getByTestId('mfa-recovery-codes')).toBeVisible();
    expect(await page.getByTestId('mfa-recovery-code').count()).toBeGreaterThanOrEqual(8);
    await page.getByTestId('mfa-recovery-done').click();
    await expect(page.getByTestId('mfa-status')).toHaveText(tr('en', 'settings', 'twoFactor.statusOn'));
    await closeBtn.click();
    await expect(dialog).toHaveCount(0);

    // 다른 탭: 켠 뒤에도 로그아웃되지 않고 메시지를 보낼 수 있다
    const t2msg = `tab2 after enable ${Date.now()}`;
    await sendMessage(tab2, t2msg);
    await waitForMessage(tab2, t2msg);
    await expect(tab2).not.toHaveURL(/\/login/);
    await tab2.reload();
    await expect(tab2.getByTestId('sidebar')).toBeVisible();
    await tab2.close();

    // 로그아웃, 2단계 로그인(틀린 코드 한 번 후 올바른 코드)
    await logout(page);
    await page.getByPlaceholder('name@work-email.com').fill(email);
    await page.getByPlaceholder('Password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: /sign in with email/i }).click();
    await expect(page.getByTestId('mfa-login-step')).toBeVisible();
    await page.getByTestId('mfa-login-code').fill('000000');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByTestId('mfa-login-code').fill(await freshCode(secret));
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 20_000 });

    // 2단계 로그인 뒤에 연 세 번째 탭: 아래에서 끄고 켜는 동안에도 유지되어야 한다
    const tab3 = await context.newPage();
    await tab3.goto('/');
    await expect(tab3.getByTestId('sidebar')).toBeVisible();
    await clickChannel(tab3, 'general');
    await waitForChannelReady(tab3);

    // 복구 코드 재발급: 저장 확인 전에는 Escape, 바깥 클릭, 닫기 버튼으로 닫히지 않는다
    await openUserMenu(page);
    await page.getByTestId('two-factor-menu-item').click();
    await page.getByTestId('mfa-regenerate-start').click();
    await page.getByTestId('mfa-regenerate-password').fill(TEST_PASSWORD);
    await page.getByTestId('mfa-regenerate-code').fill(await freshCode(secret));
    await page.getByTestId('mfa-regenerate-submit').click();
    await expect(page.getByTestId('mfa-recovery-codes')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('mfa-recovery-codes')).toBeVisible();
    await expect(closeBtn).toBeDisabled();
    await page.getByTestId('mfa-recovery-done').click();
    await closeBtn.click();
    await expect(dialog).toHaveCount(0);

    // 끄기
    await openUserMenu(page);
    await page.getByTestId('two-factor-menu-item').click();
    await page.getByTestId('mfa-disable-start').click();
    await page.getByTestId('mfa-disable-password').fill(TEST_PASSWORD);
    await page.getByTestId('mfa-disable-code').fill(await freshCode(secret));
    await page.getByTestId('mfa-disable-submit').click();
    await expect(page.getByTestId('mfa-status')).toHaveText(tr('en', 'settings', 'twoFactor.statusOff'));
    await closeBtn.click();

    // 다른 탭(새로고침 없이): 끈 뒤에도 로그아웃되지 않고 메시지를 보낼 수 있다
    const t3msg = `tab3 after disable ${Date.now()}`;
    await sendMessage(tab3, t3msg);
    await waitForMessage(tab3, t3msg);
    await expect(tab3).not.toHaveURL(/\/login/);

    // 끈 뒤에도 로그인이 유지되고, 다시 로그인하면 2단계 없이 들어간다
    await page.reload();
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await logout(page);
    await login(page, email, TEST_PASSWORD);
  });

  test('관리자 화면 탭이 열리고 DLP 규칙 CRUD와 차단 문구(ko)가 입력창에 번역돼 보인다', async ({ page }) => {
    await login(page, 'alice@slawk.dev', TEST_PASSWORD);
    // 로그인 직후 사이드바의 관리자 아이콘을 누른다(마지막 채널로 이동하는 동작이 관리자 화면을 덮으면 실패)
    await page.getByTestId('nav-item-admin').click();
    await expect(page).toHaveURL(/\/admin$/);
    const main = page.locator('main');
    await expect(main.getByText(tr('en', 'admin', 'page.title'))).toBeVisible();
    // 새로고침 경로도 확인한다: 검색 화면을 쿼리스트링과 함께 새로고침한 뒤 관리자 주소를 직접 연다
    await page.goto('/search?q=smoke');
    await expect(page.getByTestId('search-page')).toBeVisible();
    await page.goto('/admin');
    await expect(main.getByText(tr('en', 'admin', 'page.title'))).toBeVisible();

    // 탭 열림: 보존, 보안, 법적 보존, DLP
    await main.getByRole('button', { name: tr('en', 'admin', 'page.tabs.retention') }).click();
    await expect(main.getByText(tr('en', 'admin', 'retention.description'))).toBeVisible();
    await main.getByRole('button', { name: tr('en', 'admin', 'page.tabs.security') }).click();
    await expect(main.getByTestId('require-mfa-toggle')).toBeVisible();
    await main.getByRole('button', { name: tr('en', 'admin', 'page.tabs.legalHolds') }).click();
    await expect(main.getByText(tr('en', 'admin', 'legalHolds.description'))).toBeVisible();
    await main.getByRole('button', { name: tr('en', 'admin', 'page.tabs.dlp') }).click();
    await expect(main.getByText(tr('en', 'admin', 'dlp.description'))).toBeVisible();

    // DLP 규칙 Create
    // 이전 실행이 남긴 규칙과 겹치지 않게 실행마다 고유한 패턴을 쓴다
    const tag = Date.now().toString(36).toUpperCase();
    const ruleName = `smoke-${tag}`;
    await main.getByLabel(tr('en', 'admin', 'dlp.form.name')).fill(ruleName);
    await main.getByLabel(tr('en', 'admin', 'dlp.form.pattern')).fill(`E2E${tag}-\\d{6}`);
    await main.getByRole('button', { name: tr('en', 'admin', 'dlp.form.add') }).click();
    const ruleRow = main.locator('tr').filter({ hasText: ruleName });
    await expect(ruleRow).toBeVisible();
    // Update: 경고로 바꿨다가 다시 차단으로
    await ruleRow.getByRole('combobox').selectOption('WARN');
    await expect(ruleRow.getByRole('combobox')).toHaveValue('WARN');
    await ruleRow.getByRole('combobox').selectOption('BLOCK');
    await expect(ruleRow.getByRole('combobox')).toHaveValue('BLOCK');

    // 한국어로 바꾸고 입력창에서 차단 문구를 본다(카드 번호 내장 규칙, 직접 만든 규칙)
    await page.evaluate(() => localStorage.setItem('locale', 'ko'));
    await page.goto('/');
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await clickChannel(page, 'general');
    await waitForChannelReady(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');

    const koBlocked = tr('ko', 'errors', 'api.DLP_BLOCKED');
    const expectBanner = async (rule: string) => {
      await expect(page.getByText(koBlocked.replace('{rule}', rule))).toBeVisible();
    };
    await sendMessage(page, 'card 4242 4242 4242 4242');
    await expectBanner(tr('ko', 'admin', 'dlp.builtin.credit_card'));

    await page.locator('.ql-editor').fill('');
    await sendMessage(page, `code E2E${tag}-123456`);
    await expectBanner(ruleName);

    // Delete: 영어로 돌아가 규칙을 지운다
    await page.evaluate(() => localStorage.setItem('locale', 'en'));
    await page.goto('/');
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await page.getByTestId('nav-item-admin').click();
    await main.getByRole('button', { name: tr('en', 'admin', 'page.tabs.dlp') }).click();
    await main.getByRole('button', { name: new RegExp(ruleName) }).last().click();
    await page.getByRole('button', { name: tr('en', 'admin', 'dlp.delete'), exact: true }).click();
    await expect(main.locator('tr').filter({ hasText: ruleName })).toHaveCount(0);
  });

  test('2단계 인증 처음 켤 때 복구 코드가 보이는 동안에도 Escape로 창이 닫히지 않는다', async ({ page }) => {
    test.setTimeout(120_000);
    await register(page, 'Smoke Mfa First', uniqueEmail(), TEST_PASSWORD);
    const dialog = page.getByTestId('two-factor-dialog');
    await openUserMenu(page);
    await page.getByTestId('two-factor-menu-item').click();
    await page.getByTestId('mfa-setup-start').click();
    const secret = ((await page.getByTestId('mfa-setup-key').textContent()) ?? '').replace(/\s/g, '');
    await page.getByTestId('mfa-setup-code').fill(await freshCode(secret));
    await page.getByTestId('mfa-setup-password').fill(TEST_PASSWORD);
    await page.getByTestId('mfa-setup-verify').click();
    await expect(page.getByTestId('mfa-recovery-codes')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('mfa-recovery-codes')).toBeVisible();
    // 저장했다고 확인하면 닫을 수 있다
    await page.getByTestId('mfa-recovery-done').click();
    await page.getByRole('button', { name: tr('en', 'settings', 'twoFactor.close'), exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
});
