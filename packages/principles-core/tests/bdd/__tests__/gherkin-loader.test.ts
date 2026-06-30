import { describe, it, expect } from 'vitest';
import { parseFeature } from '../support/gherkin-loader.js';

describe('gherkin-loader', () => {
  it('解析单个 scenario 含 Given/When/Then', () => {
    const feature = `Feature: 测试特性
  Scenario: 测试场景
    Given 前提条件
    When 动作
    Then 期望结果
`;
    const scenarios = parseFeature(feature);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].scenarioName).toBe('测试场景');
    expect(scenarios[0].steps).toEqual([
      { keyword: 'Given', text: '前提条件' },
      { keyword: 'When', text: '动作' },
      { keyword: 'Then', text: '期望结果' },
    ]);
  });

  it('解析多个 scenario', () => {
    const feature = `Feature: 多场景
  Scenario: 场景一
    Given A
    Then B
  Scenario: 场景二
    Given C
    Then D
`;
    const scenarios = parseFeature(feature);
    expect(scenarios).toHaveLength(2);
    expect(scenarios[0].scenarioName).toBe('场景一');
    expect(scenarios[1].scenarioName).toBe('场景二');
  });

  it('解析 scenario 标签', () => {
    const feature = `Feature: 标签测试
  @mvp-core @prd-matrix:owner-reject
  Scenario: 带标签的场景
    Given A
    Then B
`;
    const scenarios = parseFeature(feature);
    expect(scenarios[0].scenarioTags).toContain('@mvp-core');
    expect(scenarios[0].scenarioTags).toContain('@prd-matrix:owner-reject');
  });

  it('解析 feature 标签', () => {
    const feature = `@mvp-core
Feature: 特性级标签
  Scenario: 场景
    Given A
    Then B
`;
    const scenarios = parseFeature(feature);
    expect(scenarios[0].featureTags).toContain('@mvp-core');
  });

  it('解析 Background 步骤', () => {
    const feature = `Feature: 背景
  Background:
    Given 全局前提
  Scenario: 场景
    Then B
`;
    const scenarios = parseFeature(feature);
    expect(scenarios[0].background).toEqual([
      { keyword: 'Given', text: '全局前提' },
    ]);
  });

  it('解析 And 步骤', () => {
    const feature = `Feature: And
  Scenario: 场景
    Given A
    And 又一个前提
    Then B
`;
    const scenarios = parseFeature(feature);
    expect(scenarios[0].steps[1]).toEqual({ keyword: 'And', text: '又一个前提' });
  });

  it('解析中文关键词(假如/当/那么)', () => {
    const feature = `Feature: 中文
  Scenario: 中文场景
    假如 前提
    当 动作
    那么 结果
`;
    const scenarios = parseFeature(feature);
    expect(scenarios[0].steps).toEqual([
      { keyword: 'Given', text: '前提' },
      { keyword: 'When', text: '动作' },
      { keyword: 'Then', text: '结果' },
    ]);
  });

  it('语法错误时 fail loud', () => {
    const malformed = `Feature: 缺少 scenario
这条线不是合法 gherkin
`;
    expect(() => parseFeature(malformed)).toThrow(/parse|malformed|invalid/i);
  });

  it('featureName 正确解析', () => {
    const feature = `Feature: 我的特性名
  Scenario: 场景
    Given A
`;
    const scenarios = parseFeature(feature);
    expect(scenarios[0].featureName).toBe('我的特性名');
  });
});
