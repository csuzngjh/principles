<!--
PR 模板分层说明：
- agent 段（产品意图/变更概览/验证步骤/风险/技术自检/测试）：由 agent 填写
- owner 段（产品品味审计）：由产品 owner 填写，agent 不得代填
- 规则引用稳定 ID：rc-* / cli-* / mvp-q-* / antipattern-*（见 AGENTS.md）
-->

## 产品意图（agent 填，owner 确认）
- 对应 Linear issue: ___
- 解决的产品问题（一句话）: ___
- emotional-value：降低 [失控感/疲惫感/重复纠正感/信息过载] 创造 [安心感/掌控感/沉淀感/清醒感]
  - 如无明确情绪价值，说明为何仍是必要的: ___
  - 规则引用: `mvp-q-4-emotional-value`

## 变更概览（agent 填）
### 变更类型
- [ ] 🐛 Bug 修复
- [ ] ✨ 新功能
- [ ] 📝 文档更新
- [ ] 🔧 重构/优化
- [ ] 🧪 测试

### 高层变更（3-5 条，非逐文件 diff）
-

### 影响范围
- [ ] packages/principles-core
- [ ] packages/openclaw-plugin
- [ ] packages/pd-cli
- [ ] packages/pd-console
- [ ] docs
- 其他: ___

### 是否触及产品边界
- [ ] 否
- [ ] 是（需 maintainer 批准，附理由）: ___

## 验证步骤（agent 填，owner 执行）
<!-- 按 action / observation 格式。owner 不读代码，按步骤执行并观察。
     每条要么是 action（动作），要么是 observation（观察结果）。 -->
- [ ] 前置条件: ___（如启用 flag / 启动某服务 / 准备测试数据）
- [ ] 动作 1: ___
  - 观察: ___
- [ ] 动作 2: ___
  - 观察: ___
- 证据（截图/CLI 输出关键行）: ___

## 风险与可逆性（agent 填）
- 主要风险: ___
- 回滚方式: [ ] feature flag  [ ] PR revert  [ ] 无需回滚
- 是否需要 feature flag:
  - [ ] 否
  - [ ] 是（名称: ___）
  - 规则引用: `mvp-q-3-how-disabled` —— 任何需 PR revert 的变更必须带 flag
### MVP 三问自答
- `mvp-q-1-what-if-skip`: 30 天后还会有人提起吗？___
- `mvp-q-2-how-observed`: 如何观察它生效？___
- `mvp-q-4-emotional-value`: 已在产品意图段填写

## 技术自检（agent 填，owner 可跳过）

### 检查清单
- [ ] 代码符合项目风格
- [ ] 文档已更新
- [ ] 无破坏性变更（或已标记为 breaking change）
- [ ] 通过 Thinking OS 检查（T-01/T-04/T-05）
- [ ] 迁移删除检查：如果删除了源文件，确认 barrel (`index.ts`) 和 compile test (`exports-compile.ts`) 已同步清理
- [ ] Core 边界检查：本 PR 是否在 `packages/principles-core/src/` 新增了 `fs`/`path` 导入？如果是，是否更新了 `architecture-regression.test.ts` 的白名单和 `eslint.config.js` 的豁免列表？
  - 规则引用: `antipattern-core-io`

### Core Store 契约变更审计（条件性 — 仅当修改 `packages/principles-core/src/**/sqlite-*-store.ts` 时填写）
<!-- 若本 PR 修改了 core store 方法的签名、新增 throw guard、或新增 precondition，
     必须列出所有跨包 caller 并确认已验证。参考 ERR-083。 -->
<!-- 触发条件：packages/principles-core/src/**/sqlite-*-store.ts 中任何方法的
     签名变更、新增 throw、或新增 precondition（如 FK 校验、必填字段校验） -->

- [ ] N/A — 本 PR 未修改 core store 契约
- 或填写审计结果:
  - 修改的 store 文件与方法: ___
  - 新增的 throw / precondition: ___
  - 跨包 caller 审计（列出所有 caller 文件路径 + 是否已验证）:
    - `packages/openclaw-plugin/...`: 已验证 / 未验证
    - `packages/pd-cli/...`: 已验证 / 未验证
    - `packages/pd-console/...`: 已验证 / 未验证
    - `packages/create-principles-disciple/...`: 已验证 / 未验证
  - 规则引用: `ERR-083` — 共享 store 契约变更必须审计跨包 caller

### ERR Checklist（必填）
<!-- 列出本 PR 考虑过的 ERR 条目（最少 3 个），及如何避免复发。参考 docs/process/error-management/ERROR_PATTERN_INDEX.md -->
<!-- 示例：ERR-001 (parsed JSON as any) — 本 PR 使用 typeof 类型守卫，未使用 as 绕过 -->

- ERR-___:
- ERR-___:
- ERR-___:

### Runtime Contract 自检（必填）
<!-- 本 PR 是否处理不可信数据（parsed JSON / LLM output / DB diagnosticJson / artifact metadata）？ -->
<!-- 若是，按稳定 ID 勾选适用规则并说明遵守方式；若否，填写 "N/A — 本 PR 不处理不可信数据" -->

- [ ] 本 PR 处理不可信数据
- [ ] `rc-1-treat-as-unknown` — 不可信数据视为 unknown，不用 any
- [ ] `rc-2-no-as-bypass` — 不用 as 绕过运行时校验
- [ ] `rc-3-fail-loud-missing` — 必填字段缺失即失败
- [ ] `rc-4-validate-array-elements` — 校验数组元素类型
- [ ] `rc-5-object-hasown-not-in` — 用 Object.hasOwn() 不用 in
- [ ] `rc-6-lineage-consistency` — 血缘字段同源
- [ ] `rc-7-loop-state-freshness` — 重试循环区分当前/下一/已记录状态
- [ ] `rc-8-safe-serialization` — 预览/遥测用安全序列化
- [ ] `rc-9-no-silent-fallback` — 优雅降级必须含原因
- 遵守方式说明（N/A 时填理由）:

### CLI Gate 自检（条件性 — 仅当修改 `packages/pd-cli/src/commands/**` 时填写）
<!-- 若本 PR 修改了 CLI 命令，按稳定 ID 逐条确认 -->

- [ ] N/A — 本 PR 未修改 CLI 命令
- 或填写适用规则：
  - [ ] `cli-1-strict-json` — JSON mode 严格输出
  - [ ] `cli-2-exit-stops` — exit 后立即 return
  - [ ] `cli-3-negated-flags-parser-tests` — --no-* flag 有 parser 测试
  - [ ] `cli-4-dry-run-confirm-mutex` — dry-run/confirm 互斥
  - [ ] `cli-5-failure-no-mutation` — 失败路径不 mutate state
  - [ ] `cli-6-output-next-action` — 降级输出含 nextAction
  - [ ] `cli-7-test-wiring` — 测试真实 command wiring

### Feature Flag 注册检查（条件性 — 仅当引入新功能子系统/hook/writer/reader 时填写）
<!-- 若本 PR 引入新的功能子系统、hook、writer 或 reader，需在 .pd/config.yaml 注册 (ADR-0016: 旧 .pd/feature-flags.yaml 已不再被生产 runtime 读取) -->
<!-- 参考 AGENTS.md "Feature Flag Registration" 章节 -->

- [ ] N/A — 本 PR 未引入新功能子系统
- 或填写注册情况:

### 反模式触发词检查
<!-- 检查 PR 描述/issue 是否包含触发词。引用 antipattern-* -->
- [ ] 无 `antipattern-future-extensibility`（"为未来铺路"）
- [ ] 无 `antipattern-completeness`（"为完整性"）
- [ ] 无 `antipattern-review-missing`（"review 时觉得缺失"）
- [ ] 无 `antipattern-core-io`（"在 core 写 I/O 代码"）

## 产品品味审计（owner 填，agent 不得代填）
<!-- 这些问题只有产品 owner 能回答。agent 不得代填。 -->

- [ ] 提醒方式是否克制？（非大声通知，精巧视觉）
- [ ] 命名是否符合双语规范？
- [ ] 交互是否符合"最小连贯干预"原则？
- [ ] 错误路径是否给了 nextAction，而非 silent fallback？（`rc-9-no-silent-fallback`）
- [ ] 是否符合 PD 产品边界？（非任务执行/通用记忆/工具修复/自主价值决策）
- 产品品味备注（可选）: ___

## 测试结果（agent 填）
- [ ] `cd packages/principles-core && npm run test`: 通过
- [ ] `cd packages/openclaw-plugin && npm run test`: 通过
- [ ] `npm run lint`: 通过
- [ ] `npm run verify:merge`: 通过 / 未运行

## 相关 Issue
<!-- 关闭的 issue：Closes #XX -->
