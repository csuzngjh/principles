# PRI-919 Phase 0 — Bundle Dependency Budget Gate: Reality Audit

Date: 2026-09-24 · Task: PRI-919 · Predecessors: OPT-002 (barrel narrowing),
OPT-003 (purity guard wiring), PRI-918 (artifact hygiene gate)

阶段禁令遵守：本文件为只读调查结果，不含任何实现。

## 1. 当前 bundle 清单（实测）

唯一的 satellite bundle 生成点是
`packages/openclaw-plugin/esbuild.config.js`：一次 `build()` 调用（:35-62，
`metafile: true` :61）产出三个入口——

| entryPoint | 输出 | 性质 |
|---|---|---|
| `bundle` → src/index.ts | `dist/bundle.js` | 主入口，**合法携带 LLM runtime**（host adapters） |
| `governance-audit` → src/governance-audit.ts | `dist/governance-audit.js` | satellite（读侧小产物） |
| `rulehost-evidence` → src/rulehost-evidence.ts | `dist/rulehost-evidence.js` | satellite |

satellite 名册的现行 SSoT：`scripts/build/check-satellite-purity.mjs:23-26`
（`SATELLITE_OUTPUT_SUFFIXES`）。

另有 dev-only 的 `dist/core/*` 5 个维护者 CLI 工具 bundle（esbuild.config.js:81-104，
`if (!isProduction)` 且**不开 metafile**）——非发布 satellite，不在本契约范围。

`principles-core` 无 esbuild 步骤（纯 tsc）；`pd-console/scripts/build-ui.mjs` 是浏览器
bundle，不是 satellite。除上述外仓库无其他 bundle 生成点。

## 2. 当前 baseline（2026-09-24 实测，本机 worktree）

两种构建模式体积相差约 10 倍（dev 带 inline sourcemap、不 minify；
production minify、无 sourcemap）。因此**任何单一体积预算必须按模式区分**，
否则 dev 构建必然打爆 production 口径（或 production 口径在 dev 下形同虚设）。

| artifact | prod raw | prod gzip | dev raw | dev gzip | prod inputs 数 | 最大依赖来源（prod, bytesInOutput） |
|---|---|---|---|---|---|---|
| bundle.js | 4,156,930 | 1,034,741 | 36,188,801 | 7,777,581 | 2,551 | `@google/genai` 284,586（允许：主入口） |
| governance-audit.js | **70,786** | 18,794 | 693,112 | 135,538 | 121 | `src/core/event-log.ts` 12,828；`typebox/extends-check` 8,607 |
| rulehost-evidence.js | **60,244** | 16,574 | 442,791 | 120,399 | 18 | `src/core/trajectory.ts` 33,990；`runtime-v2/trajectory-schema` 7,331 |

两个 satellite 的 prod 输入图中**没有任何 LLM SDK**（typebox 为合法校验依赖）。
mission 例举的 `size: 70786` 与 governance-audit production 实测逐字节一致，
确认任务书口径 = production raw bytes。

历史事故量级（OPT-002）：污染时每个 satellite 携带 **~2.7 MB** LLM 图
（pi-ai / pi-agent-core / undici / @google/genai / anthropic / openai）——
即污染回归的体积特征是 **~40× 跳变**，不是渐进漂移。

## 3. 已存在的机制（复用判断）

| # | 机制 | 位置 | 何时执行 | 实际覆盖 |
|---|---|---|---|---|
| D1 | **依赖预算检查（已存在）** | `scripts/build/check-satellite-purity.mjs`：`FORBIDDEN_LLM_PACKAGES`(:35) 已含 pi-ai / pi-agent-core / @anthropic-ai(scope) / openai / @google/genai / undici；`collectSatelliteViolations`(:77) 沿 metafile inputs 在 `node_modules/<pkg>/` 边界匹配；`assertSatellitePurity`(:121) fail-loud | 每次 `build:bundle` / `build:production`（esbuild.config.js:66 喂活 metafile）；即 `npm run check-satellite-bundle-deps` = **verify:merge 末步** | 仅 satellite（bundle.js 设计性豁免）；missing-output 时报错，不许 vacuous pass |
| D2 | 纯度的接线自保测试 | `scripts/__tests__/check-satellite-purity.test.ts`（236 行）：合成 metafile 矩阵 + 「esbuild.config 必须调用 assertSatellitePurity」+「verify:merge 必须以 check-satellite-bundle-deps 结尾」的字面断言 | test:scripts / CI | 防 guard 被无声摘除（EP-09/ERR-146 类） |
| D3 | 粗粒度体积上限 | repo-health.yml（单文件>10MB 告警）、release-metadata.yml（asset tar.gz>95MB） | 各自 workflow | 与 bundle 预算无关，量级差 2 个数量级 |

**结论：不重复造 checker。** 依赖腿（D1）已完整覆盖 mission Phase 1 的
Dependency Budget 且已挂进 verify:merge；本任务真正的净缺口只有：

- **G1 — 体积预算不存在**：全仓库没有任何逐 bundle 的 size assertion
  （Explore 全仓检索确认，D3 不算）。
- **G2 — 无模式区分**：metafile `outputs[].bytes` 已在每次构建中产生，但从未被
  读取；dev/production 双口径基线（§2）无人持有。
- **G3 — 体积异常无归因**：metafile 的 `inputs[].bytesInOutput` 能直接回答
  mission 要求的 `introduced by: xxx`，现有代码未使用。
- **G4 — 输出格式**：mission 要求的 PASS/FAIL 预算块（artifact/size/baseline/
  current/delta）尚不存在。

## 4. 最小插入点（供 Phase 1-2）

1. **SSoT 扩展而非新文件**：`check-satellite-purity.mjs` 已是「satellite 名册 +
   禁止依赖」的唯一权威；`SIZE_BUDGETS`（双模式 baseline/max）加在同文件，
   契约仍单点。mission 建议的 `bundle-budget-contract.mjs` 新文件会造成
   两个 satellite 名册，违背单一 SSoT 要求，**不采**。
2. **零接线改动**：`assertSatellitePurity(metafile)` 的调用点（esbuild.config.js:66）
   与 verify:merge 末步（check-satellite-bundle-deps）原样复用——体积腿挂在
   同一个函数体内，依赖+体积一次判定。不改 esbuild.config.js、不改
   package.json、不新增 CI job。
3. **模式检测**：调用发生在 esbuild 进程内（`process.argv` 含 `--production`
   与否），guard 模块内读取即可区分双预算；CLI `--metafile` 路径加可选
   `--production` flag；函数签名收一个显式 opts 供测试注入。
4. **rc-3 纪律**：satellite output 缺 `bytes` 数字字段 = 契约破坏，必须
   fail-loud（ERR-146 教训：声明覆盖≠实际执行；静默跳过的检查不是检查）。
5. **容差**：production +10%（mission 建议值，minify 后口径稳定）；
   development +25%（inline sourcemap 对任意上游源码字节变化放大 ~2×，
   紧容差会把无关漂移变成假阳性；污染类回归 40× 跳变在任何容差下都必炸）。
   合法变更导致超预算时，更新 `SIZE_BUDGETS` 常量本身即评审可见的动作
   （与 D2 的字面断言同级）。

## 5. 误报红线（false-positive red lines）

| 形态 | 判定 | 依据 |
|---|---|---|
| bundle.js 携带 LLM SDK / 体积大 | **合法，永不判** | 主入口拥有 LLM runtime（OPT-002 设计豁免）；satellite 名册外的输出一律不读 |
| dev 构建的 satellite（~693KB/442KB raw） | 用 development 预算 | 双口径见 §2，单口径必假阳性 |
| typebox 等合法校验依赖进入 satellite | 合法 | 不在 FORBIDDEN_LLM_PACKAGES；体积计入 satellite 输入图属正常漂移 |
| 源码文件名含 openai/pi-ai 字样（如 `openai-compat-shim.ts`） | 合法 | D1 只在 `node_modules/<pkg>/` 包边界匹配（既有行为，不动） |
| `dist/core/*` dev-only 维护者工具 | 不在契约 | §1，非 satellite 名册成员 |
| esbuild/依赖版本升级带来的温和漂移 | dev +25% 内自动容忍；越界时人工重定基线 | §4.5 |

## 6. 结论

Phase 1/2 的全部所需事实已固化：名册与禁止清单复用 D1 SSoT；双模式基线取
§2 实测值；体积腿与依赖腿合并进 `assertSatellitePurity`，verify:merge 与
release 构建两条路径**零接线改动**同时获得两腿门禁。Complexity Delta 目标
全部 NO（无新文件、无新持久状态、无新接线、无 topology 变化）。
