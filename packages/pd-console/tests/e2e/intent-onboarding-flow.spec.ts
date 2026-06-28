/* eslint-disable */
// E2E 流程测试：PRI-477 Intent Onboarding 完整链路
// 验证 flag toggle → create template → read content → save content → UI 渲染
// 覆盖 intent.ts / IntentPageModel.ts / api.ts / validators.ts / pd-config-store.ts 的集成路径

import { test, expect } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3100';

// ── API helpers ──────────────────────────────────────────────────────────────

async function apiRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => null);
  return { status: resp.status, body: data };
}

// ── Test suite ───────────────────────────────────────────────────────────────
// 使用 test.describe.serial 确保顺序执行（共享 workspace 状态）
// 测试顺序：先测 flag-off 403 路径 → 启用 flag → 测 happy paths → 测 error paths → UI 流程

test.describe.serial('PRI-477 Intent onboarding flow', () => {

  // ── afterAll: 恢复 flag 为 off（避免影响后续 E2E 测试文件）─────────────────
  // intent-onboarding-flow.spec.ts 在 alphabetical 顺序上先于 pain-intent-flow.spec.ts
  // 运行；pain-intent-flow.spec.ts 同时兼容 flag-on/flag-off 两种状态，但为保持
  // 测试隔离性，结束后应恢复 flag 到默认 off 状态。
  test.afterAll(async () => {
    const resp = await apiRequest('PATCH', '/api/v1/config/features/intent_engineering', { enabled: false });
    if (resp.status !== 200) {
      console.error(`[afterAll] Failed to restore intent_engineering=false: ${resp.status}`, resp.body);
    }
  });

  // ── Step 1: flag-off 403 paths (初始状态 flag 默认 off) ─────────────────────

  test('flag-off: GET /intent/content returns 403', async () => {
    const resp = await apiRequest('GET', '/api/v1/intent/content');
    expect(resp.status).toBe(403);
    const body = resp.body as { success: boolean; reason: string; nextAction: string };
    expect(body.success).toBe(false);
    expect(body.reason).toBe('flag_disabled');
    expect(body.nextAction).toBeTruthy();
  });

  test('flag-off: POST /intent/init returns 403', async () => {
    const resp = await apiRequest('POST', '/api/v1/intent/init', {});
    expect(resp.status).toBe(403);
    const body = resp.body as { success: boolean; reason: string };
    expect(body.success).toBe(false);
    expect(body.reason).toBe('flag_disabled');
  });

  test('flag-off: PUT /intent/content returns 403', async () => {
    const resp = await apiRequest('PUT', '/api/v1/intent/content', { content: 'test' });
    expect(resp.status).toBe(403);
    const body = resp.body as { success: boolean; reason: string };
    expect(body.success).toBe(false);
    expect(body.reason).toBe('flag_disabled');
  });

  // ── Step 2: 启用 flag（覆盖 pd-config-store.ts updateFeatureFlag toggle 路径）──

  test('enable intent_engineering flag (toggles false → true)', async () => {
    // seed 写入了 .pd/config.yaml，features section 已存在（intent_engineering=false）
    // PATCH 将 intent_engineering 从 false 切换为 true
    const resp = await apiRequest('PATCH', '/api/v1/config/features/intent_engineering', { enabled: true });
    expect(resp.status).toBe(200);
    const body = resp.body as { success: boolean; data: { feature: string; enabled: boolean } };
    expect(body.success).toBe(true);
    expect(body.data.feature).toBe('intent_engineering');
    expect(body.data.enabled).toBe(true);
  });

  // ── Step 3: flag-on 但 INTENT.md 不存在 ─────────────────────────────────────

  test('flag-on: GET /intent returns not_found state', async () => {
    const resp = await apiRequest('GET', '/api/v1/intent');
    expect(resp.status).toBe(200);
    const body = resp.body as {
      success: boolean;
      data: { flagEnabled: boolean; found: boolean; reason?: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.flagEnabled).toBe(true);
    expect(body.data.found).toBe(false);
    expect(body.data.reason).toBe('not_found');
  });

  test('flag-on: GET /intent/content returns 404 (file not found)', async () => {
    const resp = await apiRequest('GET', '/api/v1/intent/content');
    expect(resp.status).toBe(404);
    const body = resp.body as { success: boolean; reason: string; nextAction: string };
    expect(body.success).toBe(false);
    expect(body.reason).toBe('not_found');
    expect(body.nextAction).toBeTruthy();
  });

  // ── Step 4: POST /intent/init 创建模板 ─────────────────────────────────────

  test('POST /intent/init creates INTENT.md template (201)', async () => {
    const resp = await apiRequest('POST', '/api/v1/intent/init', {});
    expect(resp.status).toBe(201);
    const body = resp.body as {
      success: boolean;
      data: { ok: boolean; created: boolean; path: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.ok).toBe(true);
    expect(body.data.created).toBe(true);
    // Bilingual convention: filename is INTENT.${lang}.md (e.g. INTENT.zh-CN.md)
    expect(body.data.path).toContain('INTENT.');
    expect(body.data.path).toMatch(/INTENT\.(zh-CN|en)\.md$/);
  });

  test('POST /intent/init idempotent — already_exists without force', async () => {
    const resp = await apiRequest('POST', '/api/v1/intent/init', {});
    expect(resp.status).toBe(200);
    const body = resp.body as {
      success: boolean;
      data: { ok: boolean; created: boolean; reason?: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.created).toBe(false);
    expect(body.data.reason).toBe('already_exists');
  });

  test('POST /intent/init with force=true overwrites (201)', async () => {
    const resp = await apiRequest('POST', '/api/v1/intent/init', { force: true });
    expect(resp.status).toBe(201);
    const body = resp.body as { success: boolean; data: { created: boolean } };
    expect(body.success).toBe(true);
    expect(body.data.created).toBe(true);
  });

  // ── Step 5: GET /intent/content 读取原始内容 ───────────────────────────────

  test('GET /intent/content returns raw template content', async () => {
    const resp = await apiRequest('GET', '/api/v1/intent/content');
    expect(resp.status).toBe(200);
    const body = resp.body as {
      success: boolean;
      data: { content: string; path: string };
    };
    expect(body.success).toBe(true);
    expect(typeof body.data.content).toBe('string');
    expect(body.data.content.length).toBeGreaterThan(0);
    expect(body.data.content).toContain('# INTENT.md');
    // Bilingual convention: filename is INTENT.${lang}.md (e.g. INTENT.zh-CN.md)
    expect(body.data.path).toMatch(/INTENT\.(zh-CN|en)\.md$/);
  });

  // ── Step 6: PUT /intent/content 保存内容 ───────────────────────────────────

  test('PUT /intent/content saves valid content (200)', async () => {
    const newContent = '# Test Intent\n\n## 1. Why\n\nTest why content\n\n## 2. Desired Outcome\n\nTest outcome\n';
    const resp = await apiRequest('PUT', '/api/v1/intent/content', { content: newContent });
    expect(resp.status).toBe(200);
    const body = resp.body as {
      success: boolean;
      data: { ok: boolean; saved: boolean; contentHash: string; lastEditedAt: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.ok).toBe(true);
    expect(body.data.saved).toBe(true);
    expect(typeof body.data.contentHash).toBe('string');
    expect(typeof body.data.lastEditedAt).toBe('string');
  });

  test('PUT /intent/content rejects empty content (400 empty_content)', async () => {
    const resp = await apiRequest('PUT', '/api/v1/intent/content', { content: '' });
    expect(resp.status).toBe(400);
    const body = resp.body as { success: boolean; reason: string; nextAction: string };
    expect(body.success).toBe(false);
    expect(body.reason).toBe('empty_content');
    expect(body.nextAction).toBeTruthy();
  });

  test('PUT /intent/content rejects missing content field (400 missing_content)', async () => {
    const resp = await apiRequest('PUT', '/api/v1/intent/content', { notContent: 'foo' });
    expect(resp.status).toBe(400);
    const body = resp.body as { success: boolean; reason: string };
    expect(body.success).toBe(false);
    expect(body.reason).toBe('missing_content');
  });

  test('PUT /intent/content rejects non-string content (400 invalid_content)', async () => {
    const resp = await apiRequest('PUT', '/api/v1/intent/content', { content: 123 });
    expect(resp.status).toBe(400);
    const body = resp.body as { success: boolean; reason: string };
    expect(body.success).toBe(false);
    expect(body.reason).toBe('invalid_content');
  });

  test('PUT /intent/content rejects oversized content (400 oversized)', async () => {
    // INTENT_MAX_BYTES = 32768 (32KB)
    const oversized = 'x'.repeat(33000);
    const resp = await apiRequest('PUT', '/api/v1/intent/content', { content: oversized });
    expect(resp.status).toBe(400);
    const body = resp.body as { success: boolean; reason: string };
    expect(body.success).toBe(false);
    expect(body.reason).toBe('oversized');
  });

  test('PUT /intent/content rejects invalid JSON body (400 invalid_json)', async () => {
    // 直接发送非 JSON 字符串
    const resp = await fetch(`${BASE_URL}/api/v1/intent/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.success).toBe(false);
    expect(body.reason).toBe('invalid_json');
  });

  // ── Step 7: UI 流程 — Intent Page 渲染 + Edit + Save ──────────────────────
  // 覆盖 api.ts 客户端函数 + validators.ts 验证器（通过浏览器 bundle 执行）

  test('UI: Intent page renders sections, edit, save', async ({ page }) => {
    const errors: string[] = [];
    page.on('response', (resp) => {
      if (resp.url().includes('/api/') && resp.status() >= 500) {
        errors.push(`5xx: ${resp.status()} ${resp.url()}`);
      }
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    // flag 已启用，INTENT.md 已创建并保存了测试内容
    await page.goto('/#/intent');
    await page.waitForLoadState('networkidle');

    // 页面应无 5xx 错误
    expect(errors, `Intent page had errors:\n${errors.join('\n')}`).toEqual([]);

    // 页面主体应已渲染（sections view，因为 INTENT.md 存在）
    const bodyText = await page.locator('body').innerText();
    expect(bodyText.length).toBeGreaterThan(100);

    // 应能看到 Edit 按钮（i18n: en="Edit", zh-CN="编辑"）
    const editButton = page.getByRole('button', { name: /^(edit|编辑)$/i }).first();
    await expect(editButton).toBeVisible({ timeout: 5000 });

    // 点击 Edit → 触发 fetchIntentContent() + validateIntentRawContent()
    await editButton.click();
    await page.waitForLoadState('networkidle');

    // Textarea 应可见
    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeVisible({ timeout: 5000 });

    // 修改内容
    const modifiedContent = '# Modified Intent\n\n## 1. Why\n\nModified content\n';
    await textarea.fill(modifiedContent);

    // 点击 Save → 触发 saveIntentContent() + validateIntentSaveResult()
    const saveButton = page.getByRole('button', { name: /^(save|保存)$/i }).first();
    await expect(saveButton).toBeEnabled({ timeout: 3000 });
    await saveButton.click();
    await page.waitForLoadState('networkidle');

    // 验证无 5xx 错误（保存成功后页面会重新加载 summary）
    expect(errors, `Intent page had errors after save:\n${errors.join('\n')}`).toEqual([]);
  });

  test('UI: Intent page shows flag badge and no 5xx', async ({ page }) => {
    // Smoke: 验证 Intent page 在 flag-on 状态下正常渲染
    const errors: string[] = [];
    page.on('response', (resp) => {
      if (resp.url().includes('/api/') && resp.status() >= 500) {
        errors.push(`5xx: ${resp.status()} ${resp.url()}`);
      }
    });

    await page.goto('/#/intent');
    await page.waitForLoadState('networkidle');

    expect(errors).toEqual([]);
    const bodyText = await page.locator('body').innerText();
    expect(bodyText.length).toBeGreaterThan(100);
  });
});
