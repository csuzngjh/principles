# TDD Feature 开发工单模板

*使用场景：用于常规的功能实现、业务逻辑变更或新能力开发。*

## 目标 (Goal)
[用一句话说明：完成这个 Issue 后，系统应该具备什么样的新能力？]

## 上下文 (Context)
[说明相关的 Milestone、父级 Issue、PR、设计文档或架构约束。]

## 必读前置文档 (Must Read First)
* 架构设计：
  * `docs/architecture/DOMAIN_MODEL.md`
* 相关代码：
  * [填写核心需要修改的入口文件]

## 影响范围 (Scope)
允许的行为变更：
* ...

允许修改的文件/模块：
* ...

## 非目标 (Non-Goals)
明确超出本次范围的事项（防止过度设计）：
* 绝对不要 ...
* 绝对不要 ...

## TDD 要求 (TDD Requirements)
1. **必须先写测试**，并确认测试在当前代码下会报错（Fail Loud）。
2. 只实现能让测试通过的最小代码量（Simplicity First）。
3. 补充针对边缘情况的回归测试。

**必须包含的测试用例：**
* [正向用例 1]
* [反向/异常用例 1]

## 验收标准 (Acceptance Criteria)
- [ ] 已在实现代码前添加了失败的测试
- [ ] 所有相关的 `npm run build` 和 `npx vitest run` 均通过
- [ ] 没有引入 Non-Goals 里禁止的行为
- [ ] Linear 的完成评论中包含了修改的文件、测试结果和遗留风险

## 完成评论模板 (Completion Comment)
```text
已关联 PR：
修改的文件范围：
通过的测试：
遗留风险：
后续建议：
```