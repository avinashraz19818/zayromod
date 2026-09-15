import { test, expect } from '@playwright/test';
import fs from 'node:fs';
const token = process.env.ADMIN_TOKEN || (fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8').match(/^ADMIN_TOKEN=(.+)$/m)?.[1] : '');
for (const width of [1440, 768, 390]) {
  test(`studio interactions and responsive layout at ${width}px`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(m.text()); });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await expect(page).toHaveTitle('MizanMods — Build studio');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#appName').fill('MizanMods Sample');
    const iframe = page.frameLocator('#app-preview');
    {
      await expect(iframe.locator('h1')).toHaveText('MizanMods Sample');
      await iframe.locator('#open').click();
      await expect(iframe.locator('dialog')).toBeVisible();
      await iframe.locator('dialog button').click();
      await expect(iframe.locator('dialog')).not.toBeVisible();
    }
    await page.locator('#submit').click();
    await expect(page.locator('#auth')).toBeVisible();
    await page.locator('#token').fill(token);
    await page.locator('#auth-form .primary').click();
    await expect(page.locator('#auth')).not.toBeVisible();
    await expect(page.locator('#total')).not.toHaveText('—');
    await page.locator('nav [data-view=settings]').click();
    await expect(page.locator('.check')).toHaveCount(7);
    await page.locator('#refresh-settings').click();
    await page.locator('nav [data-view=history]').click();
    await expect(page.locator('#history')).toBeVisible();
    await page.locator('nav [data-view=studio]').click();
    await page.locator('#submit').click();
    await expect(page.locator('#build-detail')).toBeVisible();
    await expect(page.locator('#detail-content .badge')).toHaveText('failed', { timeout: 15000 });
    await expect(page.locator('#detail-content pre').first()).toContainText('Setup required');
    await page.locator('[data-retry]').click();
    await expect(page.locator('#appName')).toHaveValue('MizanMods Sample');
    await expect(page.locator('#build-detail')).not.toBeVisible();
    await page.screenshot({ path: `runtime/studio-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}
