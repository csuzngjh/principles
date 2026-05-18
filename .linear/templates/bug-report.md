# Bug 修复工单模板

*使用场景：用于记录和修复生产环境或测试中发现的缺陷。*

## 缺陷描述 (Bug Description)
[清晰简洁地描述 Bug 的表现]

## 复现步骤 (Steps to Reproduce)
1. 运行命令 / 点击...
2. 输入参数...
3. 看到错误...

## 期望行为 (Expected Behavior)
[描述在正常情况下系统应该如何运作]

## 错误日志/证据 (Logs/Evidence)
```text
[在这里粘贴报错日志或堆栈信息]
```

## TDD 要求 (TDD Requirements)
**绝对禁止直接修改业务代码！**
1. 必须先写一个能够复现该 Bug 的失败测试（Fail Loud）。
2. 运行测试，证明它确实报错了。
3. 修复 Bug，使刚才的测试通过。
4. 确保没有破坏现有的架构防腐测试。

## 验收标准 (Acceptance Criteria)
- [ ] 包含了复现该 Bug 的单元/集成测试
- [ ] Bug 已修复且测试通过
- [ ] Linear 的完成评论中包含了失败原因和修复方案

## 完成评论模板 (Completion Comment)
```text
根本原因：
修复方案：
复现测试路径：
潜在影响：
```