import { test, expect } from '@playwright/test';
import { register, uniqueEmail, clickChannel, waitForChannelReady , TEST_PASSWORD } from './helpers';

test.describe('Code block background color', () => {
  test('code block in editor has light background, not black', async ({ page }) => {
    const email = uniqueEmail();
    await register(page, 'CodeBGUser', email, TEST_PASSWORD);
    await clickChannel(page, 'general');
    await waitForChannelReady(page);

    const editor = page.locator('.ql-editor');
    await editor.click();

    // Click the code-block toolbar button
    const toolbar = page.getByTestId('formatting-toolbar');
    const codeBlockBtn = toolbar.locator('button[title="Code Block"]');
    await codeBlockBtn.click();

    // Type some code
    await page.keyboard.type('const x = 1;', { delay: 10 });

    // Check the background color of the code block element inside the editor
    // Quill wraps code block content in a div with ql-code-block class inside ql-code-block-container
    const bgColor = await editor.evaluate((el) => {
      // Find any element with code-block-related class
      const codeEl = el.querySelector('.ql-code-block-container') || el.querySelector('.ql-code-block') || el.querySelector('[data-language]');
      if (!codeEl) return 'not-found';
      return window.getComputedStyle(codeEl).backgroundColor;
    });

    expect(bgColor).not.toBe('not-found');

    // Convert to check it's light
    const match = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    expect(match).toBeTruthy();
    if (match) {
      const [, r, g, b] = match.map(Number);
      // Light gray: RGB > 200; Quill dark default #23241f = rgb(35,36,31)
      expect(r).toBeGreaterThan(200);
      expect(g).toBeGreaterThan(200);
      expect(b).toBeGreaterThan(200);
    }
  });
});
