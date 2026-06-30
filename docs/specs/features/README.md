# BDD Feature 规约

本目录存放 PD 项目的 BDD 行为规约文件 (.feature)。

## 怎么读

- `.feature` 文件用 Gherkin 语法,Given/When/Then 描述行为
- 中文关键词:假如/当/那么 (与 Given/When/Then 等价)
- `@mvp-core` 标签:MVP-Core 用户旅程,改动需谨慎
- `@prd-matrix:xxx` 标签:对应 PRD 验收矩阵项
- `@disabled(reason,owner,date)` 标签:显式禁用场景,runner 会输出 skip 报告

## 怎么加场景

1. 在对应子目录创建 `.feature` 文件 (如 `story-a/xxx.feature`)
2. 写 Feature + Scenario + Given/When/Then
3. 在对应包的 `tests/bdd/xxx.steps.ts` 实现 step definitions
4. 跑测试验证:`cd packages/<pkg> && npm test`

## 禁用场景

**禁止**通过删除 `.feature` 文件让测试绿。禁用必须显式:

```gherkin
@disabled(reason="功能被移除",owner="owner-001",date="2026-06-30")
Scenario: 被禁用的场景
  ...
```

runner 会输出:`SKIP: 场景名 [SKIP: 功能被移除; owner=owner-001; date=2026-06-30]`

## 双语策略

Phase 1 全中文 (Owner 是中文非技术用户)。术语首次出现中英对照,如 `原则 (principle)`。
