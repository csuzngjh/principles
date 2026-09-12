/**
 * PRI-754 — AI User 动作执行器（Playwright 白名单）。
 *
 * 只执行白名单内的动作；任何失败都以结构化结果返回（rc-9 可观察），不中断
 * 循环——选择器找不到本身就是有价值的用户体验证据，AI User 应据此换路或
 * 如实记录问题。
 */
import type { Page } from '@playwright/test';
import type { AiUserAction } from './llm.js';

export interface ActionExecutionResult {
  ok: boolean;
  error?: string;
}

const ACTION_TIMEOUT_MS = 8000;
const MAX_WAIT_MS = 2000;
const ERROR_MAX_CHARS = 500;

/**
 * 模型常把可访问性快照的行（如 `link "前往设置"`）直接当选择器；这是最常见
 * 的自然格式误差，这里确定性翻译成 Playwright role 选择器，其余原样透传。
 */
const ARIA_NAME_PATTERN = /^(button|link|textbox|checkbox|heading|tab|combobox|searchbox|menuitem|radio|switch|option)\s+"([^"]+)"$/;

export function normalizeSelector(target: string): string {
  const matched = target.trim().match(ARIA_NAME_PATTERN);
  if (matched?.[1] && matched[2]) {
    return `role=${matched[1]}[name="${matched[2]}"]`;
  }
  return target;
}

function boundedError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length <= ERROR_MAX_CHARS ? msg : msg.slice(0, ERROR_MAX_CHARS) + '…[截断]';
}

export async function executeAiUserAction(
  page: Page,
  action: AiUserAction,
  opts: { baseUrl: string },
): Promise<ActionExecutionResult> {
  try {
    switch (action.type) {
      case 'navigate': {
        const url = action.value;
        if (typeof url !== 'string' || !url.startsWith('/')) {
          return { ok: false, error: 'navigate 需要 / 开头的站内路径' };
        }
        // 模型给出的是站内路径（可能含 hash 路由如 /#/settings），必须先解析
        // 成绝对 URL；协议相对形式（//evil.example/path）会被解析到他源，
        // 必须与 Console 同源才放行，防止把内网页面快照送给 LLM（rc-1 信任边界）
        let resolved: URL;
        try {
          resolved = new URL(url, opts.baseUrl);
        } catch {
          return { ok: false, error: 'navigate 路径无法解析' };
        }
        if (resolved.origin !== new URL(opts.baseUrl).origin) {
          return { ok: false, error: `navigate 目标越权（非 Console 同源）: ${url}` };
        }
        await page.goto(resolved.toString(), { waitUntil: 'load', timeout: 15_000 });
        return { ok: true };
      }
      case 'click': {
        const target = action.target;
        if (typeof target !== 'string' || target.length === 0) {
          return { ok: false, error: 'click 缺少 target' };
        }
        await page.click(normalizeSelector(target), { timeout: ACTION_TIMEOUT_MS });
        return { ok: true };
      }
      case 'fill': {
        const target = action.target;
        if (typeof target !== 'string' || target.length === 0) {
          return { ok: false, error: 'fill 缺少 target' };
        }
        await page.fill(normalizeSelector(target), action.value ?? '', { timeout: ACTION_TIMEOUT_MS });
        return { ok: true };
      }
      case 'press': {
        const key = action.value;
        if (typeof key !== 'string' || key.length === 0) {
          return { ok: false, error: 'press 缺少键名' };
        }
        await page.keyboard.press(key);
        return { ok: true };
      }
      case 'wait': {
        const ms = Number(action.value);
        const duration = Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_WAIT_MS) : 1000;
        await page.waitForTimeout(duration);
        return { ok: true };
      }
      case 'finish':
        return { ok: true };
    }
  } catch (err) {
    return { ok: false, error: boundedError(err) };
  }
}
