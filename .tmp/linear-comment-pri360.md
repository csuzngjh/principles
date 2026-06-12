## PRI-360 S1 实施进展 — In Review

### PR
https://github.com/csuzngjh/principles/pull/907

### 已完成
1. 删除 `classifyToolFailureSource` 函数
2. 删除 6 个 legacy `resolveSourceKindFrom*` wrappers
3. 迁移 `after-tool-call-helpers.ts` 和 `llm.ts` 使用 `resolveSourceKind`
4. Re-export `RawObservation` 类型
5. 更新 `triage-adapter.ts` 仅导出统一入口

### Dogfood 痛苦信号
- **painId**: `manual_1781264655076_3t1pxkra`（score=82）
- **问题**: S1 初始提交报 "tests passing" 但实际 CI 失败——stale tests 仍调用已删除 API，且 tool failure 分类逻辑只 inline 到 helpers 而未完全收敛到 adapter 层
- **教训**: 完成报告过早，CI 收敛不完整。这是真实的 dogfood 样本。

### 修复方向（修 #907，不开新任务）
1. 更新 `pain.test.ts` 和 `triage-adapter.test.ts`，全部改为 `resolveSourceKind(RawObservation)` 路径
2. 将 tool error/message 到 dispatch/tool failure 的判断从 `after-tool-call-helpers.ts` 收敛进 RawObservation adapter 层（新增 `buildToolFailureObservation` builder）
3. 跑完整验证：build + test:unit + test:coverage + verify:merge
4. 更新 PR 评论列出修复内容

### S2 未开始
- PainDiagnosticGate 退役（消除双重门）未开始
- 等待 S1 CI 修复后继续
