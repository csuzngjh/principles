# SPEC-PD-PRR-001 — Gate A 增量审计：最新主分支新鲜度与 RuleContext 读取边界（2026-10-22）

| 项 | 值 |
|---|---|
| 审计日期 | 2026-10-22 |
| 关联 | PRI-1001（PRR/B0）；上游 SPEC-PD-PRR-001 **v1.3**、Gate B 实验方案、准入矩阵 v1.1、Gate A freshness-delta 报告（PRI-1000） |
| 审计基线（HEAD） | `2fb3b04c8fae1fc865f2297ea448dc4c531ff7cf` |
| 对照基线（旧 P-02 PASS 绑定） | `f2539e07ee0f4d2353c5e3897da81b6ef3b787ca`（2026-10-18，PRI-1000） |
| 原始审计基线（Gate A 首轮） | `702d922339851f54579a4f159a91c801af9810b2`（2026-10-17） |
| 工作方式 | 独立 worktree `audit/prr-gate-a-freshness-20261022`，基于 `2fb3b04c8`；只读源码 + 合成夹具 |
| 只读边界 | 未修改任何生产源码/测试断言；未读取真实 `.pd`/`.state`/`~/.pd/runtime`/真实 transcript；未创建生产数据库；未调用任何模型 |
| 最终裁决 | **Gate A 相关结论：A-01 维持；A-03 需按新基线重述证据边界（`PARTIALLY_REVALIDATED`）；P-02 = `NOT_REVALIDATED_AT_CURRENT_MAIN`（增量已审计，夹具重放 `NOT_RUN`）**；Gate B 仍 `BLOCKED`，Gate C 仍 `NOT_GRANTED` |

> 本报告是**增量审计**，不替代、不改写 2026-10-17 原始 Gate A 审计与 2026-10-18 freshness-delta 报告。两份历史文档的结论在其各自基线上继续成立，原文未动。

---

## 1. 审计目的、范围与明确不做

### 1.1 目的

回答三个问题：

1. 从「P-02 PASS 所绑定的基线」到「当前 main」，Gate A 的既有结论是否仍被证据支持？
2. `readWorkspaceRuleContextRowsBefore()`（PRI-1015 / #2077 引入）的**真实调用链、读取范围、失败语义、只读合同**是什么？
3. PRR 能否复用它做 Principle → Pain 历史读取？

### 1.2 范围

- `packages/host-runtime/src/workspace-behavior-evidence.ts`（新增函数 + 同文件只读 Port）
- `packages/host-runtime/src/codex-rule-context-provider.ts`（唯一调用方）
- `packages/host-runtime/src/behavior-history.ts`（行 → 记录的转换）
- `packages/host-runtime/src/production-rulehost-gate.ts`（消费端与 v2 规则门）
- `packages/principles-core/src/runtime-v2/trajectory-schema.ts`（DDL / 列迁移面）
- `packages/principles-core/src/runtime-v2/evidence-sanitizer.ts`（写入侧脱敏）
- 相关测试与 feature flag 默认值

### 1.3 明确不做

- 不连接任何真实 workspace / `.pd` / `.state` / 生产 `state.db` / `trajectory.db`；
- 不读取真实私人历史、transcript、治理数据；
- 不运行 A/C 实验、不调用模型；
- 不修改生产代码、测试断言、门禁；
- 不修改 Owner 决策卡与 D-01～D-05；
- 不修改原始 Gate A 审计报告。

---

## 2. 审计前后的 main SHA

| 时点 | SHA | 说明 |
|---|---|---|
| 任务开始前（上一轮记录） | `a821a6fe469e297285c206a53f5175a6de679aa7` | PR #2111 的历史 base |
| 本轮 `git fetch` 后 | `2fb3b04c8fae1fc865f2297ea448dc4c531ff7cf` | 本报告 HEAD |
| 审计期间是否再次前进 | 提交报告前复核为 `2fb3b04c8`（无变化） | — |

`a821a6fe4 → 2fb3b04c8` 仅 1 个提交（#2110，product version → 2.3.10），改动文件仅 `package.json` + `package-lock.json`。

---

## 3. 旧审计基线与相关提交差异

### 3.1 提交规模

| 区间 | 提交数 | 相关文件实质变更 |
|---|---|---|
| `702d9223 → f2539e07e`（PRI-1000 已审计） | 15 | 已于 freshness-delta 报告 §1–§5 逐项审计 |
| `f2539e07e → 2fb3b04c8`（**本轮新增区间**） | **35** | 见 §3.2 |

> 不以提交数量或提交信息推断影响；下表逐文件核对。

### 3.2 逐文件差异（Gate A 相关面）

| 文件 | 变更 | 是否触及 Gate A 结论 |
|---|---|---|
| `packages/principles-core/src/runtime-v2/activation/ledger-identity.ts` | **零变更** | 否（A-01 身份解析权威原地不动） |
| `packages/principles-core/src/principle-tree-ledger.ts` | **零变更** | 否（A-01/A-03 Ledger availability 不变） |
| `packages/principles-core/src/runtime-v2/pain-chain-read-model.ts` | **零变更** | 否（A-01 双匹配覆写风险原样存在） |
| `packages/host-runtime/src/governance-observation-store.ts` | **零变更** | 否（A-03 写副作用结论原样） |
| `packages/host-runtime/src/workspace-behavior-evidence.ts` | **+45 / −0** | **是**（新增只读历史窗口函数，见 §4） |
| `packages/principles-core/src/runtime-v2/trajectory-schema.ts` | **+9 / −1** | **是（间接）**：`tool_calls` 基础 DDL 增加 `project_dir` 列，并新增 `ALTER TABLE ... ADD COLUMN project_dir`（`:155-161`，PRI-1015）。只作用于**写路径**，但构成"读取函数依赖的列由写路径补齐"的升级顺序约束 |
| `packages/host-runtime/src/production-rulehost-gate.ts` | +52 / −? | 是（消费端新增 v2 上下文缺失时的**逐规则挂起**语义，`:438`；`context` 进入 `hostInput`，`:489`） |
| `packages/host-runtime/src/production-pain-evidence.ts` | 23 行级变更 | 有限（写入 `created_at` 仍为 `new Date().toISOString()`，`:608`；`project_dir` 仍为 `path.resolve(...)`，`:632`） |

`git diff --stat f2539e07e..2fb3b04c8 -- <上表 4 个零变更文件>` 为空输出，即字节同一。

---

## 4. `readWorkspaceRuleContextRowsBefore()` 的真实调用链与数据流

### 4.1 调用链（穷举，非按名称推断）

```
Codex PreToolUse hook
  packages/codex-adapter/src/pd-hook.ts:223   hookEpoch = new Date()          ← 时间截断来源
  :227                                        requestedCwd = event.context.workspaceDir || cwd
  :352-360                                    createCodexRuleContextProvider({ workspaceDir, projectDir: requestedCwd,
                                                enabled: flags.rulecode_context_v2.enabled===true && ingestionEnabled,
                                                cutoffAt: hookEpoch, currentToolUseId: event.context.toolCallId ?? '' })
        ↓
  packages/host-runtime/src/codex-rule-context-provider.ts:54  provider(request)
  :55   enabled=false → unavailable('codex_rule_context_disabled')      ← 短路
  :56   path.resolve(request.workspaceDir) !== workspaceDir → unavailable('workspace_scope_mismatch')
  :57   sessionId 空 → unavailable('session_id_invalid')
  :61-67 toolInput/toolName/params/currentToolUseId 形状不符 → unavailable('codex_pre_tool_scope_mismatch')
  :69-70 cutoff 非法 → unavailable('history_cutoff_invalid')
  :72-81 → readWorkspaceRuleContextRowsBefore(workspaceDir, {…, limit: HISTORY_LIMIT=100 })
        ↓
  packages/host-runtime/src/workspace-behavior-evidence.ts:79-116
        ↓
  packages/host-runtime/src/behavior-history.ts:22-87  assembleBehaviorHistory(rows, truncated, …)
        ↓
  packages/host-runtime/src/codex-rule-context-provider.ts:92-108  facts 计算 + factsIncomplete 降级
        ↓
  packages/host-runtime/src/production-rulehost-gate.ts:182-201  provider 结果校验 / 失败分类 / 门内超时
  :438  v2 规则仅在 context.history.status === 'available' 时执行，否则**逐规则挂起**
  :489   context 进入 hostInput → RuleCode 断言可读 input.context.history.calls[].paramsSummary
```

**调用方穷举结果**：全仓 `git grep readWorkspaceRuleContextRowsBefore` 仅命中 3 处——定义（`workspace-behavior-evidence.ts:79`）、import（`codex-rule-context-provider.ts:10`）、唯一调用（`codex-rule-context-provider.ts:72`）。**没有第二个调用者，也没有非 Codex 宿主使用它。**

### 4.2 数据流与最终去向

| 环节 | 事实 | 标注 |
|---|---|---|
| 读取的列 | `id, tool_name, outcome, params_json`（`:95`） | VERIFIED（源码） |
| 行 → 记录 | `behavior-history.ts:72-79`：`paramsSummary = JSON.parse(params_json)`，**整个 params 对象**进入记录；`normalizedPath` 由 `buildRuleHostAction` 提取 | VERIFIED（源码） |
| 去向 1：规则判定 | `production-rulehost-gate.ts:489` 把整个 `context` 放进 `hostInput`；RuleCode 断言可读 `input.action.paramsSummary` / `input.context.history` | VERIFIED（源码） |
| 去向 2：遥测 | `evaluations` 仅含 `toolName/filePath/matched/decision/ruleId/activationId`（`:618-631`），并经 `redactStringFields` 落 `events_*.jsonl`；**不含 history/params** | VERIFIED（源码） |
| 去向 3：模型提示词 | **未发现** 本链路把 `context.history` 写入 prompt 或 deny reason；拒绝时仅 `result.reason`（规则自填） | NOT_VERIFIED（否定性结论，仅覆盖本仓当前源码的静态搜索） |

### 4.3 读取范围约束（逐条对应审计要求）

| 约束 | 实现 | 证据 |
|---|---|---|
| `sessionId` | 必填、非空白（`:84`）；SQL 精确匹配 `session_id = ?` | VERIFIED（P3/P4 探针） |
| `projectDir` | 必须绝对路径（`:85`）；SQL 精确匹配 `project_dir = ?` | VERIFIED（P3/P4） |
| 时间截断 | `created_at < ?`，上界来自 `hookEpoch`（事件解码后立即取时） | VERIFIED（P4：等于 cutoff 的行被排除） |
| `excludeToolUseId` | 必填非空（`:86`）；`tool_use_id IS NULL OR tool_use_id <> ?` | VERIFIED（P4：即使早于 cutoff 也被排除；P-补：`NULL` 行仍纳入） |
| `limit` | 安全整数、`1..100`（`:87`）；`LIMIT limit+1` 用于判 `truncated` | VERIFIED（P3/P9） |
| 跨 session | 不可（SQL 等值约束） | VERIFIED（P4） |
| 跨 project | 不可**在单个 DB 内**；但函数**不校验 `projectDir` 是否位于 `workspaceDir` 之下**，作用域完全由调用方承担 | VERIFIED（源码；生产调用方已用 `path.resolve` 双向固定） |
| 跨 workspace | 函数接受任意 `workspaceDir` 并拼接 `.state/trajectory.db`，**无内部白名单**；生产唯一调用方已做 `workspace_scope_mismatch` 守卫（provider `:56`） | VERIFIED（源码；守卫在调用方而非函数内） |
| 未来/当前事件 | 排除（`created_at < cutoff` + 排除当前 `tool_use_id`） | VERIFIED（P4） |
| 非当前任务的事件 | 只要同 session、同 project、早于 cutoff 即纳入——**没有"任务边界"概念** | VERIFIED（源码语义；P4 未构造任务边界因为不存在该概念） |

---

## 5. 隐私风险、失败语义与只读合同

### 5.1 `params_json` 的实际内容

**关键区分：读取层不脱敏，脱敏发生在写入层。**

| 层 | 行为 | 证据 |
|---|---|---|
| 写入 | `sanitizeToolParams()`：敏感键（任意 camelCase/下划线分段匹配）整值替换为 `<sensitive___REDACTED___field>`；所有字符串做 token 脱敏；普通值上界 `MAX_EVIDENCE_VALUE_CHARS = 200`；`command`/`args` 走更大的 head+tail 有界预览 | `evidence-sanitizer.ts:26, 164, 387`、`production-pain-evidence.ts:608-632` |
| 读取 | `contextRow()` 仅做**形状校验**（`id` 安全整数、`tool_name`/`outcome`/`params_json` 为 string；`params_json` 必须解析为非数组对象；拒绝 `__proto__`/`constructor`/`prototype` 键），随后**原样返回 `paramsJson` 字符串** | `workspace-behavior-evidence.ts:14-25, 108` |

因此：

- 读取层**没有**二次脱敏，也没有字段白名单；它继承了写入侧的脱敏保证。
- 对 PRR 的含义：`params_json` 仍包含**已脱敏但有信息量**的工具参数——shell 命令文本、文件路径、写入内容的有界片段。这**不是** Pain 结构化摘要，也**不是** Raw 原文，但**远比**"Pain 摘要级证据"丰富。
- 探针 P13 已证明：读取层会原样透传库中 `params_json` 的任何内容（用直接插库构造，绕过了写入侧脱敏）→ **不能假设读取层会自动脱敏**。

### 5.2 失败语义（是否会把"读失败"伪装成"没有历史"）

| 情形 | 实际行为 | 是否静默 | 证据 |
|---|---|---|---|
| DB 文件不存在 | `new Database(..., {fileMustExist: true})` 抛错，**不创建文件、不创建 `.state` 目录** | 否（抛错） | VERIFIED（P1） |
| 表/列缺失（旧 schema） | SQL 抛错；**不迁移、不改字节** | 否（抛错） | VERIFIED（P14） |
| `params_json` 非法 JSON / 非对象 | `contextRow` 抛错 | 否 | VERIFIED（P11） |
| `params_json` 含原型污染键 | 抛 `Unsafe keys in persisted trajectory params` | 否 | VERIFIED（P11） |
| `rows` 非数组 | 抛 `history_query_invalid`（`:106`） | 否 | VERIFIED（源码） |
| 查询成功但 0 行 | 返回 `{rows: [], truncated:false, unscopedPriorRows:false}` | **是（但语义正确）**：0 行是事实，不是错误 | VERIFIED（P4 补充） |
| 存在 `project_dir IS NULL` 的同行/同会话旧行 | 返回 `unscopedPriorRows: true`，且这些行**不返回**；provider 转为 `unavailable('trajectory_project_scope_incomplete')` | 否（显式降级） | VERIFIED（P4） |
| provider 捕获任何异常 | `unavailable('trajectory_history_unavailable:<msg>')`，reason 截断至 240 字符 | 否（显式不可用） | VERIFIED（provider `:109-111`） |
| 门内超时 | `withinGateDeadline` → `provider_failed` → `UNAVAILABLE_RULE_CONTEXT` → v2 规则挂起 | 否（有 warning） | VERIFIED（gate `:182-201`） |

**结论**：本函数**没有**把"存储不可读"折叠成"0 条历史"。它把两者严格区分（抛错 vs 空数组），provider 再把空数组转成具名 `no_prior_session_history`、把异常转成 `trajectory_history_unavailable:*`。v2 规则在两种情况下都被**挂起**而非被喂入空上下文——这是 fail-closed。

### 5.3 只读合同（逐条）

| 断言 | 结果 | 证据 |
|---|---|---|
| `readonly: true` 打开 | 是（`:90`） | VERIFIED（源码） |
| `fileMustExist: true`，不创建库 | 是 | VERIFIED（P1） |
| 不执行 schema 初始化/迁移 | 是；旧 schema 直接抛错且列集合不变 | VERIFIED（P14） |
| 无持久化状态变化 | 打开前后 DB 文件 SHA-256、字节数完全一致 | VERIFIED（P2） |
| 不产生 `-wal` / `-shm` | 是 | VERIFIED（P2） |
| `journal_mode` 不变 | 是 | VERIFIED（P2） |
| 无表结构变化 | `sqlite_master` 表清单前后一致 | VERIFIED（P2） |
| `busy_timeout = 100` 仅为连接级 | 是（`:92`），不写盘 | VERIFIED（源码 + P2） |
| 事务包裹两次查询 | 是（`:93`），保证同一读快照 | VERIFIED（源码） |
| 输入非法时不触达存储 | 是：7 类非法输入全部在 open 之前抛错，且不创建 `.state` | VERIFIED（P3） |

### 5.4 与 Gate A A-03 的关系

原始 A-03 断言"五个只读/副作用证明对象**全部零变更**"。在 `f2539e07e` 上成立。在当前 main：

- `SqliteConnection` / `openTrajectoryDbReadonly` / `listGovernanceObservations` / `governance-observation-store` —— 仍零变更；
- `BehaviorEvidencePort` 所在文件 `workspace-behavior-evidence.ts` —— **新增 45 行**。

新增部分是**另一个函数**，未修改 Port 本体（`:49-71` 未动）。A-03 的**结论**（只读合同成立）经本轮探针**增量再验证**成立；A-03 的**表述**（"该文件零变更"）在当前基线已不成立。

---

## 6. 实际运行的测试、夹具与结果

环境：worktree `D:\Code\_worktrees\principles\PRI-1001-gate-a-audit-20261022`，HEAD `2fb3b04c8`，`npm ci` 后本地构建 `@principles/core` / `install-layout` / `host-runtime`。全部夹具建于 `os.tmpdir()`，零网络、零真实数据。

### 6.1 既有测试（未修改一行）

```text
npx vitest run packages/codex-adapter/tests/codex-rule-context-provider.test.ts \
                packages/codex-adapter/tests/codex-rule-context-live-history.test.ts --root=.
```

| 文件 | 结果 |
|---|---|
| `codex-rule-context-provider.test.ts` | **7 / 7 PASS** |
| `codex-rule-context-live-history.test.ts` | **1 / 1 PASS**（生产 writer 写入 → 下一个 PreToolUse 读出的端到端） |

### 6.2 本轮新增合成探针（`.tmp/`，不入库）

```text
npx vitest run .tmp/pri-1001-audit/rows-probe.test.ts   --root=.   → 17 / 17 PASS
npx vitest run .tmp/pri-1001-audit/legacy-probe.test.ts --root=.   →  1 /  1 PASS
```

| 探针 | 断言 | 结果 |
|---|---|---|
| P1 | 缺库抛错且不创建库/目录 | PASS |
| P2 | 字节/SHA、`journal_mode`、表清单不变；无 `-wal`/`-shm` | PASS |
| P3 | 7 类非法输入在触达存储前被拒（且不创建 `.state`） | PASS ×7 |
| P4 | 跨 session / 跨 project / 当前 `tool_use_id` / `>= cutoff` 全部排除 | PASS |
| P5 | `project_dir IS NULL` → `unscopedPriorRows=true` 且不返回这些行 | PASS |
| P6 | `tool_use_id IS NULL` 的历史行仍纳入 | PASS |
| P7 | 空结果与存储失败可区分（前者空数组，后者抛错） | PASS |
| P9 | `limit` 截断、`truncated` 正确、最旧一行被丢弃 | PASS |
| P10 | 返回顺序为 oldest→newest | PASS |
| P11 | 非法 JSON / 原型污染键 → 抛错 | PASS ×2 |
| P13 | 读取层原样透传 `params_json`（证明读取不平滑脱敏） | PASS |
| P14 | 旧 schema（无 `project_dir`/`tool_use_id`）→ 抛错、零迁移、零字节变化 | PASS |

**合计 26 / 26 PASS，0 失败，0 跳过。**

### 6.3 导出面实测

```text
import('@principles/host-runtime')                              → OK，但 readWorkspaceRuleContextRowsBefore === undefined
import('@principles/host-runtime/workspace-behavior-evidence')  → ERR_PACKAGE_PATH_NOT_EXPORTED
```

依据：`packages/host-runtime/src/index.ts:381` 只导出 `createWorkspaceBehaviorEvidencePort`；`packages/host-runtime/package.json` 的 `exports` 仅有 `.` / `./package.json` / `./behavior-example-pack-assembler` / `./behavior-history`。

---

## 7. 原 Gate A 结论的逐项影响

| 结论 | 当前状态 | 依据 |
|---|---|---|
| **A-01** Data Map（身份解析 / Ledger / 反向链） | **VERIFIED 维持** | 3 个权威文件字节同一；双匹配 `Map.set` 风险未变（`pain-chain-read-model.ts:68` 仍为模块私有函数） |
| **A-02** Evidence Coverage | **VERIFIED 维持（限静态）** | 覆盖矩阵本体未变；真实分母仍 `NOT_MEASURED`（本轮零真实样本） |
| **A-03** Read-only Proof Plan | **PARTIALLY_REVALIDATED** | 只读合同经 P1/P2/P14 增量再验证成立；但"五个对象全部零变更"的表述在当前基线不再成立（`workspace-behavior-evidence.ts` +45、`trajectory-schema.ts` +9/−1） |
| **A-04** Disclosure Matrix | **VERIFIED 维持** | 本轮未发现新的 Agent read-back 通道；新函数读的是已入库 `tool_calls`，不读 transcript，不扩权 |
| **A-05** Pilot 宿主建议 | **NOT_APPLICABLE（本轮不重判）** | 宿主选择属 Owner（D-05），审计不代替 |
| **A-06** Gate B 实验骨架 | **VERIFIED 维持** | B0 预注册（PR #2111）已另行交付 |
| **A-07** Uncertainties | **U1 分母注记扩充** | 新增未决项见 §9（U9：升级顺序；U10：路径大小写） |

### 7.1 一项需要注意的耦合事实（新增，非缺陷）

`codex-rule-context-provider` 的启用条件是**两个 flag 同时为真**（`pd-hook.ts:355`）：

| flag | 默认值 | 证据 |
|---|---|---|
| `rulecode_context_v2` | **enabled: true**（自 2026-09-13） | `feature-flag-contract.ts:292` |
| `codex_conversation_ingestion` | **enabled: false** | `feature-flag-contract.ts:405` |

含义：默认状态下 Codex 上该读取路径**休眠**（provider `enabled=false` → `codex_rule_context_disabled`）。但**只开启 transcript ingestion 一个 flag**，就会同时激活这条有界 trajectory 历史读取（因为 v2 flag 默认已开）。这是 flag 语义耦合，不是权限越界（读的是已入库行），但 Owner 在开启 ingestion 时应被明确告知这一连带效果。

---

## 8. P-02 建议状态与依据

### 8.1 逐项回答

| 问题 | 答案 |
|---|---|
| 原 P-02 PASS 对应哪个精确 SHA？ | `f2539e07ee0f4d2353c5e3897da81b6ef3b787ca`（2026-10-18，PRI-1000 复验） |
| 从该 SHA 到最新 main，哪些权威文件变化？ | A-01 的 3 个权威文件：**零变更**。A-03 相关：`workspace-behavior-evidence.ts` +45、`trajectory-schema.ts` +9/−1。5 份 PRR 上游文档：**零变更**（blob 同一） |
| 新增读取函数是否改变原审计覆盖范围？ | **是**：A-03 的"零变更"表述失效；只读合同的**结论**仍成立，但证据面新增了一个读取入口与一个列迁移 |
| 哪些旧结论可由字节一致/测试重放/调用链证据继续支持？ | A-01（字节一致）、A-03 只读合同（本轮 P1/P2/P14 实测）、A-04（调用链证据：无 transcript、无 read-back） |
| 哪些结论需要增量复验？ | A-03 的**表述范围**；以及"30/30 夹具在新基线重放"——**无法复验**，因为夹具未入库 |
| 是否足以更新 P-02 为 PASS？ | **否**。理由见 §8.2 |

### 8.2 为什么不能翻成 PASS

要把 P-02 判为对当前 main 有效，至少需要**同等强度的证据**：3 个核心文件字节同一（有）+ **30/30 夹具在新基线逐项重放**（无）。

后者缺失的原因是**证据不可复现**：`git ls-files` 在仓库内找不到任何 `fixture-ledger` / `fixture-sqlite` / Gate A 夹具；它们只存在于上一轮的 `.tmp/`（gitignored，未入库）。任何人都无法在新基线上重放这 30 项断言。

因此诚实结论：

> **P-02 = `NOT_REVALIDATED_AT_CURRENT_MAIN`**
> 分项：`A-01 字节同一` = VERIFIED；`A-03 只读合同` = VERIFIED（本轮实测）；`30/30 夹具重放` = **NOT_RUN（夹具未入库，不可复现）**。

### 8.3 对 Gate B 准入的影响

准入矩阵第 ⑤ 条要求"授权 workspace 内的只读读取已通过准入矩阵全部条目"。P-02 未被完整复验，因此**第 ⑤ 条在当前 main 上不成立**。这与 D-01～D-05 全 `PENDING`、P-06～P-10 `PENDING`、P-12 未完成叠加，Gate B 保持 `BLOCKED` 的结论**不变，且不需要新的阻断理由**。

### 8.4 最小下一步（供 Owner 选择，不代替裁决）

1. **低成本路线**：把 Gate A 的 30 项夹具**入库**（作为研究夹具目录），使重放可复现；然后在新基线跑一次即可把 P-02 复原为 PASS。这需要一次代码/夹具 PR（本报告不实施）。
2. **零代码路线**：Owner 接受本增量审计的**降级证据**（字节同一 + 只读合同实测 + 调用链审计）作为 P-02 对当前 main 的替代证据，并在矩阵中显式记录该接受行为及其证据等级。
3. **保守路线**：维持 P-02 在 `f2539e07e` 的 PASS 不动，Gate B 准入 ⑤ 视为未满足，直到路线 1 或 2 落地。

---

## 9. 未覆盖的测试、未知事实与风险

| ID | 结论状态 | 内容 |
|---|---|---|
| U9 | **NOT_VERIFIED** | **升级顺序**：读取函数依赖 `project_dir`/`tool_use_id` 列，这两列由**写路径**（`applyTrajectorySchemaBase`，`trajectory-schema.ts:155-161`）补齐。已证实旧 schema 下读取**抛错且不迁移**（P14）；未证实"升级后首个工具调用是否必然先触发写路径建列"，以及该窗口内 v2 规则挂起的实际时长 |
| U10 | **NOT_VERIFIED** | **路径大小写/等值**：`project_dir` 为 TEXT 精确匹配；Windows 上 `path.resolve` 不归一化大小写。若写入与读取的 cwd 字串大小写不同，读取会得 0 行并报 `no_prior_session_history`（误导性 reason）。静态可推理，但无真实宿主证据 → 不作结论 |
| U11 | **NOT_VERIFIED** | **`project_dir` 非 NULL 但等价不同字串**（如尾部分隔符差异）的行会被**静默排除**，`unscopedPriorRows` 只检测 `IS NULL`，对此不报警 |
| U12 | **NOT_VERIFIED** | **并发/锁**：`busy_timeout=100ms` 下遇写事务竞争的退避行为未测（需并发夹具，超出本次只读审计范围） |
| U13 | **NOT_APPLICABLE** | 本函数对 **OpenClaw / WorkBuddy** 的适用性：无调用方，不适用 |
| U14 | **BLOCKED** | **真实分母**：`AUTHORIZED_REAL_SAMPLE` 仍为 0；真实 workspace 的 `project_dir` 填充率、历史行可读率全部 `NOT_MEASURED` |
| R-A | 风险（P2） | 每次 PreToolUse 都 open/close 一次 SQLite 并做两次查询；`(session_id, project_dir, created_at)` 无复合索引（仅 `session_id`、`created_at` 单列索引）。DB 很大时延可能逼近门内 deadline → v2 规则成片挂起 |
| R-B | 风险（P2） | provider 把"作用域不完整"与"确实没有历史"分别映射为 `trajectory_project_scope_incomplete` 与 `no_prior_session_history`，但两者都表现为 v2 规则挂起；Operator 需要区分时只能读 warning 文本 |
| R-C | 风险（P3） | 被测函数未导出、未在 `exports` 映射中；若未来要复用，必须改 `package.json` exports 或 barrel —— 属生产代码变更，需独立评审 |

---

## 10. 对 PRR 是否可以复用该函数的明确建议

### 10.1 结论

> **不建议复用。建议 PRR 不引入该函数，也不把它作为 Recall 的读取入口。**

### 10.2 理由（逐条有证据）

| # | 理由 | 证据 |
|---|---|---|
| 1 | **语义不匹配**：它读 `tool_calls`（已脱敏的工具参数），不是 canonical Pain 摘要/诊断摘要。PRR 需要的是 Principle → candidate → Pain 的血缘证据，此函数完全不涉及 `pain_events`、`derivedFromPainIds`、`reuseEvidence` | `:95` 查询列；SPEC v1.3 §1.3/§5.1；Gate A A-01 |
| 2 | **不可导入**：不在 barrel，且不在 `exports` 映射 → `ERR_PACKAGE_PATH_NOT_EXPORTED`。复用即需要生产代码变更 | §6.3 实测 |
| 3 | **无内部授权**：函数只校验 `projectDir` 是绝对路径，不校验其是否位于 `workspaceDir` 之下，也不做 workspace 白名单。作用域安全完全依赖调用方 | `:85`；provider `:56` |
| 4 | **读取层不脱敏**：它原样透传库里 `params_json`。若 PRR 复用它并把结果外发，会把"写入侧脱敏"当成"读取侧脱敏"来依赖，属于把信任边界放错层 | P13；§5.1 |
| 5 | **会话窗口 ≠ 历史血缘**：它的窗口是"同一 session + 同一 project + 早于 hook 时刻 + 最多 100 条"。PRR 需要跨会话的长期历史，语义不同；放宽窗口就是改语义而不是复用 | `:94-100` |
| 6 | **权威冲突风险（P4）**：PRR SPEC §5.1/§1.6 已冻结"身份与 Pain 读取必须复用既有权威（`resolveLedgerActivationId` + `readLedgerFileState` + `PainChainReadModel` 类读取层）"。引入第二个 trajectory 读取面会制造第二套读取权威 | v1.3 §1.6、§5.1 |

### 10.3 可以借用的是**模式**，不是代码

| 可借用模式 | 出处 | 说明 |
|---|---|---|
| 上界时间截断（`created_at < cutoff`） | `:97` | 与 PRR 的 Evidence-First / 不可回填未来信息一致 |
| 显式 `truncated` 标志 + 事实降级为 `unknown` | provider `:92-103` | 与 PRR "不得把局部当全量"一致 |
| 作用域不完整 → 显式 `unavailable` 而非部分返回 | provider `:82` | 与 PRR fail-closed 一致 |
| 读取失败与真零严格区分 | `:106-111`；P1/P7/P14 | 与 PRR `NOT_MEASURED` / `TRUE_ZERO` / `UNAVAILABLE` 三态纪律一致 |
| 原子读快照（`db.transaction` 包两次查询） | `:93` | 可用于 PRR 的 LIST+DETAIL 一致性 |

**一句话**：借鉴它的**失败语义与窗口纪律**，复用它的**既有权威**（Pain 血缘读取层），不要复用它的**数据面**。

---

## 11. Gate B、Gate C 仍需满足的独立条件

| 项 | 状态 | 说明 |
|---|---|---|
| Gate B 执行 | **BLOCKED** | 准入矩阵 P-06～P-10 `PENDING`（D-01～D-05 全待 Owner 裁决）、P-12 未完成；P-02 在当前 main 为 `NOT_REVALIDATED` → 第 ⑤ 条不成立 |
| B0 预注册 | **DRAFT（PR #2111）** | 待 Owner 审阅；`FZ-01–FZ-15` 全部 `OWNER_DECISION_REQUIRED` |
| Gate C | **NOT_GRANTED** | 需 Gate B `CONDITIONAL GO` **且** PRI-1003 独立 Owner 授权票；Gate B 结果不传导 |
| 真实 A/C 实验 | **NOT_RUN** | 本轮零真实数据、零模型调用 |
| 本审计对上述三者的影响 | **零** | 本报告不改变任何授权状态；仅降低/明确了一项 Gate A 证据等级 |

---

## 附 A：本轮探针源码（`rows-probe.test.ts`，未入库）

> 路径 `.tmp/pri-1001-audit/rows-probe.test.ts`（gitignored）。为可复现，全文如下。

```ts
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readWorkspaceRuleContextRowsBefore } from '../../packages/host-runtime/src/workspace-behavior-evidence.js';

const roots: string[] = [];
const CUTOFF = '2026-10-18T12:00:00.000Z';
const PROJECT = path.resolve(os.tmpdir(), 'pd-audit-project');
const OTHER_PROJECT = path.resolve(os.tmpdir(), 'pd-audit-other-project');

function makeWorkspace() { /* mkdtemp + CREATE TABLE tool_calls(...) */ }
function insert(db, input) { /* INSERT 一行 tool_calls */ }
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// P1  缺库：抛错，且不创建 .state / trajectory.db
// P2  只读：SHA/字节数/journal_mode/sqlite_master 不变，无 -wal/-shm
// P3  7 类非法输入在 open 之前被拒（且不创建 .state）
// P4  排除其他 session / 其他 project / 当前 tool_use_id / created_at >= cutoff
// P5  project_dir IS NULL → unscopedPriorRows=true 且不返回该行
// P6  tool_use_id IS NULL 的旧行仍纳入
// P7  空结果（空数组）与存储失败（抛错）可区分
// P9  limit=100 截断、truncated=true、最旧一行被丢弃
// P10 返回顺序 oldest → newest
// P11 非法 JSON / __proto__ 等键 → 抛错
// P13 params_json 原样透传（读取层不做脱敏）
```

（完整实现见工作树 `.tmp/pri-1001-audit/rows-probe.test.ts`；关键断言在 §6.2 表中逐条列明。）

## 附 B：复现命令

```bash
git worktree add -b audit/prr-gate-a-freshness-20261022 \
  D:/Code/_worktrees/principles/PRI-1001-gate-a-audit-20261022 2fb3b04c8fae1fc865f2297ea448dc4c531ff7cf
cd D:/Code/_worktrees/principles/PRI-1001-gate-a-audit-20261022
npm ci
npm run build --workspace=@principles/core
npm run build --workspace=@principles/install-layout
npm run build --workspace=@principles/host-runtime
npx vitest run packages/codex-adapter/tests/codex-rule-context-provider.test.ts \
                packages/codex-adapter/tests/codex-rule-context-live-history.test.ts --root=.
npx vitest run .tmp/pri-1001-audit/rows-probe.test.ts --root=.
npx vitest run .tmp/pri-1001-audit/legacy-probe.test.ts --root=.
```

## 附 C：证据索引

- 原始 Gate A 审计（未改动）：`docs/implementation-reports/SPEC-PD-PRR-001-v1.2-gate-a-reality-audit-20261017.md`
- Gate A freshness-delta（未改动）：`docs/implementation-reports/SPEC-PD-PRR-001-gate-a-main-freshness-delta-20261018.md`
- 准入矩阵：`docs/specs/SPEC-PD-PRR-001-Gate-A-to-B-admission-matrix-20261017.md`
- B0 预注册：`docs/specs/SPEC-PD-PRR-001-Gate-B0-AC-preregistration-20261022.md`（PR #2111）

**SPEC-PD-PRR-001 Gate A 增量审计 2026-10-22 END**

---

## 附 D：后续更新（2026-10-22 深夜，PR #2113 之后）

本报告是**时点审计产物**，其上文结论在出具时（`2fb3b04c8`，夹具未入库）成立，未因下述事件改写。

| 事件 | 内容 |
|---|---|
| 原始夹具已恢复 | 2026-10-17 Gate A 的两套夹具（13 + 17 = 30 项断言）在 PRI-1000 历史 worktree 的 gitignored `.tmp/` 中被找到，**逐字节原样**入库至 `packages/principles-core/tests/fixtures/gate-a-reproducibility/`（PR #2113） |
| 30/30 实跑通过 | 在 `origin/main` @ `2fb3b04c8` 上：`fixture-ledger` 13/13 PASS、`fixture-sqlite` 17/17 PASS，合计 **30/30，0 失败** |
| 定向回归 | 同基线 3 个定向测试文件 **43/43 用例 PASS，0 失败**（口径为 vitest 用例数，非原报告的"断言条数"，见矩阵 §3.1 披露） |
| P-02 状态变化 | §8 建议的 `NOT_REVALIDATED_AT_CURRENT_MAIN` 已由准入矩阵 **v1.4** 更新为 `PASS`（适用基线 `2fb3b04c8`） |
| Gate B | **仍为 `BLOCKED`**（P-06～P-10 `PENDING`、P-12 未做）——P-02 恢复 PASS 不解除任何 Owner 决策项 |

§8.4 的"路线 1（夹具入库）"已由 PR #2113 完成；§9 的未覆盖项（U9～U14、R-A～R-C）**不变**，其中"30/30 夹具重放 NOT_RUN"一项已转为"已复跑通过"，其余仍开放。
