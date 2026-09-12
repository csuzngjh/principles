/**
 * PRI-754 — 动作执行辅助逻辑的单元测试。
 * normalizeSelector：模型把可访问性快照行当选择器是实测最高频的格式误差，
 * 确定性翻译必须覆盖（真实 run 中抓到的 case 全部沉淀为负向/正向样例）。
 */
import { describe, expect, it } from 'vitest';
import { normalizeSelector } from './actions.js';

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
