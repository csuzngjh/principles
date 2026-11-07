# 设计增量卡（已并入 Path A 设计 v2）：默认 shared route 的逐原则期望集

- 文档 ID：`pd-aa-pri-1119-shared-route-increment-20261107`
- 状态：**已并入** [PD-AA-PRI-1119-PD-SELF-DELIVERY-DESIGN-20261107.md](./PD-AA-PRI-1119-PD-SELF-DELIVERY-DESIGN-20261107.md) v2 §2（2026-11-07，按 Owner 第七轮指令"不要另起多份方案"）；本卡保留为历史记录，不再单独审批——以 v2 设计的批准为准
- 依据：Owner 第六轮指令 §2.5——"若需要超出已批准设计的 host-runtime 接口变更，先提交一张精简设计增量卡"；本卡不阻塞其他已批准修复

## 1. 问题

`before_prompt_build` 的 shared route（生产主路径）下，`dedupedV2` 为空：逐原则正文在 host-runtime 的 `buildActivePrinciplePrompt`（`packages/host-runtime/src/active-principle-prompt.ts`）内部装配，经 `ActivePrinciplePromptResult.additionalContext` 以**合并文本**交付。插件侧能拿到 `principleIds/activationIds/artifactIds`（身份），拿不到**逐原则正文**。因此默认路径无法冻结逐原则期望集 → `provider.prompt.observed.presenceCheck` 在主路径缺失。

被禁止的替代方案（已排除）：事后读最新数据库（非冻结装配事实）；反向解析 `additionalContext` 展示文本；全局最新值缓存。

## 2. 最小接线差异

| # | 文件 | 改动 | 角色 |
|---|---|---|---|
| 1 | `packages/host-runtime/src/active-principle-prompt.ts` | `ActivePrinciplePromptResult` 增加可选 `injectedExpectations?: {activationId, principleId, bodyText, bodyChars, bodyComplete}[]` 与 `injectedExpectationsOverflow?: number`；装配函数在**渲染完成后、返回前**冻结（每条 bodyText = 该原则渲染进 additionalContext 的实际转义文本；bodyComplete = 包含判定；与渲染同源，无第二次读取） | 生产者 |
| 2 | `packages/host-runtime` 的调用点（宿主把结果传入插件 hook 的位置） | 无需改动——结果对象整体已沿既有返回链传递 | 传递（既有） |
| 3 | `packages/openclaw-plugin/src/hooks/prompt.ts`（shared route 分支） | freeze 调用改用 `sharedActivePrinciplePrompt.injectedExpectations`（若存在）作为 rendered 候选源；final/preGuard 分类与回退排除逻辑**复用现有 helper**（buildInjectedExpectations），最终一致性仍由守卫后判定保证 | 消费者 |

不改动：PD 侧授权/治理、openclaw 侧检查器与传输接线、机会识别、注入事件结构。

## 3. 输入输出与失败处理

- 输入：host-runtime 装配期内存中的原则记录（与 additionalContext 同一次渲染）。
- 输出：逐原则冻结文本（内存对象，随结果对象传递；不落盘、不入日志）。
- 失败处理：字段缺省（旧调用方/失败路径）→ shared route 期望集为空 → 无 presenceCheck 字段（与现状相同，不静默变红）；helper 自身 fail-open。
- 有界性：host-runtime 冻结处同样适用 64 条上限 + 溢出计数（与缺陷 4 修复一致）。

## 4. 测试

- host-runtime 单测：装配冻结字段与 additionalContext 一致（逐条包含）；截断时 bodyComplete=false；溢出计数。
- 插件单测：shared route 分支使用 host-runtime 期望集 + 守卫后分类；回退排除复用现有用例形态。
- 离线接线验证：假 host-runtime 结果（含 injectedExpectations）→ 插件 hook → wrapper carrier → 检查器（现有 capture 测试形态）。

## 5. 成本与回滚

- 成本：host-runtime 装配函数内 ~20 行（已有渲染结果上做包含判定）；无 I/O、无新存储。
- 回滚：字段为可选附加；revert host-runtime 与插件两处即可，旧字段消费方（本功能）随 revert 消失，无 schema 迁移。

## 6. 明确不做（等待本卡批准期间的状态）

- 本卡未批准前，缺陷 5 的 shared route 部分**不实现**；其他缺陷（1–4）已完成并随 PR 交付。
- 不自行把该缺口移出验收范围：若 Owner 否决本卡，shared route 的 presenceCheck 缺失将作为**已知限制**记录在 PR 与 Linear（不宣称 Tier B 在主路径完成）。
