/**
 * PRI-754 — Scenario 解析守卫的单元测试。
 * 覆盖 rc-3（缺失必填 fail-loud）、rc-4（数组元素逐个校验）、真实文件读取
 * 边界（EP-09：测试走真实 I/O，不只测内存对象）。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_STEPS, loadScenario, parseScenario } from './scenario.js';

const valid = { id: 's1', persona: '第一次使用PD的开发者', goal: '完成初始化', success: ['看到运行状态'] };

describe('parseScenario', () => {
  it('完整字段全部生效', () => {
    const s = parseScenario({ ...valid, observe: ['首屏指引'], maxSteps: 5, startUrl: '/governance' });
    expect(s).toEqual({
      id: 's1',
      persona: '第一次使用PD的开发者',
      goal: '完成初始化',
      success: ['看到运行状态'],
      observe: ['首屏指引'],
      maxSteps: 5,
      startUrl: '/governance',
    });
  });

  it('缺省字段取默认值', () => {
    const s = parseScenario(valid);
    expect(s.observe).toEqual([]);
    expect(s.maxSteps).toBe(DEFAULT_MAX_STEPS);
    expect(s.startUrl).toBe('/');
  });

  it.each(['id', 'persona', 'goal'] as const)('缺失必填字段 %s 时 fail-loud', field => {
    const broken = { ...valid };
    delete broken[field];
    expect(() => parseScenario(broken)).toThrow(new RegExp(`字段 "${field}"`));
  });

  it.each([
    ['空字符串', { ...valid, id: '  ' }],
    ['非字符串', { ...valid, goal: 42 }],
  ])('%s 时 fail-loud', (_label, broken) => {
    expect(() => parseScenario(broken)).toThrow(/非空字符串/);
  });

  it('success 缺失/空数组/非数组/非字符串元素均拒绝（rc-4）', () => {
    expect(() => parseScenario({ ...valid, success: undefined })).toThrow(/字段 "success" 缺失/);
    expect(() => parseScenario({ ...valid, success: [] })).toThrow(/不能是空数组/);
    expect(() => parseScenario({ ...valid, success: '看到状态' })).toThrow(/每个元素/);
    expect(() => parseScenario({ ...valid, success: ['ok', 3] })).toThrow(/每个元素/);
  });

  it('observe 元素非字符串拒绝', () => {
    expect(() => parseScenario({ ...valid, observe: [1] })).toThrow(/observe/);
  });

  it.each([0, -1, 1.5, 'ten', true])('maxSteps 非法值 %p 拒绝', bad => {
    expect(() => parseScenario({ ...valid, maxSteps: bad })).toThrow(/maxSteps/);
  });

  it('根节点不是 mapping 时拒绝', () => {
    expect(() => parseScenario('just a string')).toThrow(/mapping/);
    expect(() => parseScenario(['a'])).toThrow(/mapping/);
    expect(() => parseScenario(null)).toThrow(/mapping/);
  });
});

describe('loadScenario', () => {
  it('从真实 YAML 文件加载（round-trip）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-user-scenario-'));
    const file = join(dir, 'demo.yaml');
    writeFileSync(
      file,
      ['id: file-demo', 'persona: 测试用户', 'goal: 完成目标', 'success:', '  - 条件一', '  - 条件二'].join('\n'),
      'utf8',
    );
    const s = loadScenario(file);
    expect(s.id).toBe('file-demo');
    expect(s.success).toEqual(['条件一', '条件二']);
  });

  it('文件不存在时报出路径', () => {
    const missing = join(tmpdir(), 'ai-user-not-exist', 'nope.yaml');
    expect(() => loadScenario(missing)).toThrow(/无法读取 scenario 文件/);
  });
});
