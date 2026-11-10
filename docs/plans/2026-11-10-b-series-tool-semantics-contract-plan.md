# B 系列拆分方案：工具语义与执行结果契约单一化

> 状态：**方案，待 Owner 评审**。本轮未改任何生产代码。
> 基线：`origin/main` @ `fee93e1b0`（2026-11-10 拉取）。
> 关联：评审报告 §4.2（B1–B5）、PR #2498（5B）、AGENTS.md P2.1 / P7 / P8。

---

## 0. 结论先说

1. **基线需要修正**。评审报告把 B2/B3/B4 描述为"完全未启动、语义散落四处"，但 `origin/main` 已经有 PRI-634-F R2 落地的共享工具语义层：
   - `buildToolSemanticRegistry` + 三宿主声明（OpenClaw / Codex / WorkBuddy）；
   - `resolveWorkspaceHostToolSemantics` 合并 workspace 声明；
   - `buildRuleHostAction` 作为路径提取与归一化的唯一实现；
   - OpenClaw hook 已把结果交给 host-runtime 的 production gate（`handleSharedRuleHostResult`）。
   所以 **B2 不是"抽出注册表"，B4 不是"接入共享门"**；这两项的剩余工作是"覆盖缺口 + 残留旁路"，工作量远小于报告描述。
2. **B1 的原设计会制造新的双真相**。计划要求给 `RuleHostResult` 增加 `verdict / reasons / evidence / degraded`，但契约里已有 `decision / matched / reason / diagnostics`：`verdict≈decision`、`reasons≈reason`、`evidence≈diagnostics`。这正好是 B 系列要消灭的"同一件事多套逻辑"。**需要 Owner 在 §2 的两个方案里裁定**。
3. **真正可证明的缺陷在"同一非法结果、不同消费者不同处置"**：OpenClaw legacy 路径 `throw`，host-runtime 生产门 `warning + continue`（该规则静默不参与 → 可能放行）。这条不需要新增字段就能给出反例，建议作为 B1 的主线。
4. 与 5B（PR #2498）只有两处文件级接触：`packages/host-runtime/src/index.ts` 与 `packages/pd-console/src/server/models/ActivationsConsoleModel.ts`。**建议 5B 先合，B 系列在其后开工**；若必须先开工，B1/B2 可避开这两个文件（见 §7）。

---

## 1. 已验证事实（`origin/main`）

| 事实 | 位置 |
| --- | --- |
| `resolveToolSemantics` 在代码中 0 命中（用户基线成立） | 全仓 grep |
| 工具语义注册表**已存在** | `packages/principles-core/src/runtime/.../tool-semantic-registry.ts` |
| 三宿主声明已存在 | `codex-adapter/src/tool-semantics.ts:24-34`、`openclaw-plugin/src/constants/tools.ts`、`workbuddy-adapter/src/tool-semantics.ts` |
| workspace 声明合并已存在 | `host-runtime/src/host-tool-semantic-resolver.ts:50`、`host-tool-declaration.ts:140-180` |
| 路径提取/归一化唯一实现 | `principles-core/src/runtime/internalization/rule-host-input-builder.ts:316-340` |
| `apply_patch` 路径解析只有一份 | `host-runtime/src/codex-rule-context-provider.ts:27-47`（`patchTargets` 全仓唯一） |
| OpenClaw hook 已用注册表 | `openclaw-plugin/src/hooks/gate.ts:97-101`（`OPENCLAW_TOOL_SEMANTICS.resolve`） |
| OpenClaw 已接共享生产门 | `openclaw-plugin/src/index.ts:504` → `hooks/gate.ts:634` `handleSharedRuleHostResult` |
| `RuleHostResult` 当前字段 | `principles-core/src/runtime/internalization/rule-host-contracts.ts:65-90` |
| 无效结果处置**不一致** | OpenClaw：`openclaw-plugin/src/core/rule-host.ts:822-826` `throw`；host-runtime：`production-rulehost-gate.ts:706-709` `warning + continue` |
| 校验器强制 `matched=false → decision='allow'` | `principles-core/src/runtime/internalization/rule-host-validator.ts:88-124` |
| legacy 双路径仍在 | `openclaw-plugin/src/core/rule-host.ts`（842 行）与 host-runtime 生产门并存 |

> 待实施前验证（本方案不当作事实）：
> - `withDerivedHints` 在 `isBashTool` 与 `canonicalKind` 冲突时的优先级；
> - `production-rulehost-gate.ts` 跳过 invalid live result 后，最终 decision 是否真的可能落到 `allow`（需要一条完整多规则路径）；
> - `core/rule-host.ts` 是否仍有生产调用方（还是只剩测试）。

---

## 2. B1：执行结果契约（需要 Owner 裁定）

### 2.1 问题陈述（不变）

同一个 `RuleHostResult`，在不同消费者的"非法/缺字段"处置不同：

| 消费者 | 非法结果处置 | 后果 |
| --- | --- | --- |
| OpenClaw legacy `core/rule-host.ts:822` | `throw` | 该次工具调用报错/中断 |
| CLI demo 编译 `demo-rule-compiler.ts:26-39` | `throw` | 流水线失败 |
| host-runtime `production-rulehost-gate.ts:706` | `warning + continue` | 该规则不参与合并，可能被其它 allow 覆盖 → **静默放行** |

这不是"字段不够"，而是"同一事实（这条规则的结果不可用）没有单一语义"。

### 2.2 两个方案

**方案 A（按报告原设计）**：新增 `verdict / reasons / evidence / degraded`。

- 代价：与既有四个字段同义并存；所有构造型测试夹具、`validateRuleHostResult`、三宿主消费者都要同时理解两套词汇；违反 P4（一个事实一个权威）与 P7（真实变化轴为零）。
- 结论：**不推荐**。

**方案 B（推荐，最小）**：不新增同义字段，只补"不可用"这一个缺失语义。

1. `RuleHostResult` 增加**可选** `degraded?: { reasonCode: string; notes?: string }`。
2. 新增 core 纯函数 `normalizeRuleHostResult(raw): NormalizedRuleHostResult`，唯一负责：
   - 校验失败 → `degraded.reasonCode = 'invalid_result'`，`decision` 取 **fail-closed**（`requireApproval`），不再 `continue`；
   - `matched=false` → `decision='allow'`（保留既有语义，但只在归一化函数里写一次）；
   - 合法 → 原样透传。
3. 三个消费者改为调用同一归一化函数；`production-rulehost-gate.ts` 的 `warning + continue` 改为记 `degraded` 并参与合并（fail-closed）。
4. `diagnostics` 暂不动；只有当某个消费者确实需要结构化证据时，再单独讨论（避免一次性大改）。

### 2.3 每批交付字段

| 项 | 内容 |
| --- | --- |
| 改动文件 | `rule-host-contracts.ts`、`rule-host-validator.ts`、新增 `rule-host-result-normalizer.ts`、`production-rulehost-gate.ts`、`openclaw-plugin/src/core/rule-host.ts`、`pd-cli/src/services/demo-rule-compiler.ts`（或其所调用的共享校验点） |
| 唯一权威 | `normalizeRuleHostResult`（core）；`decision` 仍是唯一判决字段 |
| 旧路径退场 | `production-rulehost-gate.ts` 的 `warning + continue` 分支删除；各消费者不再自行解释校验失败 |
| 必须同步 | 三宿主结果消费点、`rule-host-validator` 测试、golden trace replay 断言 |
| 回滚 | 单提交 revert；`degraded` 可选，旧夹具不受影响 |
| 反例证明 | 见 §2.4 |

### 2.4 反例证明设计（PoV）

**缺陷输入**：规则工件返回 `{ decision: 'block' }`，缺 `matched`（LLM 生成工件的真实故障模式；`artificer` 输出未经严格 schema 时可能出现）。

- **旧实现**：
  - OpenClaw legacy → throw（用户看到工具报错）；
  - host-runtime 生产门 → `warning` + 跳过该规则；若同批无其它 block，最终 `allow`（工具被执行）。
  - 证明：同一输入在两宿主产生相反结果。
- **新实现**：两者都得到 `decision='requireApproval'` 且 `degraded.reasonCode='invalid_result'`。
- **真实路径**：`production-rulehost-gate` 是 Codex/WorkBuddy/CLI 的共享门；OpenClaw hook 也走 `handleSharedRuleHostResult`。缺陷输入来自真实工件编译，不是测试拼装。
- **验证方式**：同一夹具分别跑 `evaluateProductionRuleHostGate` 与 `RuleHost.evaluate` 的公开入口，断言两者最终 decision 相等；再用真实 `artificer` 产物缺字段副本跑一次。

---

## 3. B2：工具语义（已存在，只补缺口）

### 3.1 现状修正

注册表、三宿主声明、workspace 合并、唯一路径提取都已存在。报告所述"9 个文件各自解析"已不成立。

### 3.2 剩余工作（小）

1. **声明覆盖守卫**：`Codex` 只声明 `Bash` 与 `apply_patch`（PRI-657 已跟踪缺口）。不扩名单（无证据的名字比缺名字更危险），只加一条结构守卫：任何消费者引用未声明工具名时必须 fail loud，而不是 `undefined` 后静默放行。
2. **`isBashTool` / `isWriteTool` 与 `canonicalKind` 的一致性**：`gate.ts:97-101` 同时传两套判断。若二者冲突，`buildRuleHostAction` 的 hint 派生会取哪一个，需要先验证（§1 待验证项）。冲突时以 `canonicalKind` 为唯一权威，Set 只用于"是否进入 gate"这一粗筛。
3. **`OPENCLAW_TOOL_SEMANTICS` 与 `constants/tools.ts` 同源确认**：若 registry 确实由同一常量派生，则不存在双真相，**不删除任何 Set**（删除会扩大改动面且无行为收益）。

### 3.3 反例证明设计

**缺陷输入**：workspace 声明 `exec` 的 `canonicalKind='write'`，而 `BASH_TOOLS_SET` 仍把 `exec` 视为 bash。

- **旧实现**：`buildRuleHostAction` 同时收到 `isBashTool=true` 与 `canonicalKind='write'`，若 hint 取 Set，则路径/风险判定按 bash 走，与 replay（只读 registry）不一致。
- **新实现**：冲突时 `canonicalKind` 胜出，实时与 replay 得到同一 `normalizedPath` 与 hints。
- **真实路径**：workspace 声明文件 `.pd/host-tool-semantics/<hostKind>.json` 是用户可写输入；配置错误是真实故障模式。
- **先验证**：若 `withDerivedHints` 本来就让 `canonicalKind` 胜出，则本批不成立，**该批直接取消**并把结论写回报告（避免为不存在的缺陷写代码）。

---

## 4. B3：宿主 → 语义声明的唯一入口

### 4.1 现状

`resolveWorkspaceHostToolSemantics` 已存在，但**hook 实时路径不读 workspace 声明**，只有 replay / evidence / Console 读。这构成"实时 vs 回放"的潜在分歧。

### 4.2 方案

1. 在 host-runtime 暴露一个 `resolveHostToolSemanticsForHook(hostKind, workspaceDir)`：优先 workspace 声明，其次宿主静态声明，最后 baseline；解析失败 fail loud（不返回空 registry）。
2. OpenClaw hook 从 `OPENCLAW_TOOL_SEMANTICS` 改为调用该入口（注入 workspaceDir）；Codex/WorkBuddy 的 hook 侧同样接入。
3. 旧路径退场：`gate.ts` 不再直接 import `OPENCLAW_TOOL_SEMANTICS`（声明仍保留，作为 fallback 数据源）。

### 4.3 反例证明设计

**缺陷输入**：workspace 声明把 `exec` 标成 `execute`，宿主静态声明缺失 `exec`。

- **旧实现**：hook 用静态声明 → `canonicalKind=undefined` → 路径提取走 bash 分支；Console/replay 用 workspace 声明 → `execute`。同一事件两边分类不同。
- **新实现**：hook 与 replay 都得到 `execute`。
- **真实路径**：`.pd/host-tool-semantics/*.json` 是真实用户可写文件；Console 与 hook 同时在生产使用。
- **验证**：同一 workspace 下分别调用 hook 入口与 `resolveWorkspaceHostToolSemantics`，断言 canonicalKind 相同。

### 4.4 回滚

单提交 revert；`resolveHostToolSemanticsForHook` 保留为新增可选入口，hook 回退到静态声明即可。

---

## 5. B4：legacy 双路径退场

### 5.1 现状

`openclaw-plugin/src/core/rule-host.ts`（842 行）仍在，且与 host-runtime production gate 并行。OpenClaw 主 hook 已走共享门（`index.ts:504`），但 legacy 类仍有调用面（需在实施前用调用图确认，不能凭报告断言）。

### 5.2 方案

1. 先做**调用方盘点**（只读）：`new RuleHost` / `getRuleHost` 的所有生产调用点。
2. 若只剩测试与 dead 分支：删除 legacy 执行器，或在文件头加 `@deprecated` + 结构守卫禁止新引用（二选一，由盘点结果决定）。
3. 若仍有生产调用：**不做删除**，改为"legacy 只允许在 X 条件下使用"的显式契约，并把 X 写进注释与测试；删除推迟到后续批次。

### 5.3 反例证明设计

**缺陷输入**：同一规则、同一 `RuleHostInput`（`matched=true, decision='block'`）分别走 legacy 与共享门。

- **旧实现**：若两者对 `matched`/`diagnostics` 的解释不同，会出现一个阻断、一个放行。
- **新实现**：两条路径调用同一 `normalizeRuleHostResult` + 同一 `mergeDecisions`，结果相等。
- **真实路径**：OpenClaw 升级期两套并存，是真实过渡态。
- 若盘点发现 legacy 无生产调用，则本批退化为"删除 + 结构守卫"，反例改为"删除后编译期引用失败"。

---

## 6. B5：防回潮守卫

### 6.1 内容

1. 结构守卫：`packages/*/src` 中禁止新增 `toolName === '<literal>'` / 手写工具名 Set（允许白名单：三宿主声明文件、`constants/tools.ts`、测试）。
2. 契约守卫：`RuleHostResult` 构造点必须经过 `normalizeRuleHostResult`（允许 core 内部与测试）。
3. 文档：把"工具语义唯一权威 = 声明文件 + registry"写进 `CONTEXT-MAP.md` 对应包的 `CONTEXT.md`。

### 6.2 反例证明设计

**缺陷输入**：在一个新消费者里写 `if (toolName === 'apply_patch')`。

- **旧实现**：CI 通过。
- **新实现**：`npm run check:*` 失败并指向声明文件。
- **真实路径**：这是本次 B 系列要防的复发模式（历史事故 #5 就是两份 `apply_patch` 解析）。

### 6.3 回滚

删除守卫脚本与 package.json 一行；不影响运行时。

---

## 7. 与 5B（PR #2498）的重叠与顺序

| 文件 | 5B 的改动 | B 系列可能改动 | 冲突判断 |
| --- | --- | --- | --- |
| `packages/host-runtime/src/index.ts` | 新增 `export * from './rulecode-event-collection.js'` | B3 可能新增 hook 语义入口导出 | **同文件不同行，但同属导出面** → 5B 先合 |
| `packages/pd-console/src/server/models/ActivationsConsoleModel.ts` | 删除 collector 副本、改 import | B3/Console 可能改 toolSemantics 调用 | **同文件** → 5B 先合 |
| `packages/principles-core/src/runtime/index.ts` | 5B 未动（守卫冻结） | B1/B2 若新增公共导出需评估守卫 | B 系列优先走包内 barrel，避免动公共桶 |
| `pd-cli/src/commands/runtime-activation.ts` | criteria 输出 | B1 可能改 demo-rule-compiler（不同文件） | 无冲突 |
| `packages/host-runtime/src/rulecode-event-collection.ts` | 新建 | 无 | 无冲突 |

**顺序建议**：

1. 5B（#2498）先合。
2. B1 →（若 §3.2 验证成立）B2 → B3 → B4 → B5。
3. 若 5B 因评审延后，B1 可立即开工（不碰 `host-runtime/src/index.ts` 与 `ActivationsConsoleModel.ts`）；B3 必须等 5B 合入后再动这两个文件。

---

## 8. 需要 Owner 裁定的三件事

1. **B1 采用方案 A 还是方案 B**？我推荐 B（不新增 `verdict/reasons/evidence`，只补 `degraded` 并统一 fail-closed）。理由是方案 A 会制造与 `decision/reason/diagnostics` 同义的第二套词汇。
2. **B4 是否允许删除 legacy `core/rule-host.ts`**？需要先做调用方盘点；若仍有生产调用，本批只做显式契约，不删除。
3. **B2 是否允许"验证后取消"**？如果 `withDerivedHints` 已让 `canonicalKind` 胜出，我建议直接取消该批，不为了计划完整性写代码。

---

## 9. 本轮 NOT RUN

- 未改任何生产代码、未建业务分支之外的提交。
- 未跑测试（方案阶段无代码改动）。
- 未验证 §1 的三条"待实施前验证"假设（`withDerivedHints` 优先级、invalid→allow 完整路径、legacy 调用图）。
- 未创建 PR（等方案评审通过后，与实施一起提交）。

---

## 10. 批次交付模板（实施时每批照此报告）

```text
批次：B<n>
改动文件：
唯一权威：
旧路径退场：
必须同步的调用方：
反例证明（旧实现输出 / 新实现输出 / 真实路径说明）：
测试命令与退出码：
NOT RUN：
回滚：
```
