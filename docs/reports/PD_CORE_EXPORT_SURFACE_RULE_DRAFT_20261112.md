# 核心库导出面审计与"增量准入"规矩（草案）

> 类型：审计报告 + 规矩草案（只读调查，未改任何产品代码）
> 基线：`origin/main` @ `56342b0`（2026-11-12 09:08 +0800）
> 本地工作区 `main` 落后 219 个提交（`f15798cf`），**本文所有数字来自 `git archive origin/main` 解包后的只读扫描，不是本地工作区**
> 状态：待评审 → 决定是否落成规矩与门禁

---

## 0. 摘要

1. **公开面 2,351 个符号，其中 1,380 个（58.7%）零外部引用。** 这 1,380 个里，754 个全仓（含 core 自身）都没人用，219 个只有 core 自己的测试用，407 个只有 core 生产代码用。真正被包外代码引用的只有 971 个。
2. **`./runtime` 一个入口就占 2,032 个符号**（占公开面 86%），其中 1,239 个零外部引用；`./trajectory-types`（31 个符号、0 个零引用）和 `./evolution-store`（7 个、0 个）说明"窄子路径"这种形态本身是健康的——问题集中在桶文件。
3. **接口面确实还在变宽，而且速度可测**：2026-11-09 → 2026-11-12（292 个提交）公开面 +72 个符号（+3.2%），零外部引用符号 +37，`./runtime` 桶 +49 个符号。按此速率约 **每周 +170 个公开符号**。
4. **`runtime/index.ts` 的 411 个 re-export 块中，124 个块（30%）导出的符号零外部引用**；另有 25 个块"导出一大把、外部只用到 1 个"。
5. **现有相关门禁只有两道，且都不够**：PRI-416 的桶文件行数/导出行上限（`BARREL_MAX_TOTAL_LINES=300`、`BARREL_MAX_EXPORT_LINES=50`）只覆盖根桶 `src/index.ts`，且对"删一个加一个"完全失明；PRI-775 的名字快照只覆盖 `src/index.ts` 与 `src/runtime/index.ts` 两个文件，拦不住新增子路径和另外 25 个入口的新增导出，而且它是"改快照即可放行"，没有任何准入理由字段。
6. **推荐组合**：`package.json` 子路径白名单冻结（拦住新开洞）+ 全 27 个入口的导出名基线快照与准入记录（拦住增宽），落地形态是扩展现有 PRI-775 守护，不新建 CI 基础设施；不建议把规则塞进 `check:repo-hygiene` 作为权威（它看的是暂存区，容易误报且可被 `--no-verify` 绕过）。

---

## 1. 口径与方法

### 1.1 统计定义

| 术语 | 定义 |
|---|---|
| 导出语句 | AST 中 `ExportDeclaration` 或带 `export` 修饰符的语句；一个多行 `export { ... } from` 块计 1 条 |
| 不同符号 | `packages/principles-core/src` 全部非测试模块的导出名并集，递归解析本地 `export *` 与 `export {} from` 链 |
| 公开面 | `packages/principles-core/package.json` 的 `exports` 子路径（27 个，不含 `./package.json`）各自可达符号的并集 |
| 外部引用 | `packages/` 之外与同仓其它包中的引用：静态 `import` / `import type` / `export {} from` / `import * as` 的成员访问 / 动态 `import()` 与 `require()` 的成员访问与解构 |
| 零外部引用 | 在公开面上，但外部引用次数为 0 |
| 内部使用 | core 自身模块之间用相对路径 import 该名字 |
| 零引用（死导出） | 零外部引用，且 core 内部（含测试）也没人用 |

### 1.2 方法自证

- 对 `src/index.ts` 与 `src/runtime/index.ts` 算出的导出名集合分别为 **200 / 2032**，与仓库内 PRI-775 快照 fixture（`core-barrel-surface.json` = 200、`runtime-barrel-surface.json` = 2032）**逐字一致**。
- 用同一套脚本回放 2026-11-09 的快照（`e7c7e6b`），得到 **3,657 条导出语句、2,147 非空行、406 个块、778 个不同被引符号**，与旧报告 `PD_ARCHITECTURE_COMPLEXITY_REVIEW_20261110.md` 的 `3657 / 2147 / 406 / 777 / 2394` 在 0.1% 内吻合（2394 vs 2,404 的差异来自旧脚本对少数跨行/别名导入的漏配）。

这说明本节口径与旧报告连续，可以直接对账。

### 1.3 NOT RUN / 不可观测

| 项目 | 状态 |
|---|---|
| 仓库内 npm 脚本与测试 | **NOT RUN**（本次纪律：只读，不执行仓库脚本） |
| 外部 npm 消费者（发布到 npm 的 `@principles/core@7.3.3`） | **不可观测**：仓库内没有下游清单；下文"零外部引用"只代表**本仓**为零 |
| `check:repo-hygiene` 自身耗时 | **NOT RUN**；只测了它若加载本检查所需的增量成本（见 §5.4） |
| openclaw-plugin 打包产物是否内联 core | 只读到 `esbuild.config.js` 存在与 `prepack: build:production`，**未实测产物** |

---

## 2. 导出面的真实构成

### 2.1 总量

| 指标 | 数值 |
|---|---:|
| 非测试源文件数（`core/src`） | 410 |
| 导出语句 | **3,777** |
| 不同导出符号（整包、含未进公开面的内部模块） | **2,989** |
| 公开面符号（27 个 entry 的并集） | **2,351** |
| `exports` 子路径 | 27（全部至少被一个消费者用过，无死子路径） |
| 外部引用符号（去重） | **971** |
| 具名导入点（每个符号计 1 次；仅 `packages/`、仅静态具名导入，口径同旧报告） | 2,535（旧报告 2,394） |
| 零外部引用符号 | **1,380（58.7%）** |

### 2.2 与旧报告对账

| 指标 | 旧报告（11-09 树） | 本次复现（11-09 树） | 本次（origin 11-12） | 差异说明 |
|---|---:|---:|---:|---|
| `^export` 语句 | 3,657 | 3,657 | **3,777** | 口径一致，+120 为真实增长 |
| `runtime/index.ts` 非空行 | 2,147 | 2,147 | **2,204** | 文件总行 2,431（含 227 空行） |
| `runtime/index.ts` re-export 块 | 406 | 406 | **411** | +5 |
| 消费者不同符号 | 777 | 778 | **815** | 旧脚本漏配 1 个；其余为增长 |
| 具名导入点（按符号计） | 2,394 | 2,404 | **2,535** | 同上 |

> 结论：旧报告没有过时，只是被随后 292 个提交推高了 3% 左右。

### 2.3 三天增长（同口径，11-09 → 11-12）

| 指标 | 11-09 | 11-12 | Δ |
|---|---:|---:|---:|
| 导出语句 | 3,657 | 3,777 | **+120** |
| 不同导出符号 | 2,875 | 2,989 | +114 |
| 公开面符号 | 2,279 | 2,351 | **+72** |
| 外部引用符号 | 936 | 971 | +35 |
| 零外部引用符号 | 1,343 | 1,380 | **+37** |
| `./runtime` 桶符号 | 1,983 | 2,032 | **+49** |
| 零外部引用的 re-export 块 | 127 | 124 | −3 |

**读法**：公开面净增 72，但外部引用符号只净增 35；零引用符号净增 37。**接口面扩张的速度是真实需求的两倍**，这是当前的实际边际产出。

### 2.4 消费者结构（"包外" vs "同仓其它包"）

| 消费者 | 不同符号 | 说明 |
|---|---:|---|
| `packages/` 内其它包（含其测试） | 968 | 生产代码 909、测试并集 276 |
| `scripts/`（`packages/` 之外唯一的符号级消费者） | **21** | `escapeXml`、`getDefaultPdConfig`、`SqliteConnection` 等 |
| `plugins/` | **0** | 只出现 `'@principles/core'` 字符串（包名/pin 校验），无符号 import |
| 顶层 `tests/`、`ops/` | 0 | `git grep origin/main -- tests ops` 无命中 |

> 扫描范围为 `packages/`、`scripts/`、`plugins/`（这三个目录承载全部可执行代码）；顶层 `tests/`、`ops/` 用 `git grep` 复核为 0。

逐包生产引用（不同符号数）：`pd-cli` 364、`openclaw-plugin` 338、`pd-console` 219、`host-runtime` 218、`codex-adapter` 23、`workbuddy-adapter` 22、`packages/dev` 16、`pd-mcp-server` 12、`create-principles-disciple` 7。

> **"包外消费者"实际上只有 `scripts/` 的 21 个符号。** 也就是说：公开面 2,351 个符号中，只有约 41% 有本仓证据；剩下的 59% 要么是内部实现被顺手导出，要么是已经死掉。

### 2.5 零外部引用分层（变宽的主要来源）

| 分层 | 符号数 | 含义 | 处置难度 |
|---|---:|---|---|
| A. 全仓零引用（死导出） | **754** | core 内外都没人 import | 最低：删 barrel 即可 |
| B. 仅 core 测试使用 | **219** | `__tests__`/`tests` 通过相对路径用 | 低：删公开导出 + 测试改相对路径 |
| C. core 生产代码在用（测试可能也用） | **407** | 如 `LedgerAdapter`（23 个内部文件用） | 低：内部相对 import 不受影响，只是"对外暴露"这一层多余 |
| 合计 | **1,380** | 占公开面 58.7% | |

引用次数分布（公开面 2,351）：

| 外部引用次数 | 0 | 1–2 | 3–5 | 6–10 | 11–50 | 51+ |
|---|---:|---:|---:|---:|---:|---:|
| 符号数 | **1,380** | 718 | 169 | 51 | 27 | 4 |

高频 4 个：`SqliteConnection`(160)、`SqliteActivationStateStore`(76)、`getDefaultPdConfig`(71)、`RuntimeStateManager`(60)——它们才是"事实上的公共 API"，其余大多是长尾。

### 2.6 `runtime/index.ts` 块级

| 指标 | 数值 |
|---|---:|
| re-export 块 | 411 |
| 块内符号总数 | 2,032 |
| 零外部引用的块 | **124（30%）** |
| 零外部引用块覆盖的符号 | 407 |
| "≥5 个符号、外部只用到 1 个"的块 | 25 |

零外部引用最大的几个块：

| 行 | 来源模块 | 符号数 | 首几个 |
|---:|---|---:|---|
| 30 | `./owner-decision/owner-decision-view-contract.js` | 27 | `OwnerDecisionViewCoreSchema`, `OwnerSourceRefSchema`, `ReasonSchema`, … |
| 125 | `./context-payload.js` | 23 | `HistoryQueryEntrySchema`, `TrajectoryLocateQuerySchema`, … |
| 183 | `./context-payload.js` | 21 | `HistoryQueryEntry`, `TrajectoryLocateQuery`, … |
| 122 | `./runtime-protocol.js` | 13 | `RuntimeKindSchema`, `RuntimeCapabilitiesSchema`, `RunHandleSchema`, … |
| 127 | `./diagnostician-output.js` | 9 | `DiagnosticianViolatedPrincipleSchema`, … |
| 2004 | `./types/event-payload.js` | 9 | `isToolCallEventEntry`, `isPainSignalEventEntry`, … |

"只为一个符号服务"的块（节选）：

| 行 | 来源模块 | 符号数 | 唯一被外部用到的符号 |
|---:|---|---:|---|
| 133 | `./types/event-types.js` | 33 | `RuntimePromptActivationsInjectedEventDataSchema`（而且**只有测试**用） |
| 51 | `./governance-experience-contract.js` | 25 | `GovernanceExperienceSnapshotSchema` |
| 129 | `./types/index.js` | 21 | `PRINCIPLE_STATUSES` |
| 1860 | `./evolution/evolution-types.js` | 17 | `isCompleteDetectorMetadata` |
| 1003 | `./internalization/internalization-task-guards.js` | 11 | `isRetryWaitBackoffElapsed` |

### 2.7 逐入口（按零引用比例排序）

| entry | 符号数 | 零外部引用 | 1–2 次引用 |
|---|---:|---:|---:|
| `./runtime` | 2,032 | **1,239（61%）** | 562 |
| `.`（根桶） | 200 | 118（59%） | 47 |
| `./runtime/types/event-types` | 100 | 65 | 33 |
| `./runtime/feedback` | 62 | 53（85%） | 6 |
| `./prompt-builder` | 58 | 21 | 36 |
| `./principle-tree-ledger` | 45 | 8 | 31 |
| `./quality-scorecard` | 43 | 16 | 26 |
| `./trajectory-types` | 31 | **0** | 29 |
| `./host` | 30 | 13 | 6 |
| `./runtime/pain-recall` | 19 | 13 | 6 |
| `./runtime/pain-submit-capability` | 19 | 12 | 6 |
| `./runtime/intent-browser` | 17 | 6 | 4 |
| `./runtime/pain-recall-capability` | 16 | 11 | 4 |
| `./runtime/internalization/rule-context-v2` | 16 | 7 | 4 |
| `./runtime/internalization/evidence-readiness` | 13 | 9 | 2 |
| `./runtime/internalization/design-gate-facts` | 11 | 3 | 8 |
| `./runtime/feedback/redact-sensitive` | 10 | 9 | 0 |
| `./runtime/adaptive-delivery-record` | 10 | 8 | 1 |
| `./trajectory-store` | 10 | 2 | 6 |
| `./runtime/internalization/tool-semantic-registry` | 9 | 2 | 4 |
| `./runtime/internalization/rule-host-input-builder` | 8 | 3 | 4 |
| `./runtime/receipt-coverage` | 8 | 4 | 4 |
| `./runtime/trajectory-schema` | 8 | 2 | 4 |
| `./evolution-store` | 7 | **0** | 6 |
| `./runtime/internalization/bash-risk` | 4 | 3 | 1 |
| `./runtime/internalization/behavior-example-pack` | 3 | 1 | 0 |
| `./runtime/store/workspace-leak-guard` | 2 | 1 | 0 |

> `./trajectory-types`、`./evolution-store` 是反例：**窄入口可以是 0 死面**。这说明问题不是"core 必然宽"，而是"桶文件没有准入"。

---

## 3. 三个典型例子

### 例 1：内部契约被顺手导出——`LedgerAdapter`

- 声明：`packages/principles-core/src/runtime/candidate-intake.ts:284`（`export interface LedgerAdapter`）
- 对外暴露：`packages/principles-core/src/runtime/index.ts:223`，与 `CandidateIntakeInput`、`LedgerPrincipleEntry` 等共 5 个类型同一块 `export type {}`
- 检索证据：外部引用 **0**；core 内部 23 个文件通过相对路径使用（`principle-tree-ledger-adapter.ts:23`、`candidate-intake-service.ts:47`、`runtime/cli/diagnose.ts:14`、多个 `__tests__`）
- 性质：它的消费者全是"实现者"（core 自己的 adapter 与测试），没有任何宿主/CLI 需要它。放在 `./runtime` 桶里唯一的效果是让 `LedgerAdapter` 变成"看起来可以实现的公共接口"。

### 例 2：一个模块 10 个导出，外部只要 1 个函数——`runtime/feedback/redact-sensitive.ts`

- 导出 10 个：`REDACTED_PATH`、`REDACTED_VALUE`、`NO_STACK`、`redactAbsolutePaths`、`redactTokenLikeValues`、`redactEnvLikeValues`、`redactTelemetryString`（:74/:75/:87 重载）、`redactStackTrace`、`RedactResult`、`redactSensitiveFields`
- 外部只用了 `redactTelemetryString`：`packages/codex-adapter/src/pd-hook.ts:7`、`packages/workbuddy-adapter/src/pd-hook.ts:39`
- 其余 9 个只在 core 内部用（`runtime/feedback/create-report.ts:28-29` 等）
- 更贵的是：这个模块还单独开了一个子路径 `./runtime/feedback/redact-sensitive`（10 个符号、9 个零引用），即**为了复用 1 个函数，额外开了 1 个公开入口，并把 9 个内部工具一起挂上去**。

### 例 3：整块 re-export 只为一个符号服务，且那个符号只有测试用——`./types/event-types.js` @ `runtime/index.ts:133`

- 该块一次性 re-export **33 个** 符号（`EventTypeSchema`、`EventCategorySchema`、`EventLogEntrySchema`、`ToolCallEventDataSchema`、`PainSignalEventDataSchema` …）
- 外部唯一引用：`RuntimePromptActivationsInjectedEventDataSchema`，且只在 `packages/host-runtime/tests/prompt-budget-model-aware.test.ts:10` 出现——**生产代码零引用**
- 同一模块另有 `./runtime/types/event-types` 子路径（100 个符号），其中 65 个零外部引用
- 性质：为了一个测试断言，把 33 个 schema 挂到主桶；桶宽度与真实需求之间没有任何计量关系。

---

## 4. 规矩草案：新增/放宽核心库导出的准入

### 4.1 适用范围

`packages/principles-core` 的 `package.json#exports` 中任何可被外部解析的入口（当前 27 个），以及这些入口可达的全部符号。内部模块的 `export`（未被入口可达）不受本节约束。

### 4.2 准入记录：写在哪、什么格式

**权威位置**：仓库内、与快照同目录的单一文件

```
packages/principles-core/src/runtime/__tests__/fixtures/export-admissions.json
```

**格式**（append-only；JSON 便于机检，评审时 diff 可读）：

```jsonc
{
  "schemaVersion": 1,
  "admissions": [
    {
      "entry": "./runtime",
      "symbol": "SomeNewThing",
      "kind": "value",              // value | type | subpath
      "addedIn": "PRI-1234",        // 必填，必须匹配 /^PRI-\d+$/
      "consumers": [                // 必填，至少 1 条，且必须是生产路径（不含 tests/__tests__）
        "packages/pd-cli/src/commands/runtime-activation.ts"
      ],
      "whyNotInternal": "…",        // 必填，≥ 40 字符：为什么不能留在 core 内部
      "alternativeConsidered": "…"  // 必填，≥ 20 字符：为什么不走窄子路径 / 类型复制 / 内部模块
    }
  ],
  "removals": [
    {
      "entry": "./runtime",
      "symbol": "OldThing",
      "removedIn": "PRI-1234",
      "changeset": ".changeset/brave-pandas-jump.md",
      "deprecatedSince": "7.2.0"
    }
  ]
}
```

三条硬要求（对应的错误信息要直接告诉作者下一步做什么）：

1. **新增**：任一 entry 的符号集合出现新名字 → 必须有 `admissions` 条目，否则失败，提示"如果消费者只是同仓包，请改用内部模块或窄子路径"。
2. **删除/改名**：出现消失的名字 → 必须有 `removals` 条目 + changeset；改名按"删旧 + 增新"处理。
3. **新增子路径**：`exports` 出现新 key → 必须有 `kind: "subpath"` 的准入条目，且需 Owner 批准（见 §4.5）。

PR 描述里贴同一段 `whyNotInternal`（机器读 JSON，人读 PR）——两者不一致时以 JSON 为准。

### 4.3 内部符号的可用手段（按推荐顺序）

| 手段 | 用法 | 成本 | 何时用 | 风险 |
|---|---|---|---|---|
| **A. 不导出**（同包相对 import） | 默认。`export` 只给同包其它模块用 | 0 | 绝大多数 `LedgerAdapter` 型符号 | 无 |
| **B. 窄子路径** | `"./runtime/contracts/<domain>"`，只放该领域 1–5 个符号 | 低（`package.json` + 一个 barrel 文件） | 跨包需要、但契约面很窄（`./trajectory-types` 是范本） | 子路径数量会涨，需要 §4.2 的子路径准入 |
| **C. 仅类型导出** | `export type {}` | 0 | 只需要类型、不需要运行时值 | 仍然是公开面；改名字/删字段对下游 TS 是破坏性变更 |
| **D. `./internal/*` 通配子路径** | `"./internal/*": "./dist/internal/*"` | 低 | **不推荐**：一条通配会把整个白名单变成摆设，npm 下游也能 import | 高 |

选择规则一句话：**能用 A 就不用 B，能用 B 就不用 C，D 不做**。若最终仍需宽阔口，走 §4.5 的例外。

### 4.4 删除/收窄的兼容处理

| 情况 | 处理 |
|---|---|
| 内部符号收窄（本就不该在入口上） | 不算 breaking；但仍要 `removals` 记录（便于回溯"哪天收的"） |
| 公开符号删除/改名 | **major**；先按现有 `docs/architecture/VERSIONING_AND_COMPATIBILITY.md` §7.3.1 走 `@deprecated` + alias，至少跨 2 个 minor |
| 子路径删除 | major + changeset + 迁移说明（`CHANGELOG.md` 与 `docs/` 下迁移段） |
| 存量批量删除（§6） | 单独一条 changeset，写明批次与"零外部引用"证据（本报告 §2.5 的分层口径） |

`@changesets/cli` 已在用、CI 有 `Release intent guard (changesets)`，不需要新机制；只需要在规范里写明"删除必须带 changeset"。

### 4.5 例外报备

确实必须宽导出（例如类型推导需要、或第三方 SDK 要求）时：

```jsonc
{
  "entry": "./runtime",
  "symbol": "WideThing",
  "kind": "value",
  "addedIn": "PRI-1234",
  "exception": {
    "approvedBy": "owner",
    "reason": "…",
    "ticket": "PRI-1234",
    "expiresAt": "2027-03-31"   // 必填；过期后门禁变红，必须重新决策
  }
}
```

例外必须**带到期日**，否则一年后没人记得它为什么宽。到期由门禁检查（比较当前日期）自动失败，而不是靠人记。

### 4.6 建议落点（不本次修改）

- `docs/architecture/VERSIONING_AND_COMPATIBILITY.md` §7 增加 **7.4 导出准入**（引用本节格式），并在 §12 不变量表新增：

| ID | 不变量 | 强制方式 |
|---|---|---|
| VER-7 | 新增公开导出必须有准入记录（含 `whyNotInternal`） | `architecture-regression` 中的导出面守护 + `export-admissions.json` |
| VER-8 | `exports` 子路径只增不隐式增（新增需 Owner 批准） | 同上（`kind: "subpath"`） |

理由：§7.1 已经定义了 `stable / experimental / internal / deprecated` 四级，但 §14 表格自认"Public API 稳定性标记 ❌ 待建"。本规矩正好补上"标记从哪来、谁批准"的上游，而不是另起一套。

---

## 5. 可机检的最小办法

### 5.1 三方案对比

| | A. `exports` 子路径白名单 | B. 导出名基线快照 + 准入记录 | C. 加到 `check:repo-hygiene` |
|---|---|---|---|
| 能拦住 | 新开子路径（含 `"./*"` 这种通配洞） | 所有入口的新增/删除/改名 | 同 B 的子集 |
| 拦不住 | 桶内新增符号（`./runtime` 2,032 个符号完全不设防） | —（这就是它的职责） | 与 B 相同，但只覆盖被暂存的文件 |
| 实测成本 | ~1 ms（读 `package.json` 比对 key） | 全量 27 入口：**~0.5 s**；单文件增量：毫秒级 | 挂在 pre-commit：+0.5 s（不走全量则误报） |
| 误报风险 | 无（字符串比较） | 低，但有 5 类结构性噪声（见 5.3） | 中：看暂存区而非工作树，编辑中途必然不一致 |
| 可绕过 | 否（Node 解析层面生效） | 否（CI 测试） | 是（`--no-verify`、本地不装 hook） |
| 现状 | **字段已存在，但无任何规则**；27 个子路径全部有人用，无死子路径 | **已有 2/27 的雏形**（PRI-775 两个桶的 fixture） | 已有 `staged` / `all` 两种模式 |
| 结论 | **要做**，作为边界冻结 | **主门禁** | **不做权威**；最多做本地提示 |

### 5.2 推荐落地形态

**扩展现有 PRI-775 守护，不新建系统。**

- 现在：`architecture-regression.test.ts` 的 `PRI-775: barrel export surface freeze`，对 `src/index.ts`、`src/runtime/index.ts` 做文本级名字快照；遇到 `export *` / default 会 fail-loud；fixture 自洽性有独立断言。
- 改成：把 fixture 从"2 个桶的文件名集合"升级为"27 个入口的符号集合 + 子路径清单 + admissions/removals"。
- 为什么不是新脚本：`Test principles-core` 这个 CI job 已经在跑；`verify:merge` 已经包含 `build` 与 `typecheck`，再加一个独立命令只是在同一份 CI 时间里多占一个进程。留在 vitest 里，错误信息还能复用现有风格（`+ added (n): …`）。
- **解析方式要用 AST，不要沿用现有的正则**：现有 extractor 的 `^export (const|function|class|interface|enum|abstract class)` 没有覆盖 `export type X = …`。两个桶恰好都是纯 re-export 文件所以没暴露；换成 `./trajectory-types`（31 个 `export type`）就会大面积漏报。`typescript` 已是 core 的 devDependency，AST 解析 410 文件实测 468 ms。
- 前置条件已满足：27 个入口文件当前**没有一个** `export *`（3 个内部 `index.ts` 有，但它们不是入口），所以 fail-loud 不会误炸。

### 5.3 误报清单与规避

| # | 噪声 | 会不会误报 | 规避 |
|---|---|---|---|
| 1 | 注释/多行块 | 现有 extractor 已剥离注释并有单测 | 保持 fail-loud |
| 2 | 符号在入口间移动 | 会显示为"删 1 + 增 1" | 消息中区分 `move`；`removals` 与 `admissions` 各 1 条 |
| 3 | 改名 | 同上 | 按 rename 提示 |
| 4 | 仅测试使用被当作"有消费者"（219 个） | 会让准入理由失真 | `consumers` 校验拒绝 `tests/__tests__` 路径 |
| 5 | 消费者导入了不存在的名字（本次发现 4 个：`CorrectionObserverResult`、`DiagRootCauseOutputV1`、`DiagDistillerOutputV1`、`RuleCandidateMaterial`） | 若用"引用存在=已批准"会误批 | 准入不依赖调用方检索，只依赖名字集合；这 4 个另按 §7 处理 |
| 6 | 入口文件用 `export *` | 名字集合无法证明 | 现成 fail-loud（已有先例文案） |

### 5.4 性能实测（本机，Windows，Node 26）

| 操作 | 耗时 |
|---|---:|
| 解析 core 全部 410 个非测试源文件（TS AST） | **468 ms** |
| 读取 2,351 名字的基线 JSON | 1.5 ms |
| 单文件解析 | ~0.8 ms |
| 全仓扫描（410 core 文件 + 2,900+ 导入点 + core 894 文件内部引用） | **4.46 s** |

结论：门禁只需要"core 源文件 + 基线"，**0.5 s 量级**，放在 core 测试套件里可忽略；"是否有人用"的消费侧扫描（4.5 s）只用于本次审计和存量盘点，不需要进门禁。

### 5.5 历史存量怎么入基线

- **一次性**：把当前 27 个入口的 2,351 个名字、27 个子路径全部写入基线，**不写 admissions**。规则从"下一次改动"开始生效，第一天零阻塞。
- **不把存量写成 admissions**：那会让文件变成 2,351 条无意义记录，反而稀释新增记录的可读性。
- **收窄走 `removals`**：存量清理时每条/每批写 1 条 removal，不要求 `whyNotInternal`。
- 若团队希望"存量也要有标记"，正确做法是分批把公开面删到目标值（§6），而不是给每个存量补理由。

---

## 6. 存量怎么处理

### 6.1 一次性收窄会打断谁

| 受影响方 | 证据 | 影响 |
|---|---|---|
| `pd-cli` / `openclaw-plugin` / `pd-console` / `host-runtime` | 分别引用 364 / 338 / 219 / 218 个符号 | 直接受影响 |
| `codex-adapter` / `workbuddy-adapter` / `pd-mcp-server` / `packages/dev` | 23 / 22 / 12 / 16 个符号 | 直接受影响 |
| `openclaw-plugin` 的对外 façade | 189 个 core 符号被它 `export {} from '@principles/core'` 再导出 | 删 core 导出会连带打断它的包面 |
| `scripts/` | 21 个符号（`escapeXml`、`getDefaultPdConfig`、`SqliteConnection` …） | 直接受影响 |
| 外部 npm 消费者 | **不可观测** | 只能按 semver 处理（major） |

补充：`openclaw-plugin` 引用了 338 个 core 符号，但其 `package.json` 的 `dependencies` 里**没有** `@principles/core`（走 esbuild bundle）。这意味着收窄会在其构建期暴露，不会在运行期静默——对我们是好事，但要单独验证（本次 NOT RUN）。

### 6.2 推荐路径：先基线、只拦增量，再分批动存量

| 阶段 | 动作 | 不变量 |
|---|---|---|
| **P0（现在，1 个 PR）** | 落基线（27 入口 + 子路径），只拦增量；不删任何导出 | 公开面停在 2,351 |
| **P1** | 删 A 层 754 个死导出（全仓零引用） | 任何 import 都不会断；公开面 → ~1,600 |
| **P2** | 删 B 层 219 个"仅 core 测试使用"的公开导出，测试改相对 import | 外部零影响；公开面 → ~1,380 |
| **P3** | 删 C 层 407 个"core 生产代码在用"的公开导出（内部相对 import 不动） | 公开面 → ~970，与"真实被引用 971"对齐 |
| **P4** | 718 个 1–2 次引用：按入口逐个评估，能进窄子路径就进，能合就合 | 目标公开面 ≤ 1,000 |
| **P5** | 27 个 11–50 次 + 4 个 51+：不删，补 ADR/契约文档与稳定性标记 | — |

每一批必须**独立 PR + 独立 changeset**，批间重跑本报告指标；不允许"一次性大扫除"。

### 6.3 什么时候再动存量

- **不要在存储端口收敛之前动**：存储类符号是高频引用区（`SqliteConnection` 160 次、`SqliteActivationStateStore` 76 次），先收口会同时改边界和接口面，事故归因会混在一起。
- **挑 major 窗口**：P1–P3 虽然本仓零引用，但对 npm 下游是 breaking；按 §7.3.1 的 deprecation 周期走，或集中在下一个 major。
- **先做 P0 再谈别的**：P0 不改变任何行为，只锁住边际；不做 P0 就做 P1–P3，会一边删一边被新增抵消（§2.3 的 +37/3 天就是证据）。

---

## 7. 边角发现（与本期目标相关，建议另立条目）

1. **测试目录不参与 typecheck**：`packages/*/tsconfig.json` 的 `include` 只有 `src/**/*`，因此测试里的类型导入错误不会在 `verify:merge` 的 `typecheck` 阶段暴露。本次据此发现 4 个"导入了不存在的符号"：
   - `CorrectionObserverResult @ @principles/core/runtime`（openclaw-plugin 两个测试；真实导出名是 `CorrectionObserverOutputV1`）
   - `DiagRootCauseOutputV1`、`DiagDistillerOutputV1`（pd-cli 测试；这两个名字未被 `runtime/index.ts` re-export）
   - `RuleCandidateMaterial`（pd-console 测试；整包 src 里根本没有该导出）
   影响：它们会被任何"按引用反推公开面"的脚本误当成真实消费者——这也是 §5.2 坚持"用名字集合、不用引用集合"的原因之一。
2. **子路径改名是一次已发生的"收窄先例"**：PRI-1136 把 `@principles/core/runtime-v2` 改名为 `/runtime`，`package.json#exports` 里没有留 `runtime-v2` 别名；`plugins/principles-disciple/scripts/verify-pinned-runtime-capability.cjs:140-149` 只能靠"按 pin 版本探测两代子路径"来兼容。这说明子路径改名会真实影响下游，§4.4 的 removal 流程必须把"子路径改名"和"符号改名"同等对待。
3. **`check:repo-hygiene` 已在 pre-commit 与 `verify:merge` 双跑**，语义是"不要提交垃圾文件"。把 API 准入塞进去会让它同时承担两种职责，且 pre-commit 只看暂存区——不建议（见 §5.1）。

---

## 附录 A：复现方法

本次未提交任何脚本（纪律：只读）。复现要点：

```powershell
# 1) 取基线快照（不碰工作区，不建分支）
$dst = "$env:TEMP\pd-origin"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
git -C d:\Code\principles archive --format=tar origin/main -- packages scripts plugins |
  tar -xf - -C $dst

# 2) 用 TypeScript AST 统计（typescript 用仓库 node_modules 里的那份）
#    - 导出语句：ExportDeclaration 或带 export 修饰符的语句
#    - 入口：package.json#exports 的 types 字段映射 dist/ -> src/ 并去掉 .d.ts
#    - 外部引用：@principles/core 与 @principles/core/* 的静态/动态 import、export-from、命名空间成员
#    - 内部使用：core 内相对路径 import
```

自证：`src/index.ts`=200、`src/runtime/index.ts`=2032，与 `__tests__/fixtures/*-barrel-surface.json` 一致。

## 附录 B：旧报告数字对照

| 旧报告 | 本次（11-09 复现） | 本次（11-12 origin） |
|---|---|---|
| `^export` 3,657 | 3,657 | 3,777 |
| `runtime/index.ts` 2,147 行 | 2,147（非空） | 2,204（非空）/2,431（总） |
| 406 个 re-export 块 | 406 | 411 |
| 777 个被引符号 | 778 | 815 |
| 2,394 次 import | 2,404 | 2,535 |

---

## 附录 C：给下一份改动的三个最小动作

1. 把 §4.2 的 `export-admissions.json` 与 §5.2 的守护写成 1 个 PR（只加门禁，不改任何导出）。
2. 在 `VERSIONING_AND_COMPATIBILITY.md` 增补 §7.4 与 VER-7/VER-8（约 40 行）。
3. P1（删 754 个死导出）单独排期，等存储端口收敛之后。
