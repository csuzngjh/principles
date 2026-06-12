## PRI-360 S1 CI 修复完成

### Pain Signal
- **painId**: `manual_1781264655076_3t1pxkra` (score=82)
- **问题**: 初始提交本地 build 通过但 CI 失败——stale tests 调用已删除 API + tool failure 分类逻辑未收敛到 adapter 层

### 修复内容 (commit `09044bf7`)
1. **新增 `buildToolFailureObservation()` builder** — 收敛 error→dispatch/tool_failure 分类到 adapter 层
2. **新增 `buildLlmDetectionObservation()` builder** — LLM 检测上下文
3. **重写 triage-adapter.test.ts** — 全部使用 `resolveSourceKind(RawObservation)`
4. **重写 pain.test.ts** — classifyToolFailureSource 测试 → builder + resolveSourceKind

### 验证
- ✅ build: PASS
- ✅ test:unit: 102 files, 1468 tests passed
- ✅ test:coverage: triage-adapter 100%, raw-observation-adapter 98%
- ✅ verify:merge: PASS

### PR
https://github.com/csuzngjh/principles/pull/907

### Dogfood 价值
这个 pain signal 是一个真实的 PEAT-5 样本：agent 过早报告完成，CI 收敛不完整。
