# PRI-1104 单版本收敛：事实基线与分阶段计划（PR-1 地基）

> 状态：PR-1（PRI-1134）落地。本文是 `docs/audit/` 的当前状态报告，取代
> `.tmp/v1v2-audit/REPORT.md` 作为验收依据（后者仅作历史快照，勿删勿改）。
> 基线 commit：`9f477a9fc8cfa59204ce7aa4018637fbacdbb7a5`（origin/main，含 PR #2332 / #2365）。

## 1. Owner 目标

消除 PD 项目「多个版本代码共存」的局面。以**可替代性**为判据做单向收敛：V2 能完全替代 V1 才让 V1 的实现、分支、兼容层完整消失；V1 删除后把残留的 V2 命名也改掉，降低维护复杂度与歧义。不是字符串级全局替换。

父票 **PRI-1104** 保持 Backlog / P2 / 无负责人，**不因 PR #2332 已合并就置 Done**（票内 merge-reminder 只是提示，主体尚未实施）。

## 2. 复核结论：11-04 审计清单已经过时

按 AGENTS.md P1（证据优先）对当前代码复核，PRI-1104 描述里的分类需要修正：

| 审计说法 | 当前事实 |
| --- | --- |
| `signal-classification-output-v1` vs `-v2` 真缺陷待修 | **已修**。`host-runtime/src/signal-classifier.ts:65` 已是 `-v2`；registry 只注册 v2；测试断言 v1 不存在且传入会抛 `Unknown outputSchemaRef` |
| `ArtificerOutputV1Schema` 需保留读历史 | **已删**。生产零命中，仅测试断言 "V1 schema removed"；`pd-cli/src/commands/legacy-cleanup.ts` 只剩「按 `implementationCode` 判 V1 后删除」的历史产物清理判定 |
| `DiagnosticianOutputV1Schema` vs V2 并存未断裂 | **方向相反**：V1 是当前生产契约（registry、Stage C、`diagnostician-committer.ts`、`pain-signal-bridge.ts`），V2 是未接生产的 opt-in shadow |
| `EvaluatorOutputV1` vs V2 | **继承关系**，V2 `extends V1` 且附加字段全 optional；`evaluator-runner.ts` 泛型就是 V1。删 V1 会崩 |
| `legacy_fifo_prefix_v1` vs `fair_rotation_v1` | 同一函数内两分支，由 `roundKey` 是否存在决定，不是两份实现 |
| `runtime-v2` 是「纯命名，与双轨无关」 | **不只是命名**：是子系统目录 + 包导出子路径，全仓约 3,051 行 / 920 文件、12 个包强引用 |

**审计漏列**：
- 唯一仍在生产路径上的「两套实现 + 开关分流」是 `abstraction_layer_v1`（默认 OFF，OpenClaw plugin-local legacy vs shared host-runtime），见 `openclaw-plugin/src/index.ts:150-161,497-499,541-549,599-614`；第 4 处 `:607-613` 手动 Owner pain 分支有意保留。
- 第 6 对真双轨：`host-runtime/src/product-telemetry/consent-store.ts:34-36,189-217` 的 v1/v2 持久化格式与在线迁移，v1 文件仍被读取。
- B 类真版本号远多于审计所列：13 个 registry key、`RUNTIME_V2_SCHEMA_VERSION`、`approval-review-v1`、大量 `schemaVersion:'1'`、约 15 个 `.v1/-v2` 契约串、以及 `pd-console` 约 130 处 `/api/v1/` URL。

## 3. R1 / R2：删 legacy 路由的反直觉结论

当前只有即将删除的 plugin-local 路由（`openclaw-plugin/src/hooks/prompt.ts:663-705`）会派生 `roundKey` 走 `fair_rotation_v1`；shared（`host-runtime/src/index.ts:292-302`）是三个宿主共用、不传 `roundKey`，走 `legacy_fifo_prefix_v1`。

因此：
- **shared 现在并不等价于 legacy**，直接删会回退 PRI-904 的公平轮转能力 → 采用 **D1**：先给 `createOpenClawHostRuntime` 加可选 `roundKeyProvider`，只让 OpenClaw（有 `user_turns`）注入 `nextSessionTurnOrdinal`，再删 legacy。不接受行为回退。
- 删后 `legacy_fifo_prefix_v1` **不会失去生产调用者，反而成为唯一生产策略**；失去调用者的是 `fair_rotation_v1`。**本次两条策略分支都不删。**

## 4. Frozen Wire Literals（连写入都不改）

| 字面量 | 性质 |
| --- | --- |
| `runtime_v2_prompt_activations_injected` | 事件类型名，写进 `.pd/.state/logs/events_*.jsonl`，读回侧硬编码比较；TypeBox `Type.Literal` 契约 |
| `source: 'pd-runtime-v2'` | 写入 `sessions.metadata_json` |
| `pd-runtime-v2-diagnosis` | `DIAGNOSTIC_FUNNEL_ID`，用户 `workflows.yaml` 配置 ID，缺失 fail loud |
| `pd.mcp-binding.v1` | 已安装用户 `mcp-binding.json` + 两份 `launcher.cjs` 硬编码比较 |
| `rulecode_context_v2` / `principle_governance_projection_v2` / `governance_experience_v1` | §4 Stable MVP Contract IDs，用户 `.pd/config.yaml` 契约 |
| `model_aware_v2` | 历史事件 `budgetPolicyVersion` 值 |
| `/api/v1/` 旧路径 | 外部集成可能仍在调用，PR-6 后作为 deprecated alias 保留 ≥2 发布周期 |

这些值只清掉周围「看起来像代际」的命名与注释，不改值；已登记在 `packages/principles-core/io-seam-registry.json` 的 `namingPolicy.frozenWireLiterals`，是命名守门豁免的单一权威来源。

## 5. 六个子票与顺序

| 子票 | 内容 | 回滚 |
| --- | --- | --- |
| **PRI-1134** | PR-1 地基：读取 alias 前置、命名守门 warn-only、收敛报告、已知红灯基线 | 单 PR revert（纯新增） |
| **PRI-1135** | PR-2 单一版本写者 + 单一 schema 真理（`REQUIRED_COLUMNS` 收敛） | 单 PR revert |
| **PRI-1136** | PR-3 `runtime-v2` → `runtime` 全量代码侧改名；守门翻 error | 单 PR revert（纯路径） |
| **PRI-1137** | PR-4 D1 补齐 shared 后删 `abstraction_layer_v1` legacy 路由 | 单 PR revert 恢复 flag OFF 双轨 |
| **PRI-1138** | PR-5 `consent-store` 第 6 对双轨收敛（保留单向只读迁移器） | 单 PR revert |
| **PRI-1139** | PR-6 B 类写入侧切换 + 去版本命名（HIGH RISK，8 条前置条件） | 契约组独立 commit，可分组 revert |

**兼容三段式**：PR-1 `expand`（读取 alias / 白名单上线，写入仍旧值）→ PR-2~5 `migrate` → PR-6 `contract`（写入切新值，alias 只增不删）。这是 PR-6 可独立回滚的前提。

## 6. PR-1 实际范围与两处基于证据的调整

**已做**：
1. `output-schema-registry.ts`：新增 `CONTRACT_REF_PAIRS` / `OUTPUT_SCHEMA_REF_ALIASES`，**双向**登记 13 组「中性 ref ↔ 版本 ref」；`resolveOutputSchema` 精确命中优先、未命中走 alias。写入侧 13 个 key 完全不变。该表从 PR-1 建立后不再修改，PR-6 切 key 后旧 ref 自动反向解析，revert 也安全。
2. 新增 `__tests__/output-schema-ref-alias.test.ts`：13 组双向解析、registry 大小不变、退役 `signal-classification-output-v1` 仍不可解析、未知/空 ref 仍 `undefined`。
3. `prompt-injection-budget-observation.ts`：`ACCEPTED_BUDGET_POLICY_VERSIONS` 读取白名单双读（`narrowObservation` 与事件循环两处），当前两个值相同 → 零行为变更；PR-6 切 `model_aware` 后历史 `model_aware_v2` 事件仍被识别。
4. `io-seam-registry.json` 新增 `namingPolicy` 段（冻结字面量 / 豁免路径 / 豁免文件），作为守门唯一豁免来源。
5. 新增 `scripts/check-naming-policy.mjs`：实时扫描 `runtime-v2` import、带 `-vN` 的 `outputSchemaRef`、`/api/v1` 路由字面量；PR-1 **warn-only**（恒定 exit 0），`--strict` 供 PR-3 翻 error，`--json` 供报告取基线。
6. 本文。

**调整 1（假测试已修复，不做无意义改动）**：计划里的 `trajectory-schema.test.ts:67-76` 假测试在当前基线**已经是真测试**——`migrateLegacyGfiSchema converges the real schema_version row (v1 → v2), idempotently` 用真实 SQLite 读 `SELECT version FROM schema_version` 并断言收敛与幂等，即审计报告 T1/T2 要求。T3（裸路径版本断言）属 PR-2 范围。本票只复核记录，不改测试。

**调整 2（`/api/v1` alias 移到 PR-6）**：`pd-console/src/server/index.ts` 的路由是**手写 `urlPath === '/api/v1/...'` 字面量分发**，不是框架 router；且同一 `/api/` 命名空间下已存在 `/api/feedback/...`、`/api/principles/...`、`/api/workspaces/...`、`/api/update/...` 等**不带 v1 段**的真实路由。PR-1 引入路径归一化会误伤这些路由、扩大改动面（违反 P3）。因此 `/api` 双路径兼容随 PR-6 的 76+54 处 URL 切换一起做，采用「新路径 canonical + 旧 `/api/v1` alias 同 handler」，并补 equivalence 契约测试。已同步到 PRI-1139。

## 7. 已知红灯基线（PR-1 记录，逐 PR 对比「失败集合一致」）

- `health-check-model.test.ts` 恒失败（本机噪音）。
- `workspace-lifecycle.test.ts` 5 fail（Windows EBUSY）。
- CI `E2E Regression Test` 自 ≥#1605 连续失败（根因 `packages/pd-cli/src/update/**` 缺 `@types/node` 与 `tuf-js`），非本链路引入。

不得以上述失败为由删测试、禁用测试或削弱守卫（AGENTS.md §25）。

## 8. §19 跨包 consumer 清单（PR-6 前逐项签收）

13 个 registry key 的全部 runner；`pd-console` 76 + 54 处 URL；`principles-core` exports 54 处与 `create-principles-disciple/core/package.json` 镜像 51 处；`@principles/core/runtime-v2` import 约 844 处；`io-seam-registry.json` 19 处路径；`.gitleaksignore` 10 条路径指纹；`scripts/check-pipeline-contract.mjs` 6 处 filters；barrel-surface 基线 JSON；docs 约 300 文件。

## 9. 明确不在本次范围

历史 ADR / 审计文档文件名与内容、各包 `CHANGELOG.md`、测试造数名与 `retired` 守卫列表、两条 prompt 策略分支、三个单功能 flag、`DiagnosticianOutputV1/V2` 与 `EvaluatorOutputV1/V2` 类型名（去后缀会撞名且破坏生产）、`/api/v1` 旧 alias 的删除、他人未跟踪文件、安装器专属目录（`~/.pd/runtime/` 等）。
