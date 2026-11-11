/* eslint-disable */
/**
 * Phase G/H — three-viewport acceptance for the Examiner surface.
 *
 * Not a visual diff: every viewport asserts the layout does not overflow
 * horizontally and that the Owner-critical blocks are still present and
 * readable. Screenshots land in `.tmp/e2e-screens/responsive/` for review
 * (session artifacts, never committed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

const SCREENSHOT_DIR = path.resolve(process.cwd(), '../../.tmp/e2e-screens/responsive');

const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'tablet-1024', width: 1024, height: 768 },
  { name: 'mobile-390', width: 390, height: 844 },
] as const;

const PAGES = [
  { name: 'examiner-home', path: '/#/examiner', ready: 'examiner-page-title' },
  { name: 'examiner-configure', path: '/#/examiner/configure?principle=p-002', ready: 'examiner-configure-title' },
  { name: 'examiner-study', path: '/#/examiner/studies/EXM-V09-ACC-ISO', ready: 'examiner-study-detail' },
] as const;

test.describe.configure({ mode: 'serial' });

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}: Examiner pages stay readable without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    for (const target of PAGES) {
      await page.goto(target.path);
      await expect(page.getByTestId(target.ready)).toBeVisible({ timeout: 20_000 });

      if (target.name === 'examiner-home') {
        // The guide and the principle list are the first-screen content.
        await expect(page.getByTestId('examiner-guide')).toBeVisible();
        await expect(page.getByTestId('examiner-principle-p-002')).toBeVisible({ timeout: 20_000 });
      }
      if (target.name === 'examiner-configure') {
        await expect(page.getByTestId('examiner-eligibility-panel')).toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId('examiner-create-button')).toBeVisible();
      }
      if (target.name === 'examiner-study') {
        await expect(page.getByTestId('examiner-study-readonly')).toBeVisible({ timeout: 20_000 });
      }

      // `main` owns the page scroll (overflow-x:auto), so a documentElement
      // check alone would hide real clipping. Measure the actual scroller too.
      const overflow = await page.evaluate(() => {
        const main = document.querySelector('main');
        const mainOverflow = main ? main.scrollWidth - main.clientWidth : 0;
        const docOverflow = document.documentElement.scrollWidth - window.innerWidth;
        return Math.max(mainOverflow, docOverflow);
      });
      expect(overflow, `${target.name} overflows horizontally by ${overflow}px at ${viewport.name}`).toBeLessThanOrEqual(1);

      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `${target.name}-${viewport.name}.png`),
        fullPage: true,
      });
    }
  });
}
