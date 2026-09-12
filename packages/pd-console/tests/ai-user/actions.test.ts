/**
 * PRI-754 — 动作执行辅助逻辑的单元测试。
 * normalizeSelector：模型把可访问性快照行当选择器是实测最高频的格式误差，
 * 确定性翻译必须覆盖（真实 run 中抓到的 case 全部沉淀为负向/正向样例）。
 * navigate 同源约束：协议相对 URL（//host/path）会被解析到他源，必须拒绝
 * （Codex 评审 P1，防止把内网页面快照送给 LLM）。
 */
import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { executeAiUserAction, normalizeSelector } from './actions.js';

/** 测试替身（非信任边界）：仅实现 navigate 路径用到的 goto。 */
function fakePage(gotoCalls: string[]): Page {
  return {
    goto: async (url: string) => {
      gotoCalls.push(url);
      return null;
    },
  } as unknown as Page;
}

describe('navigate 同源约束', () => {
  const baseUrl = 'http://127.0.0.1:7000';

  it('站内路径解析为绝对 URL 后放行', async () => {
    const calls: string[] = [];
    const result = await executeAiUserAction(
      fakePage(calls),
      { type: 'navigate', value: '/#/settings' },
      { baseUrl },
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['http://127.0.0.1:7000/#/settings']);
  });

  it.each([
    ['协议相对路径', '//evil.example/path'],
  ])('%s 解析到他源时拒绝（P1 负向对照）', async (_label, value) => {
    const calls: string[] = [];
    const result = await executeAiUserAction(fakePage(calls), { type: 'navigate', value }, { baseUrl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('越权');
    expect(calls).toEqual([]);
  });

  it('非 / 开头路径直接拒绝', async () => {
    const calls: string[] = [];
    const result = await executeAiUserAction(
      fakePage(calls),
      { type: 'navigate', value: 'https://evil.example.com' },
      { baseUrl },
    );
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('normalizeSelector', () => {
  it.each([
    ['link "前往设置"', 'role=link[name="前往设置"]'],
    ['button "开始初始化"', 'role=button[name="开始初始化"]'],
    ['textbox "名称"', 'role=textbox[name="名称"]'],
    ['  heading "PD Console"  ', 'role=heading[name="PD Console"]'],
  ])('%s 翻译为 role 选择器', (input, expected) => {
    expect(normalizeSelector(input)).toBe(expected);
  });

  it.each([
    ['role=button[name="开始"]', '已是合法选择器，透传'],
    ['text=开始', 'text 选择器透传'],
    ['#submit', 'CSS 透传'],
    ['navigation >> button', '链式选择器透传'],
  ])('%s 原样透传', input => {
    expect(normalizeSelector(input)).toBe(input);
  });
});
