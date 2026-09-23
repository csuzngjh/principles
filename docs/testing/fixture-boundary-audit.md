# Fixture Boundary Audit (Test Diet 2.2-B4)

> 只读审计报告。生成于 2026-09-22，base main `48e75c41`（#1831/#1832/#1833 已合并）。
> 本报告与 `mock-reality-audit.md`、`internalization-test-value-audit.md` 同为本地 untracked 文档，是否入库由 Owner 决定。
> 前序：B3-A（PR #1831）、B3-C（PR #1832）已并；本票回答 B4 三问并给出最小迁移方案，未改任何代码。

---

## Executive Summary

1. **Q1 — production → test 依赖存在，且全仓仅 1 条**：`test-double-runtime-adapter.ts:25`（生产源码）import `internalization/__tests__/__fixtures__/split-pipeline-mock-outputs.js`。全仓扫描（含 fixtures/test-double/mock/fake/stub 词形 + vitest import + 跨包引用）确认无其他 src→tests 边，production src 零 vitest 依赖。
2. **Q2 — 三条反向嫌疑均查明**：① 上述边 = **A 类真架构污染（依赖方向）**，但 adapter 本体是 **C 类合法 runtime test double**（production-reachable，`--allow-test-double` 门控）；② `__tests__` 编译进 dist 再随 `files:["dist"]` 发布 = **B 类构建误含**，已独立立票（Release artifact hygiene），**不混入 Test Diet**；③ `golden-dogfood-fixtures.ts` = 反向问题（测试数据住生产 + 公共桶导出），仅 1 个测试消费者，收口涉公共 API 面须 Owner。
3. **Q3 — P0 迁移方案已定（即原定 B3-B）**：`git mv` fixture 一个文件进生产目录（导出名不变），改 5 个 import 方 + 3 行相对类型路径 + 2 处注释 + 1 处文档路径；不触碰 barrel、不触碰 barrel-surface JSON、不改 fixture 内容。预估 1 文件搬移 + ~10 行改动，半天量级（含验证）。

---

## Dependency Graph

```
split-pipeline-mock-outputs.ts   (131 行，__tests__/__fixtures__/，真实 LLM 缓存，禁手改)
  ├─→ [类型] diagnostician/diag-rootcause-output.js, diag-distiller-output.js,
  │         diagnostician-output.js   (src 内部，合法)
  ←─ PRODUCTION: adapter/test-double-runtime-adapter.ts:25        ★ 唯一 src→tests 违反边
  │              （仅消费各 map 的 'R6' 键，见 adapter :122-153 fetchOutput 分派）
  ←─ TEST: diag-chain-e2e.test.ts:42
  ←─ TEST: diag-rootcause-intent-tension.test.ts:28
  ←─ TEST: diag-router-intent-tension.test.ts:29
  ←─ TEST(harness): __fixtures__/diag-runner-harness.ts:55

TestDoubleRuntimeAdapter (src/runtime-v2/adapter/test-double-runtime-adapter.ts:39)
  ←─ src barrel: adapter/index.ts:1-2 → runtime-v2/index.ts:327-328（公共 API 面）
  ←─ pinned: runtime-v2-barrel-surface.json:1286-1287 + architecture-regression.test.ts:3609,3633
  ←─ PRODUCTION (跨包 @principles/core/runtime-v2):
       pd-cli runtime-adapter-resolver.ts:27,156（`--allow-test-double` 门控 :99-100,159-161；
          flag 注册 index.ts:348,763-764）
       pd-cli synthetic-baseline-runner.ts:16,85 / pain-flood-simulation-runner.ts:16,188 /
          runtime-internalization-run-once.ts:221,247,278,319,360,400 /
          pain-retry.ts:406 / diagnose.ts:166
  ←─ 契约: runtime-protocol.ts:23 RuntimeKindSchema = Type.Literal('test-double')（生产协议枚举）

golden-dogfood-fixtures.ts (476 行，住在 src/internalization/，非 __tests__)
  ←─ src barrel: runtime-v2/index.ts:948-949（GOLDEN_FIXTURES + FixtureDataSet 公共导出）
  ←─ pinned: runtime-v2-barrel-surface.json:438,448
  ←─ TEST only: __tests__/evidence-chain-contract.test.ts:9
  ←─ 生产接线消费者: 0（pd-cli / host-runtime / console 全仓无引用）
```

---

## Findings

### F-1 唯一 src→tests 违反边（本票 P0 主题）

| | |
|---|---|
| Item | test-double adapter 反向 import 测试 fixture |
| Path | `packages/principles-core/src/runtime-v2/adapter/test-double-runtime-adapter.ts:25` |
| Direction | production src → `__tests__/__fixtures__/`（错误方向） |
| Risk | 高（结构性）：fixture 变更 → 生产 test-double 行为变更 → 发布物变更，三者无隔离；且该 fixture 头注"DO NOT edit by hand"的纪律读者默认它是测试资产 |
| Evidence | 考古：adapter 建于 `e113548b7`（M4 #395）；fixture 建于 `192ed0751`（PRI-372 #903）；违反边出现于 `ba90cbe8c`（PRI-401 split-stage taskId 修复，注释明言 "Reuse fixtures…(R6)" = 刻意复用而非失误）；当前仅用 `.R6` 键（adapter:123 注释,:122-153）；全仓此类边扫描=此 1 条 |
| Classification | **A（依赖方向污染）**——但 adapter 本体= **C（合法 runtime test double）**，见 F-6 |
| Recommendation | 搬 fixture 归生产目录（详见 Migration Immediate），**不搬 adapter**、不动导出面 |

### F-2 测试资产进构建产物与发布物（B 类，独立票管辖）

| | |
|---|---|
| Item | tsconfig 编译 `__tests__` + dist 原样发布 |
| Path | `packages/principles-core/tsconfig.json:21-22`（include `src/**/*`，exclude 仅顶层 `tests`；无 tsconfig.build.json，`build: "tsc"` 唯一配置）；`pd-cli/tsconfig.json:24-25`、`pd-console/tsconfig.json:16-17` 同状 |
| Direction | 构建工具包含（非源码 import 违规） |
| Risk | 发布面污染（既有独立票） |
| Evidence | 实测 dist：3265 文件中 `__tests__` 路径 1545、`*.test.*` 1637（含 409 个 distinct `.test.js`）；`split-pipeline-mock-outputs`、`test-double-runtime-adapter`、`golden-dogfood-fixtures` 编译产物均在 dist；`package.json:55-57` `files:["dist"]`；`scripts/bundle-plugin.mjs:118-122,293-311` 无过滤整拷 core/dist；`pd-cli/package.json` **无 files 数组**（src+tests 整包可发布）；dist 另有 stale 孤儿（`golden-trace-candidate-builder.*`、`golden-trace-replay-adapter.*`，tsc 不剪枝） |
| Classification | **B（构建误包含）** |
| Recommendation | **本票不处理**。归 Owner 已立项的 Release artifact hygiene 票（tsconfig exclude / files / bundle 过滤 / 孤儿剪枝一并裁决）。注：F-1 的搬移在 B 类下仍必要——方向违规不因 dist 排除而消失（vitest 直接跑 src，见 `__tests__` 全在编译域内的现实）。 |

### F-3 golden-dogfood-fixtures：测试数据成为公共 API 面

| | |
|---|---|
| Item | 12 组手工 queue-state 场景数据经桶导出 |
| Path | `packages/principles-core/src/runtime-v2/internalization/golden-dogfood-fixtures.ts`；`runtime-v2/index.ts:948-949` |
| Direction | 反方向问题：test-only 数据住在生产 src 并暴露为 API（非 src→tests） |
| Risk | 中：公共面承诺 vs 零生产消费者；`pain-path-test-governance-report.md:249` 早已列其为"唯一结构性风险" |
| Evidence | 消费者仅 `evidence-chain-contract.test.ts:9`；全仓 CLI/host/console 引用=0；`runtime-v2-barrel-surface.json:438,448` 钉住（`core-barrel-surface.json` 未含，实测 0 命中）；入桶系 `9180f01e6`（PRI-775 桶冻结）顺带，非设计决策 |
| Classification | **A（轻度：位置+暴露面）** |
| Recommendation | **Future / Owner**：退役桶导出或降为内部模块须同步改 barrel-surface JSON——与 `PassThroughDreamerValidator` 导出退役同规则（AGENTS 治理先例），禁止混入 F-1 迁移。 |

### F-4 lint 现状认可 tests-in-src（登记）

`eslint.config.js:166-191` 的 no-restricted-imports 对 core src 禁 I/O，但 :199-208 **豁免** `src/**/*.test.ts` —— 现有 guard 把"测试住在编译域"制度化而非约束边界。无 boundaries 插件、无任何 guard 钉"dist 不得含测试"。归 F-2 独立票一并考虑，本票不动 guard。

### F-5 干净项（扫描的阴性结果同样是证据）

- production src import vitest：`rg "from ['\"]vitest" packages/*/src`（排除 __tests__/test.ts）= **0**。
- 除 F-1 外 src→`__tests__|/tests/|fixtures` import = **0**。
- `io-seam-registry.json`：fixture/双件无 I/O，不涉 seam，无需注册。
- pd-config binding 解析（`resolve-runtime-from-pd-config.ts`）零 `test-double`；`pain-retry.ts:355-372` 显式拒默认——门控方向正确。

### F-6 TestDoubleRuntimeAdapter 本体 = C 类合法 runtime test double（不改）

生产 CLI 明确支持 fake adapter（B4 任务书 Q2-C 的原型实例）：协议枚举 `runtime-protocol.ts:23`、opt-in flag、resolver 门控、5 个生产 runner 使用、barrel-surface 冻结。它的存在是产品能力（无 LLM 跑仿真/自检），**唯一缺陷就是 F-1 那条 import**。

---

## Migration Candidates

### Immediate（= 原定 B3-B 实施票，P0）

**把 fixture 搬进生产目录，方向修正；内容一字不改。**

1. `git mv src/runtime-v2/internalization/__tests__/__fixtures__/split-pipeline-mock-outputs.ts` → `src/runtime-v2/adapter/split-pipeline-fixtures.ts`（与唯一生产消费者同址；导出名 `MOCK_ROOT_CAUSE_OUTPUTS` / `MOCK_DISTILLER_OUTPUTS` / `MOCK_ROUTER_OUTPUTS` 不变，diff 最小；B3 审计 `mock-reality-audit.md:259` 同方案）。
2. 改 import 共 5 处：`test-double-runtime-adapter.ts:25`（同目录化）+ 4 个测试方（chain-e2e:42 / rootcause-intent-tension:28 / router-intent-tension:29 / diag-runner-harness:55）。
3. fixture 内 3 行类型相对路径随目录深度调整（`../../../diagnostician/…` → `../../diagnostician/…`）。
4. 注释与文档同步：adapter:10、:123 两处提及旧名；`docs/testing/pain-path-test-inventory.md:390` 路径行。
5. **不做的**：不搬 adapter、不删 `__tests__/__fixtures__/` 下其他资产、不加薄 re-export 层（避免双层，B3 审计同判）、不触 barrel/barrel-surface/eslint/tsconfig。
6. 验证：diag 相关定向套件（chain-e2e、双 intent-tension、harness 消费方）+ core 全套 + `verify:merge`。留一份搬移前后 payload 全等核对（git 内容 diff 为空即证）。

Rejected alternative（B3 审计方案二"生产自带字面量副本"）：会产生同一 LLM 缓存数据的两份真相，违反 P4；搬移才是单源。

### Future（各自独立票，勿混车）

| 候选 | 级别 | 归属 |
|---|---|---|
| dist/tsconfig/pd-cli-files/bundle 过滤测试资产 + 孤儿剪枝 | P1 | Release artifact hygiene 票（Owner 已立项方向，B3 指令 1-②） |
| golden-dogfood-fixtures 桶导出退役/内部化 | P2 | Owner 决策（涉 barrel-surface + architecture-regression，同 PassThroughDreamerValidator 规则） |
| 重复 fixture（diag payload 多套件共享） | P2 | B3-A harness 已收敛大半，无新增重复证据 |
| 命名污染 | P3 | 实测≈0（见 F-5 与下表），无需立票 |

### Keep（调查后确认不动）

见下节。

---

## Do NOT Change

- **TestDoubleRuntimeAdapter 本体 + 其公共导出**：production-reachable runtime test double（`runtime-protocol.ts:23` 契约、`--allow-test-double` 门控、pd-cli 5 个生产 runner）。B4 问题 F1 的正确修法是搬 fixture，不是搬/删 adapter 或把它降级为纯测试件。
- **split-pipeline-mock-outputs 文件内容**：真实 LLM 缓存（Qwen3.6-27b，`--core-grounding`），头注禁手改、再生成链在（已停跟踪的）`spike/`（`7b037b2a2`）。搬移=纯位置变更。
- **golden-trace.ts / golden-trace-replay-validator.ts**：被生产 activation 接线消费（`production-gate-deps.ts`、`rule-host-writer.ts`），是运行时特性非测试资产。
- **samples-review / samples-list / openclaw samples 命令**：`samples` 是 pain-sample 领域名词，命名扫描误报。
- **FakeStore / FakeSocket / CountingStoreStub、config/gateway/pd-backups 的 `vi.mock('fs')`**：B3-C 已逐个判定 KEEP（fs mock 是 ESM spy-enabler）。
- **diag-runner-harness.ts / intent-tension-cases.ts / __tests__/fixtures/**（harness、barrel-surface JSON 等）**：纯测试基础设施，位置合规（tests→tests），是 Immediate 项里的"被搬家者邻居"，不动。
- **PassThroughDreamerValidator 导出**：Owner 决策项，维持 B3 指令。
- **architecture guards**（barrel-surface、no-restricted-imports、io-seam-registry）：本票与 B3-B 均不触碰；F-2/F-3 若实施由各自票带着 guard 一起改。

---

## Completion Criteria 对照

- ✅ 未修改代码 / ✅ 未创建 PR / ✅ 未删除文件（仅新增本 untracked 报告，B3 审计同模式）
- ✅ 全部结论有 file:line 证据（F-1~F-6、§5 各条）
- ✅ 下一阶段实施建议：见 Migration Immediate（P0 迁移，即 B3-B）
