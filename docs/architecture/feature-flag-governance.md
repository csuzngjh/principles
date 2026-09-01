# Feature Flag Governance (PRI-574)

> 2026-08-24。目标：让每个注册 flag 的 consumer、默认值、回滚路径可审计，
> 并用契约测试阻止 silent drift。按工单 Non-goal 约束，不做架构重构。

## 1. 注册表事实源与消费链

单一事实源：`packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts`
的 `DEFAULT_FEATURE_FLAGS`。派生链：

```
feature-flag-contract.ts (registry)
  ├─ principles-core config/pd-config-defaults.ts → getDefaultPdConfig()
  │    └─ host-runtime pd-config.ts → loadPdConfigForPlugin / loadFeatureFlagFromConfig
  │         └─ openclaw-plugin hooks (gate/prompt/…) + pd-cli commands + pd-console server
  └─ create-principles-disciple mvp-config.ts → 安装器生成的 .pd/config.yaml 模板
       （独立硬编码，无 core 依赖 —— 由 installer-config-parity.test.ts 双向对账）
```

两套消费 API 并存（`computeEffectiveFlags` vs `computeFeatureFlagsFromConfig/loadFeatureFlagFromConfig`）
属已知债务；两者都从同一 registry 取默认值，语义一致。统一 API 属重构，超出本任务范围。

## 2. 每个 flag 的 consumer 地图（重新核实于 2026-08-24）

| flag | 默认 | 生产 consumer（file:line 级证据见测试） | 判定 |
| --- | --- | --- | --- |
| prompt / code_tool_hook / defer_archive / rulecode_* / code_rule_capability / host.codex / internalization_full_chain / new_user_onboarding | ON (core) | 三条激活路径与 RuleHost 管线（ADR-0014 §2.4） | ✅ |
| internalization_auto_consumer / story_a_approval_completion / failed_tasks_observability / evaluator_artificer_repair_loop / painEvidenceAdmission(+alias/Default) / feedback_channel / diagnostician_core_grounding / internalization_core_grounding / failed_task_recovery_console | ON (quiet) | 各自运行时路径（PRI-239 起"仅注册有真实消费路径的 flag"约束） | ✅ |
| diagnostician_split_pipeline | ON (quiet) | 仅剩 config 一致性 guard（pain-signal-runtime-factory：`split && !async_cli` fail-loud）。**PRI-638 起不再是 capability kill switch，也不再选择实现**——树中只剩 split 实现，capability 开关是 `internalAgents.agents.diagnostician.enabled` | ⚠️ DEPRECATE / DEFER DELETE |
| **principle_receipt_ledger** | **ON（毕业）** | openclaw-plugin gate.ts:158/322、prompt.ts:613、pd-console ReceiptsConsoleModel、pd-cli principles-stats | ✅ 已毕业 |
| **principle_receipt_block_copy** | **ON（毕业）** | openclaw-plugin gate-block-helper.ts:242 | ✅ 已毕业 |
| **diagnostician_llm_degradation** | **ON（毕业）** | principles-core base-peer-runner.ts:939、diag-*-runner、pd-cli diagnose/pain-retry | ✅ 已毕业 |
| **principle_governance_projection_v2** | **ON（毕业）** | pd-console server/routes/principles.ts governance 端点 | ✅ 已毕业 |
| **artificer_output_retry** | **ON（毕业）** | principles-core artificer-runner.ts permanentErrorCategories（PRI-621，2026-08-29 毕业：与其他 peer runner 的 output_invalid 重试语义对齐） | ✅ 已毕业 |
| principle_receipt_self_report | OFF | prompt 注入 📝 行 + llm_output/before_message_write 捕获（PRI-532）；installer 与 registry 均保持关闭 | ✅ 实验性，保持默认关 |
| correction_observer / signal_collector / l2_dreamer / intent_engineering / rulecode_context_v2 / artifact_summary_redundancy / context_manifest_budget / progressive_evaluator / abstraction_layer_v1 / diagnostician_async_cli / pain_diagnosis_persistence / gfi / evolution_worker / empathy_observer | OFF (quiet) | 见 §3 两个重点案例与其余 quiet 待验证项 | ⚠️/✅ |
| nocturnal / idle_trigger | gone | 无（禁止复活，computeEffectiveFlags 强制拒绝） | ✅ 正常退役 |

## 3. 重点案例（本任务结论）

### 3.1 `gfi` — "注册但无有效 consumer" 的复核结果

工单发现部分成立、部分过时：

- **存在读取型 consumer**：`pd runtime health gfi` 快照命令（`runtime-gfi-snapshot.ts`）与
  canary 检查（`runtime-canary.ts:156` 读 flag 决定是否跳过快照）。
- **门控缺口属实**：openclaw-plugin 内的摩擦评分链路（session-tracker /
  after-tool-call friction / prompt decay）**从不检查 gfi flag**——评分无条件运行。
  翻转该 flag 不改变任何写入行为，只影响 CLI 只读展示。

处置：**不删除、不擅自接线**。两条路都是行为变更（接线 = live 上 gfi:false 却一直评分的
现状会改变；删除 = 存量 workspace config.yaml 里的 gfi 条目会触发 unknown-flag 告警），
需 Owner 择一：①把评分写入纳入 flag 门控（推荐，恢复 quiet 语义）；②确认评分常开后删除 flag。
→ 已建 follow-up 工单记录。

### 3.2 `empathy_observer` — 注册表/agent binding 双轨

flag（quiet/off，gate 服务启动）与 `internalAgents.empathyObserver.enabled:false`
（gate runner 绑定）是两层不同的开关：前者控制信号服务，后者控制内部 agent 运行。
职责不同但命名易混淆。signal_collector 重构后 empathy 检测已迁移至 signal-collector-host
（empathy_observer 在 prompt.ts 的旧消费点已废弃）。处置：维持现状 + 本文档澄清；
如 Owner 同意可在后续 MVP-Gone 清理波次中评估合并。

### 3.3 installer MVP flag 列表硬编码漂移风险 — 已闭合

新增 `packages/principles-core/src/runtime-v2/feature-flags/__tests__/installer-config-parity.test.ts`：
- installer 模板写入的每个 flag 必须存在于 registry（防孤儿条目）；
- category 必须与 registry 一致；
- enabled 必须与 registry 默认值一致，防止真实新用户配置绕过实验性能力的默认关闭契约。
双向 silent drift 从此被 CI 阻断。

## 4. 防漂移检查清单（现有机制盘点）

| 机制 | 位置 | 覆盖 |
| --- | --- | --- |
| unknown flag 告警 | computeEffectiveFlags / computeFeatureFlagsFromConfig | config.yaml 写错 flag id 时 warn |
| gone flag 复活拒绝 | computeEffectiveFlags gone 分支 | 退役 flag 无法被配置复活 |
| core flag 应急关闭可观测 | computeEffectiveFlags core 分支 warning | 显式 disable 记录在 warnings |
| registry↔surface registry 对账 | evolution-worker-slimming.test.ts (PRI-294) | evolution_worker/empathy_observer/gone 组 |
| **registry↔installer 模板对账** | installer-config-parity.test.ts（本任务新增） | installer 全部 17 条 features |
| 默认值毕业状态锁定 | feature-flag-contract.test.ts PRI-571 块 + PRI-621 块 | 5 个毕业 flag 默认开+quiet+可关 |

## 5. 明确不做（Non-goal）

- 不统一两套 flag consumption API（重构）。
- 不删除/接线 gfi、不合并 empathy_observer 双轨（行为变更，待 Owner 决策）。
- 不为"完整性"给 quiet-off flag 补 consumer（AGENTS.md 反模式触发器 antipattern-completeness）。
