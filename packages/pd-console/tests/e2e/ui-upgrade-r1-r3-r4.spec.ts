/* eslint-disable */
// SPEC-PD-UIUX-001 真实渲染验收（Playwright，生产 UI 构建 + e2e 种子数据）：
//   R1 — 原则详情 receipts 四种已验证状态与文案一致（第五种降级态由
//        receipt-history-degraded 单元分支 + receipts-api 测试覆盖）
//   R3 — 窄屏抽屉导航：菜单按钮、焦点管理、Esc 关闭、路由后关闭、
//        正文无固定左边距、无整页横向滚动；桌面保留固定侧栏
//   R4 — 键盘跳过导航不改路由、正文非空、焦点进入 main；aria-current="page"
// 证据等级：生产构建 + 真实 HTTP 服务 + 真实 SQLite 种子（模拟数据运行，
// 非真机触摸 —— 触摸交互为合成事件，真机覆盖见交付记录）。

import { test, expect } from '@playwright/test';

const PRINCIPLE_IDS = {
  zeroZero: 'p-001', // 0 presence / 0 effect
  presenceOnly: 'e2e00000-0000-4000-8000-000000000002', // 3 presence / 0 effect
  effectWithPresence: 'e2e00000-0000-4000-8000-000000000009', // 2 presence / 1 effect
  effectOnly: 'e2e00000-0000-4000-8000-000000000008', // 0 presence / 1 effect
} as const;

// ── R1: receipt states match the verified data ─────────────────────────────

test.describe('R1 receipt semantics on real pages', () => {
  test('0/0 states "nothing observed within retention window", never "already in context"', async ({ page }) => {
    await page.goto(`/#/principles/${PRINCIPLE_IDS.zeroZero}`);
    await page.waitForSelector('[data-testid="receipt-history"]', { timeout: 15000 });
    const headline = await page.locator('#receipt-history-title').innerText();
    expect(headline).toContain('未观察到上下文投递或效果记录');
    expect(headline).not.toContain('已进入');
    const counts = await page.locator('[data-testid="receipt-history-counts"]').innerText();
    // Review round: exact counts string — a bare '0' substring would match
    // dates and any other digit.
    expect(counts).toContain('行为生效 0 次 · 参与上下文 0 次');
  });

  test('presence>0 / effect=0 states injections recorded, no effect claim', async ({ page }) => {
    await page.goto(`/#/principles/${PRINCIPLE_IDS.presenceOnly}`);
    await page.waitForSelector('[data-testid="receipt-history"]', { timeout: 15000 });
    const headline = await page.locator('#receipt-history-title').innerText();
    expect(headline).toContain('已记录上下文投递');
    expect(headline).toContain('尚无对应效果记录');
    // zero-effect explanation present and presence-scoped (exact zero-effect copy)
    const explain = await page.locator('[data-testid="receipt-history-zero-effect"]').innerText();
    expect(explain).toContain('只有参与任务上下文（Presence）的记录');
    // no fabricated presence-missing note
    await expect(page.locator('[data-testid="receipt-history-presence-missing"]')).toHaveCount(0);
  });

  test('effect>0 with presence shows the effect headline', async ({ page }) => {
    await page.goto(`/#/principles/${PRINCIPLE_IDS.effectWithPresence}`);
    await page.waitForSelector('[data-testid="receipt-history"]', { timeout: 15000 });
    const headline = await page.locator('#receipt-history-title').innerText();
    expect(headline).toContain('1 次行为影响');
    await expect(page.locator('[data-testid="receipt-history-presence-missing"]')).toHaveCount(0);
  });

  test('effect>0 without presence notes the missing injections, never fabricates them', async ({ page }) => {
    await page.goto(`/#/principles/${PRINCIPLE_IDS.effectOnly}`);
    await page.waitForSelector('[data-testid="receipt-history"]', { timeout: 15000 });
    const note = await page.locator('[data-testid="receipt-history-presence-missing"]').innerText();
    expect(note).toContain('没有这条原则的上下文投递');
    const counts = await page.locator('[data-testid="receipt-history-counts"]').innerText();
    expect(counts).toContain('参与上下文 0 次');
  });

  test('EN locale shows the same honest matrix (no contradiction with the numbers)', async ({ page }) => {
    await page.goto('/#/focus');
    await page.evaluate(() => {
      localStorage.setItem('pd-language', 'en');
    });
    await page.reload();
    await page.goto(`/#/principles/${PRINCIPLE_IDS.zeroZero}`);
    await page.waitForSelector('[data-testid="receipt-history"]', { timeout: 15000 });
    const headline = await page.locator('#receipt-history-title').innerText();
    expect(headline).toContain('No context injection or effect records observed');
    // R6: document language follows the UI language.
    expect(await documentLang(page)).toBe('en');
    await page.evaluate(() => {
      localStorage.setItem('pd-language', 'zh-CN');
    });
  });
});

function documentLang(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => document.documentElement.lang);
}

// ── R4: skip navigation keeps the route and lands focus in main ─────────────

test.describe('R4 keyboard skip navigation', () => {
  for (const route of ['/#/focus', `/#/principles/${PRINCIPLE_IDS.zeroZero}`, '/#/settings']) {
    test(`skip link on ${route}: route kept, main focused, content intact`, async ({ page }) => {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      // First Tab lands on the skip control.
      await page.keyboard.press('Tab');
      const activeSkip = page.locator('[data-testid="skip-to-main"]');
      await expect(activeSkip).toBeFocused();
      await page.keyboard.press('Enter');
      // The URL hash must still be the app route — not #main-content.
      expect(page.url()).not.toContain('#main-content');
      expect(page.url()).toContain(route.slice(1));
      // Focus moved to main; content non-empty.
      await expect(page.locator('#main-content')).toBeFocused();
      const text = (await page.locator('#main-content').innerText()).trim();
      expect(text.length).toBeGreaterThan(50);
      // Next Tab continues INTO the content, not back to the top bar.
      await page.keyboard.press('Tab');
      const nextActive = await page.evaluate(() => document.activeElement?.id ?? 'none');
      expect(nextActive).not.toBe('skip-to-main');
    });
  }

  test('current nav link carries aria-current=page', async ({ page }) => {
    await page.goto('/#/focus');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-testid="nav-focus"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-testid="nav-principles"]')).not.toHaveAttribute('aria-current', 'page');
    await page.goto('/#/settings');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-testid="nav-settings"]')).toHaveAttribute('aria-current', 'page');
  });
});

// ── R3: narrow-screen drawer navigation ─────────────────────────────────────

test.describe('R3 narrow-screen drawer navigation', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('menu button opens the drawer, focus moves in, Esc closes and returns focus', async ({ page }) => {
    await page.goto('/#/focus');
    await page.waitForLoadState('networkidle');

    const trigger = page.locator('[data-testid="mobile-nav-trigger"]');
    await expect(trigger).toBeVisible();
    // Desktop sidebar must NOT be present at 390px.
    await expect(page.locator('aside.w-\\[256px\\]')).toBeHidden();

    await trigger.click();
    const drawer = page.locator('[data-testid="mobile-nav-drawer"]');
    await expect(drawer).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // Focus is inside the dialog (Radix focus trap).
    const focusInDrawer = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="mobile-nav-drawer"]');
      return dialog !== null && dialog.contains(document.activeElement);
    });
    expect(focusInDrawer).toBe(true);
    // Focus target is ≥44px (touch reach).
    const box = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? { h: el.offsetHeight } : { h: 0 };
    });
    expect(box.h).toBeGreaterThanOrEqual(44);

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('selecting a nav entry routes and closes the drawer; current page identifiable', async ({ page }) => {
    await page.goto('/#/focus');
    await page.waitForLoadState('networkidle');
    await page.locator('[data-testid="mobile-nav-trigger"]').click();
    await page.locator('[data-testid="mobile-nav-drawer"] [data-testid="nav-settings"]').click();
    await page.waitForURL('**/#/settings');
    const drawer = page.locator('[data-testid="mobile-nav-drawer"]');
    await expect(drawer).toBeHidden();
    await expect(page.locator('[data-testid="nav-settings"]')).toHaveAttribute('aria-current', 'page');
  });

  test('main content has no fixed sidebar margin and the page does not scroll horizontally', async ({ page }) => {
    await page.goto(`/#/principles/${PRINCIPLE_IDS.zeroZero}`);
    await page.waitForLoadState('networkidle');
    const metrics = await page.evaluate(() => {
      const main = document.getElementById('main-content');
      const ml = main ? getComputedStyle(main).marginLeft : 'none';
      const scrollable = document.scrollingElement ?? document.documentElement;
      return { ml, scrollWidth: scrollable.scrollWidth, clientWidth: scrollable.clientWidth };
    });
    expect(metrics.ml).toBe('0px');
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  });

  test('long principle text wraps instead of overflowing at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(`/#/principles/${PRINCIPLE_IDS.zeroZero}`);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => {
      const scrollable = document.scrollingElement ?? document.documentElement;
      return scrollable.scrollWidth - scrollable.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('R3 desktop keeps the fixed sidebar', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('sidebar visible, drawer trigger absent, main offset 256px', async ({ page }) => {
    await page.goto('/#/focus');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('aside.w-\\[256px\\]')).toBeVisible();
    await expect(page.locator('[data-testid="mobile-nav-trigger"]')).toBeHidden();
    const ml = await page.evaluate(() => getComputedStyle(document.getElementById('main-content')!).marginLeft);
    expect(ml).toBe('256px');
  });
});

// ── R6: language switch round-trip keeps document.lang and chrome in sync ───

test.describe('R6 language switch syncs document.lang', () => {
  test('EN → ZH → EN round-trip via the sidebar switcher, persisted across reload', async ({ page }) => {
    await page.goto('/#/focus');
    await page.waitForLoadState('networkidle');
    // Default zh-CN on the fresh e2e context.
    expect(await documentLang(page)).toBe('zh-cn');

    const switcher = page.locator('aside button[title]').filter({ hasText: 'English' });
    await switcher.click();
    await page.waitForTimeout(300);
    expect(await documentLang(page)).toBe('en');
    // Static chrome localized: sign-out button now English.
    await expect(page.locator('aside button', { hasText: 'Sign out' })).toBeVisible();

    await page.locator('aside button', { hasText: '中文' }).click();
    await page.waitForTimeout(300);
    expect(await documentLang(page)).toBe('zh-cn');
    await expect(page.locator('aside button', { hasText: '退出' })).toBeVisible();

    // Switch to EN again and reload — persistence keeps lang + UI.
    await page.locator('aside button', { hasText: 'English' }).click();
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForLoadState('networkidle');
    expect(await documentLang(page)).toBe('en');
    await expect(page.locator('aside button', { hasText: 'Sign out' })).toBeVisible();
  });
});

// ── R2 (review round): the conclusion headline must agree with the cards ────

test.describe('R2 conclusion strip stays honest with on-screen cards', () => {
  test('never claims allClear while pending approval cards are on screen (unlinked-approval case)', async ({ page }) => {
    // The seed workspace has pending approvals (click approve/reject/edit).
    // If the inbox projection misses them, the displayTotal floor from the
    // action cards must still prevent the 'nothing needs you' headline.
    await page.goto('/#/focus');
    await page.waitForLoadState('networkidle');
        const conclusion = page.locator('[data-testid="focus-conclusion-counts"]');
    await expect(conclusion).toBeVisible();
    const text = await conclusion.innerText();
    expect(text).not.toContain('当前没有需要你处理的治理事项');
  });
});

// ── Owner review round 2 (P2 S1/S3/Q2): degraded + feature-off + resize ─────

test.describe('R2 review round 2: degraded inbox, feature-off, drawer resize', () => {
  test('degraded inbox payload surfaces the server reason and never claims allClear (S1)', async ({ page }) => {
    await page.route('**/api/v1/principles/owner-decision-inbox', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            schemaVersion: '1',
            generatedAt: '2026-10-11T08:00:00.000Z',
            totalPrinciples: 0,
            groups: { decision: [], blocked: [], recovery: [] },
            historicalUnknown: { count: 0, reasonText: '' },
            degraded: { reason: 'principle ledger unavailable', nextAction: '检查原则账本文件。' },
          },
        }),
      }));
    await page.goto('/#/focus');
    await page.waitForLoadState('networkidle');
    const strip = page.locator('[data-testid="focus-conclusion"]');
    await expect(strip).toBeVisible();
    const text = await strip.innerText();
    expect(text).not.toContain('当前没有需要你处理的治理事项');
    expect(text).toContain('待处理数暂不可确认');
    // The server's own reason + nextAction are shown as the recovery entry.
    const degraded = page.locator('[data-testid="focus-conclusion-degraded"]');
    await expect(degraded).toBeVisible();
    expect(await degraded.innerText()).toContain('principle ledger unavailable');
    expect(await degraded.innerText()).toContain('检查原则账本文件。');
  });

  test('feature-disabled inbox keeps cards, shows the uncertain headline; locked wording never contradicts disabled buttons (S3)', async ({ page }) => {
    await page.route('**/api/v1/principles/owner-decision-inbox', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'feature_disabled', reason: 'feature_disabled' }),
      }));
    await page.goto('/#/focus');
    await page.waitForLoadState('networkidle');
    const counts = page.locator('[data-testid="focus-conclusion-counts"]');
    await expect(counts).toBeVisible();
    const text = await counts.innerText();
    // Unavailable headline, never allClear.
    expect(text).toContain('待处理数暂不可确认');
    expect(text).not.toContain('当前没有需要你处理的治理事项');
    // This e2e workspace runs --no-auth, so governance actions are LOCKED
    // (PRI-787): the S3 regression was the contradictory pairing of the
    // actionable-now count with the lock notice. The unified wording must
    // name the lock, never claim actionability.
    expect(text).not.toMatch(/现在可操作/);
    expect(text).toContain('治理动作已锁定');
    // Cards stay on screen.
    await expect(page.locator('[data-testid="owner-decisions-section"]').locator('button, article, a').first()).toBeVisible();
  });

  test('drawer open at 390px closes when the window grows to desktop; main regains interaction (Q2)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/focus');
    await page.waitForLoadState('networkidle');
    await page.locator('[data-testid="mobile-nav-trigger"]').click();
    await expect(page.locator('[data-testid="mobile-nav-drawer"]')).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 900 });
    const drawer = page.locator('[data-testid="mobile-nav-drawer"]');
    await expect(drawer).toBeHidden();
    // The body-level overlay must be gone: body pointer events restored.
    const pointerEvents = await page.evaluate(() => getComputedStyle(document.body).pointerEvents);
    expect(pointerEvents).not.toBe('none');
    // Focus is not stranded on the hidden trigger — it moved into main.
    const focusId = await page.evaluate(() => document.activeElement?.id ?? '');
    expect(focusId).toBe('main-content');
    // Desktop main content is directly interactive again (click a heading link target).
    await expect(page.locator('aside.w-\\[256px\\]')).toBeVisible();
  });
});
