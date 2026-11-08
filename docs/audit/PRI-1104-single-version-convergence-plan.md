# PRI-1104 单版本收敛：事实基线与分阶段计划（PR-1 地基）

> 状态：PR-1（PRI-1134）落地；PR-2~PR-6（PRI-1135/1136/1137/1138/1139）已全部实施。
> PR-6（PRI-1139，2026-11-08）：13 个 registry key 已切中性 canonical、schemaVersion 写 `current`（双读 `1`）、
> `approval-review` / `model_aware` 写入侧切换、`/api` canonical 客户端切换（服务端保留 `/api/v1` alias）、
> `versioned-output-ref` 守门已翻 gated。本文其余内容保留为 PR-1 时的基线记录。
>
> 原文（PR-1 状态）：取代
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
- 采用 **D1 后**：OpenClaw 在取得 `roundKey` 且有候选原则时仍使用 `fair_rotation_v1`；未提供 `roundKey` 的宿主继续使用 `legacy_fifo_prefix_v1`。**本次两条策略分支都不删。**（若**不做 D1 而直接删** legacy 路由，`fair_rotation_v1` 才会失去全部生产调用者、`legacy_fifo_prefix_v1` 反成唯一策略 —— 这正是 D1 要避免的，也是 PR #2367 CodeRabbit 指出的表述歧义。）

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

这些值只清掉周围「看起来像代际」的命名与注释，不改值。**上表（含读写点）才是 Frozen Wire Literals 的事实清单**；`io-seam-registry.json` 的 `namingPolicy.frozenWireLiterals` 只是观察脚本 `check-naming-policy.mjs` 的行级豁免输入，不是「单一豁免权威」，也不宣称门禁语义（PR #2367 独立评审后的修正，见 §11）。

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
4. `io-seam-registry.json` 新增 `namingPolicy` 段（`frozenWireLiterals` 行级豁免 + `exemptFiles`）。它是**观察脚本的配置**，不是门禁权威；无效的 `exemptPaths` 已在评审后删除（§11）。
5. 新增 `scripts/check-naming-policy.mjs`：**PR-1 观察者脚本，未接入任何 CI / npm script / hook**。扫描 `packages/*` 源码中的 `runtime-v2` import、带 `-vN` 的 `outputSchemaRef`（两级 gated 规则）与 `/api/v1` 路由字面量（**inventory-only**，旧 alias 是冻结字面量）。退出契约：`--strict` 在**任何输出模式**下遇 gated finding 或扫描 I/O 错误即 exit 1；无 `--strict` 恒 exit 0 并打印告警。`--strict` 只是 PR-3 门禁的预览，**PR-3 前必须重新设计扫描面并显式接线**。PR #2367 CodeRabbit 复核后补：`--scan-root <dir>` 受控扫描入口（仅供测试）、gated 豁免不再吞掉 inventory、目录入口导入与跨行 `outputSchemaRef` 正则、`.test.tsx` 排除（详见 §13）。
6. 新增 `scripts/__tests__/check-naming-policy.test.mjs`：**10 项**回归测试（4 项退出契约 + 6 项受控 `--scan-root` / inventory 用例；§11 含 mutation 证据）。
7. 本文。

**调整 1（假测试已修复，不做无意义改动）**：计划里的 `trajectory-schema.test.ts:67-76` 假测试在当前基线**已经是真测试**——`migrateLegacyGfiSchema converges the real schema_version row (v1 → v2), idempotently` 用真实 SQLite 读 `SELECT version FROM schema_version` 并断言收敛与幂等，即审计报告 T1/T2 要求。T3（裸路径版本断言）属 PR-2 范围。本票只复核记录，不改测试。

**调整 2（`/api/v1` alias 移到 PR-6）**：`pd-console/src/server/index.ts` 的路由是**手写 `urlPath === '/api/v1/...'` 字面量分发**，不是框架 router；且同一 `/api/` 命名空间下已存在 `/api/feedback/...`、`/api/principles/...`、`/api/workspaces/...`、`/api/update/...` 等**不带 v1 段**的真实路由。PR-1 引入路径归一化会误伤这些路由、扩大改动面（违反 P3）。因此 `/api` 双路径兼容随 PR-6 的 76+54 处 URL 切换一起做，采用「新路径 canonical + 旧 `/api/v1` alias 同 handler」，并补 equivalence 契约测试。已同步到 PRI-1139。

**部署顺序（PR #2367 CodeRabbit #1）**：路径兼容层必须**先于客户端切换独立部署**——服务端先同时接受新路径与旧 `/api/v1`（沿用手写路由分发、共用同一 handler），部署稳定后才切 `ui/api.ts` 的客户端调用；**回滚 PR-6 时保留服务端新路径支持**，否则已打开的新版客户端仍会请求新路径，而回退后的服务端只认旧路径 → 404。即：新路径支持是一项可独立存在的能力，不随 PR-6 的客户端切换一起 revert。

## 7. 已知红灯基线（PR-1 记录，逐 PR 对比「失败集合一致」）

- `health-check-model.test.ts` 恒失败（本机噪音）。
- `workspace-lifecycle.test.ts` 5 fail（Windows EBUSY）。
- CI `E2E Regression Test` 自 ≥#1605 连续失败（根因 `packages/pd-cli/src/update/**` 缺 `@types/node` 与 `tuf-js`），非本链路引入。

不得以上述失败为由删测试、禁用测试或削弱守卫（AGENTS.md §25）。

## 8. §19 跨包 consumer 清单（PR-6 前逐项签收）

13 个 registry key 的全部 runner；`pd-console` 76 + 54 处 URL；`principles-core` exports 54 处与 `create-principles-disciple/core/package.json` 镜像 51 处；`@principles/core/runtime-v2` import 约 844 处；`io-seam-registry.json` 19 处路径；`.gitleaksignore` 10 条路径指纹；`scripts/check-pipeline-contract.mjs` 6 处 filters；barrel-surface 基线 JSON；docs 约 300 文件。

## 9. 明确不在本次范围

历史 ADR / 审计文档文件名与内容、各包 `CHANGELOG.md`、测试造数名与 `retired` 守卫列表、两条 prompt 策略分支、三个单功能 flag、`DiagnosticianOutputV1/V2` 与 `EvaluatorOutputV1/V2` 类型名（去后缀会撞名且破坏生产）、`/api/v1` 旧 alias 的删除、他人未跟踪文件、安装器专属目录（`~/.pd/runtime/` 等）。

## 10. §13 Complexity Delta Gate（PR #2367 独立评审后补报）

```text
Complexity Delta
New durable source of truth:        YES
New persisted schema/state:         NO
New subsystem/service/process:      YES
New public abstraction/interface:   YES
New runtime feature flag:           NO
New cross-package dependency:       NO
New host/platform-specific behavior NO
New external/network capability:    NO
```

**YES ① `io-seam-registry.json:namingPolicy`（durable config）**：① 现有 `seams` 只描述 I/O 豁免，无法承载「哪些命名/字面量在收敛期被豁免」；② 它把豁免从脚本内硬编码收敛为一份声明，隐藏的是扫描规则的边界判断；③ 更小的做法是脚本内写死豁免，但那会在 PR-3 接线时形成影子清单（P4）；④ 由 `architecture-regression.test.ts` 的 registry 有效性用例 + `check-naming-policy.test.mjs` 验证；⑤ 删除该段并让脚本回退到空豁免即可，无持久化数据、单 PR revert。**注意**：它是观察脚本配置，不是门禁权威，也不冻结任何生产行为。

**YES ② `scripts/check-naming-policy.mjs`（观察者脚本）**：① 现有 merge gate 没有任何命名层检查，PR-3 改名前需要一个可重复的存量度量；② 隐藏的是递归扫描、豁免与正则匹配；③ 只靠人工 grep 无法给出「改动前后收敛到 0」的可复现数字；④ 四种模式退出码由新增 4 项回归测试钉住，扫描结果写入 §11；⑤ **PR-1 未接任何 CI/npm script/hook**，删除该文件不影响任何运行路径。这是本 PR 最需要警惕的一项：若 PR-3/PR-6 不做，它就是零消费者的投机资产，应在 PR-3 决策时重新评估或删除。

**YES ③ `OUTPUT_SCHEMA_REF_ALIASES` + `resolveOutputSchema` 行为扩展（public interface）**：① 现有 registry 只认 13 个带版本 key，无法满足「PR-6 写入侧切换后旧 ref 仍可读、且 PR-6 可独立 revert」；② 隐藏的是双向映射与精确命中优先；③ 只在 PR-6 同一 PR 内改表也能做到，但会让那个高风险 PR 同时承担「切 key + 改 alias + 迁移消费者」，回滚面更大；④ 30 项契约测试（含精确 key 集合断言）验证；⑤ 删除该导出与 alias 分支即恢复原行为，registry 13 key 从未改变，单 PR revert。

## 11. PR #2367 独立评审与修复证据

三个只读子代理从不同角度独立评审（行为兼容性 / 全量回归 / 门禁规范），**一致结论：生产改动不会损坏现有功能**。子代理 B 实跑 1591 个断言全通过；子代理 A 逐值证明 `resolveOutputSchema` 对现有输入零变化、`budgetPolicyVersion` 两处分支 21 个输入前后等价；子代理 C 实测 `Verify Merge Gate` pass、`RELEASE_INTENT_GUARD PASS`、`isValidRegistry` 478/478。

| 发现 | 级别 | 处置 |
| --- | --- | --- |
| `--strict --json` 静默绕过（旧实现把失败判定放在非 JSON 输出分支内；实测 `strict=1` / `strict+json=0`，findings=242） | Major | **已修**：失败判定移到输出格式选择之前，统一 `process.exitCode=1`；新增 4 项退出契约回归测试 |
| 扫描 I/O 异常被静默吞掉，strict 可能假绿 | Major | **已修**：`scanErrors` 收集 readdir/readFile 失败；strict 下计入失败，warn 下打印 WARN |
| `frozenWireLiterals` 未被消费、`exemptPaths` 7 项全无效、description 自称「单一豁免权威」与实现不符 | Major | **已修**：删除 `exemptPaths`；`frozenWireLiterals` 成为 `runtime-v2-import` 规则的行级豁免输入；`api-v1-route` 降级为 inventory-only（旧 alias 本就是冻结字面量）；description 改为「观察脚本配置，PR-3 前须重设计并接线」 |
| 守门脚本误报（`vitest.config.ts` 23 次、`packages/*/scripts/**`）与正则边界问题 | Major | **部分修**：排除 `vitest.config.*` 与 `packages/*/scripts/`（对齐 eslint ignores），正则加反引号与词边界；**扫描面仍只覆盖 `packages/*` 源码**，全文 consumer 清单见 §8，PR-3 接线前必须重设计 |
| 新增 alias 测试漏 `size===26` 断言，误加全新 alias 会悄悄扩张 fail-loud 集合 | Minor | **已修**：补精确 key 集合断言，测试 29→30 项 |
| `architecture-regression.test.ts` 的源码文本断言因 alias 表复制字面量出现假阳性路径 | Minor | **移交 PR-3/PR-6**：改为对 `OUTPUT_SCHEMA_REGISTRY.has()` 的运行时断言；当前 478/478 全绿，不构成功能回归 |
| `signal-classification-schema-registry.test.ts` 扫描守卫语义放宽（新通过路径） | Minor | 属 expand 设计意图；当前生产 16 处写入全为版本化 ref，无实际漏报；PR-6 需复核 |
| §13 未申报 / eslint 规则替换未披露 / 「验证全绿」措辞 | Minor | **已修**：见 §10、本节末尾 |

**Mutation 证据**：把 strict 判定临时改回「仅非 JSON 分支生效」后，`scripts/__tests__/check-naming-policy.test.mjs` 出现 **2 条失败**（`plain.status=1` vs `json.status=0`；`expected +0 to be 1`），直接探测 `strict EXIT=1 / strict+json EXIT=0` 精确复现旧缺陷；恢复后 4/4 全绿、`strict+json EXIT=1`。

**修复后验证**：守门四模式 `warn=0 / json=0 / strict=1 / strict+json=1`；`check-naming-policy.test.mjs` 4/4；core `output-schema-ref-alias` 30 + `signal-classification-schema-registry` 5 + `architecture-regression` 478 = **513/513**；eslint 0；`node --check` 与 registry JSON 解析通过；`tsc --noEmit` 两包 0 错误。守门基线（本次独立评审修复后）为 `434/16/16`（原 478/16/10，变化原因：排除 vitest.config 与包内 scripts、正则覆盖反引号与词边界）。**CodeRabbit 复核修复后（§13）当前基线为 `458/16/135`** —— `api-v1-route` 从 16 升到 135 是因为 gated 豁免文件不再被整文件跳过（54+76 处路由字面量重新计入 inventory）。这些是「packages 源码子集」的存量，**不等于 §8 的全仓 consumer 数**。

**措辞修正**：① 「零行为变更」应精确为「**对现有输入零变更；读取侧有意扩张 13 个中性 ref**」——这是 expand 阶段的设计本身，不是回归，但也不该被表述成完全无变化。② 「验证全绿」应精确为「本 PR 相关套件全绿 + CI 29 SUCCESS / 1 SKIPPED / CodeRabbit 仍 IN_PROGRESS」，§7 的三类已知红灯基线依然存在，不得把 pending 标绿。③ **调整 3（评审后补披露）**：原计划承诺「在 `eslint.config.js` 与 `check-pipeline-contract.mjs` 加命名规则」，实际改为独立 `scripts/check-naming-policy.mjs`。理由：`check-pipeline-contract.mjs` 自述「deliberately NOT a scanner framework」，塞入静态扫描会违背其设计边界；warn-only 阶段挂进 eslint 会产生 800+ 条既有告警淹没输出。该替换此前只在 registry description 间接提及，现补记于此。

**规范张力（待 Owner 裁决）**：`.gitignore:266` 忽略 `/docs/audit/`，同段注释记录 2026-10-07 Owner ruling「published record 是 PR + Linear evidence，不是 committed report；新增需 `-f` + stated reason」。本文用 `git add -f` 入库，stated reason 是「作为收敛链路的伴随基线」。这与 ruling 意图存在张力，且形成「被忽略目录中的已跟踪孤岛」：后续新增 `docs/audit/` 文件默认 `git add` 不会收。**建议**：要么 Owner 明确批准本例外，要么从 PR-2 起把状态报告迁到 PR 描述 + Linear 子票，并把本文移出仓库。本 PR 未擅自移动。

## 12. 剩余风险与后续动作

1. **PR-3 接线前必须重设计守门脚本**：当前扫描面只覆盖 `packages/*` 源码，不含根 `scripts/`、`package.json` exports（54+51）、`io-seam-registry` 路径（19）、`.gitleaksignore` 指纹（10）、`check-pipeline-contract` filters（6）、docs（约 300 文件）。若直接翻 error 会同时假绿与误伤。
2. `architecture-regression.test.ts` 三处源码文本断言改运行时 `has()`，随 PR-3/PR-6 一起做。
3. PR-2（PRI-1135）需等 PR-1 合并后基于新 main 开工；PR-6（PRI-1139）另需 8 条前置条件全部签收。
4. CodeRabbit 评审在 PR #2367 上仍 `IN_PROGRESS`（当前只有占位摘要，无实际 findings）；合并前应等其结果，不要把「0 条行内意见」误当「评审通过」。
5. 若 PR-3/PR-6 不做，26 条双向 alias 映射、观察者脚本与 `namingPolicy` 配置会成为无消费者资产，应按 §10 的回滚路径清理。
6. PR-2（PRI-1135）已于 2026-11-06 交付 PR #2371，基于最新 main 独立开工；PR-1 合并后如有冲突需 rebase。

## 13. CodeRabbit 复核意见处置（PR #2367，review commit `ad46453`）

CodeRabbit 共 **9 条**（6 条行内 + 2 条 follow-up + 1 条 nitpick），全部 Minor/Trivial；review state `DISMISSED`（后续 push 触发）。逐条按 P1 核实当前代码：

| # | 意见 | 当前代码核实 | 处置 |
| --- | --- | --- | --- |
| 1 | PR-6 部署顺序 | 报告只写「双路径同 handler」，未写服务端先行与回滚保留 → 滚动部署/回滚会 404 | **已修**：§6 调整 2 补部署顺序（服务端兼容层先独立部署、再切客户端、回滚时保留新路径支持） |
| 2 | 白名单加 `model_aware` | 注释已声称防 PR-6 revert，但 Set 只有 `model_aware_v2` → revert 后 `model_aware` 事件被当 foreign policy 跳过，Console 用旧预算 | **已修**：加入 `model_aware`，补 1 项读取回归测试（含 `budgetChars` / `policyVersion` 断言） |
| 3 | 排除 `.test.tsx` | 仓库当前 0 个，但正则 `/\.test\.[cm]?[jt]s$/` 确实漏 | **已修**（防御性）+ 受控用例 |
| 4 | 目录入口 `./runtime-v2` | 仓库当前 0 处，但正则要求尾斜杠确实漏 | **已修**（`(?:\/｜['"`])`）+ 受控用例 |
| 5 | 豁免文件漏计 API 路由 | **成立**：`server/index.ts` 54 处 + `ui/api.ts` 76 处，脚本只报 16 | **已修**：豁免只作用于 gated findings，inventory 照常清点 → `api-v1-route` **16 → 135**，补回归测试 |
| 6 | 跨行 `outputSchemaRef` | 仓库当前 0 处，但逐行扫描确实漏 | **已修**：该规则改为全文匹配（`\s*` 跨 `\n`）+ 受控用例 |
| 7 | 改非空 changeset | 见下方判断 | **保留空 changeset**，有依据地不修 |
| 8 | D1 后策略调用者说明 | **成立**：§3 未区分「直接删 legacy」与「D1 补齐后删」，会误导后续清理决策 | **已修**：明确 D1 后 OpenClaw 仍走 `fair_rotation_v1` |
| 9 (nit) | 受控 strict 状态测试 | 合理，原测试依赖当前树的 findings | **已修**：新增 `--scan-root <dir>` 受控入口 + 6 项用例（空树 strict=0、仅扫描错误 strict=1、两种输出格式都覆盖） |
| Docstring Coverage advisory | CodeRabbit pre-merge advisory，非仓库 required check | — | 顺手补 `isAcceptedBudgetPolicyVersion` 的 JSDoc |

**#7 判断（保留空 changeset）**：① `output-schema-registry.ts` 不在公共 barrel（`runtime-v2/index.ts` 是具名导出、不含该模块），只有内部模块与测试 import；② 13 个生产 writer 全部仍传旧 ref，扩张的 13 个中性名当前**无任何生产调用者**，无用户可见行为变化；③ 空 changeset 是项目官方 `explicit-no-release` 通道（`check-pr-release-intent.mjs` 的 `emptyDeclaration`），本地与 CI 均 `RELEASE_INTENT_GUARD PASS`；④ PR-2（PRI-1135）同样用空 changeset，保持一致。若 Owner 认为「公共函数接受集合扩张」仍需对外声明，可单独补 `@principles/core` + `@principles/host-runtime` 的 patch changeset —— 这是产品决策，不由 bot 意见触发。注：release guard 读的是 HEAD 中已提交的 changeset，工作区未提交改动不参与判定，因此没有为验证「非空是否触发 C4」去造临时 commit（不为试验动 git 历史）。

**修复后验证**：守门四模式 `warn=0 / json=0 / strict=1 / strict+json=1`；`check-naming-policy.test.mjs` **10/10**；`prompt-injection-budget-observation.test.ts` **34/34**；core `output-schema-ref-alias` 30 + architecture-regression 478；eslint 0 error；`tsc --noEmit` 0 错误；`RELEASE_INTENT_GUARD PASS`。当前 inventory `458 / 16 / 135`。


