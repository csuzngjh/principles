# PD Release G3.2 Build Deduplication Delivery Report

- 日期：2026-11-03
- 阶段：G3.2 发布流水线构建去重（SPEC-PD-RELEASE-ARCH-SIMPLIFICATION-001 §6/§8）
- 基线：origin/main `b2665b61f`（含 G3.1 PR #2305 已合并）
- 分支：`ai/pd-release-g32-build-dedup`
- PR：#2307

## A. 核心设计

**目标语义（SPEC-PD-RELEASE-ARCH-SIMPLIFICATION-001 §6）**：`Resolve cohort → Build each required artifact → Pack immutable candidate → Verify candidate → Publish that candidate`。

**核心原则**：只消除没有独立验证价值的重复构建；保留有实际验证价值的独立双构建。

## B. 实测基线（真实 CI 日志，非 YAML 推测）

| 指标 | Before (origin/main) | After (HEAD) | Δ |
|---|---:|---:|---:|
| 全 ABSENT 场景总构建执行次数 | 19 | 12 | **−7 (−37%)** |
| preamble 重复构建（core/install-layout/host-runtime） | 3 | 0 | **−3** |
| 跨 leg 复用（codex/workbuddy/pd-cli） | 0 | 5 | **+5** |
| Console build（release-metadata 资产 leg） | 2/leg | 1/leg | **−50%** |
| 总构建耗时（全 ABSENT） | 31.3s | 21.5s | **−9.8s (−31%)** |

实测依据：run 41368536198（G3.1 前基线，全 ABSECT 形态）与 run 41561315808（G3.1 后，5 发布/1 跳过形态）逐步统计。

## C. 实施内容

### 1) build-once.mjs — job-scoped ledger + artifact identity
- 位置：`scripts/release/build-once.mjs` + `scripts/release/lib/dist-digest.mjs`
- 账本键：`workspace#script`；记录 `cohort`、`version`、`dist SHA-256`
- 仅当 `cohort==current` 且 `version` 一致且 `dist SHA-256` 与磁盘一致时复用
- 不匹配 → `::warning::build-once: <key> ledger entry rejected (reason) — rebuilding`，**从不静默回退**
- 排除：plugin（prepack 变体）、reproducibility 双构建、release-metadata 资产 leg（原生平台各自构建）

### 2) Preamble-built packages 验证替代重建
- core / install-layout / host-runtime 在 train preamble 显式构建一次
- 其各自 leg 改为 `assert_preamble_dist()`：仅验证 `packages/$1/dist/index.js` 存在且非空，缺失即 `exit 1`（fail-closed）
- 消除 3 次/次重复构建

### 3) Console skip flag（PD_BUNDLE_SKIP_CONSOLE_BUILD=1）
- release-metadata “Build release asset” 步骤**显式构建 Console 后**设置 env
- bundle-plugin：`PD_BUNDLE_SKIP_CONSOLE_BUILD=1` 时调用 `assertConsoleDistFresh()` 四重验证
  1. 产物完整（dist/server.js, dist/server/index.js, dist/web/index.html）
  2. 生产模式（无 inline sourcemap）
  3. dist 不比 src/ 旧（防止陈旧复用）
  4. 无编译测试产物（hygiene）
  - 任一失败 → fail-loud 并给出 repair hint
- flag **仅**在 release-metadata “Build release asset” 步骤的 env 中设置
- reproducibility / preflight rehearsal / 手动 pack：均不设置（全量构建）

### 4) 跨 workflow / checkout 的产物传递
- **不做 artifact 传递**：train 在同一 job 内顺序执行，文件系统本身是传递通道
- release-metadata 资产 leg 必须各自在原生平台构建（ABI/签名/manifest 独立），不复用
- publish-preflight rehearsal 复用同一 action，`dry_run: true` 时走相同 candidate 路径但跳过上传

### 5) 三处跨平台修复（CI ubuntu 行为不变）
1. **ERR-045 复发**：`prepare-npm-candidate.mjs` / `build-once.mjs` 统一用 `findNpmCliJs()` + `node npm-cli.js` 纯 argv 调用（Windows `npm` 直调 ENOET）
2. **GNU tar `D:\...` 远程主机误判**：所有 tar/gzip 调用改为 `cwd=tempRoot` + **纯相对路径**（`--force-local` 无效，`-C` 目录参数仍被改写）
3. **coreutils `sha512sum` 转义模式**：Windows 路径含 `\` 触发转义输出 `\<hash>` → re-hash 前 `tr -d '\\'`（哈希本身纯 hex，剥离精确）

## B. 实测证据

| 场景 | Old | New | Δ |
|---|---:|---:|---:|
| all-absent 总构建执行 | 19 | 12 | **−7 (−37%)** |
| all-absent 耗时 | 31.3s | 21.5s | **−9.8s (−31%)** |
| run-41368536198 形态（5发布/1跳过）构建数 | 12 | 11 | −1 |
| Build-once 复用（all-absent） | 0 | 5 | +5 |
| Preamble 验证通过 | 0 | 3/次 | +3/次 |
| Console build/资产 leg | 2 | 1 | **−50%** |

## C. 测试证据

| 测试套件 | 结果 |
|---|---|
| build-once 单测（9 项：cohort/version/SHA-256/缺失/损坏/版本/cohort 冲突/陈旧 ledger/构建失败/畸形参数） | **9/9 绿** |
| console-dist-freshness 门（10 项：缺失/不完整/DEV/陈旧/测试产物/恢复提示） | **10/10 绿** |
| workflow 契约测试（build_once 接线/重复消除/plugin排除/preamble验证/flag位置/隔离性） | 109/109 绿 |
| G3.1 回归（immutable candidate / recovery / registry） | 54/54 绿 |
| scripts 全套件（maxWorkers=2） | **1976/1976 绿** |
| installer fast（含新 fake-npm dry-run/篡改检测/Console 正负向） | 997/997 绿 |

所有冲突测试均为本机并行负载超时类 flaky（另一会话同机 vitest 并行），隔离重跑 186/186 绿 + maxWorkers=2 1976/1976 绿双重验证。

### CI 结果
- PR #2307：25/25 required+advisory 全 PASS（含 Verify Merge Gate、packaged install smoke、release asset smoke、8包测试矩阵）

## C. 风险与限制

| 风险 | 评级 | 缓解 |
|---|---|---|
| provenance 真实 attestation 未演练 | 低 | dry-run 跳过 libpub；mock 无法覆盖 OIDC；首真实 cohort 即验证点，异常=fail-closed 无半发布，回滚=revert → **PASS_WITH_LIMITATIONS** |
| 确定性重封依赖 runner GNU tar/gzip 版本 | 低 | 同 runner 双构建一致已测；npm tarball 无跨构建字节比较门禁（现状亦无） |
| plugin / repro / 资产 leg 未纳入复用 | 设计决策 | plugin prepack 变体、repro 独立验证、资产 leg 原生 ABI 不同 |

## 交付物

| 文件 | 类型 |
|---|---|
| `scripts/release/build-once.mjs` | 新增 |
| `scripts/release/lib/dist-digest.mjs` | 新增 |
| `packages/create-principles-disciple/scripts/console-dist-freshness.mjs` | 新增 |
| `packages/create-principles-disciple/tests/console-dist-freshness.test.ts` | 新增 |
| `scripts/__tests__/release-build-once.test.ts` | 新增 |
| `scripts/__tests__/release-workflows.test.ts` | 修改（G3.2 契约块） |
| `.github/actions/publish-npm-package/action.yml` | 修改（build_once/preamble verify + build 分支） |
| `.github/workflows/publish-npm.yml` | 修改（preamble build_once + 占位注释） |
| `.github/workflows/release-metadata.yml` | 修改（asset step 设置 skip flag） |
| `packages/create-principles-disciple/scripts/bundle-plugin.mjs` | 修改（Console skip flag + freshness gate） |
| `scripts/__tests__/release-build-once.test.ts` | 新增 |
| `scripts/release/lib/dist-digest.mjs` | 新增 |
| `packages/create-principles-disciple/scripts/console-dist-freshness.mjs` | 新增 |
| `packages/create-principles-disciple/tests/console-dist-freshness.test.ts` | 新增 |
| `scripts/__tests__/release-build-once.test.ts` | 新增 |
| `docs/implementation-reports/PD_RELEASE_G3_2_BUILD_DEDUP_DELIVERY_REPORT.md` | 新增 |

## 回滚
单提交 revert 即恢复；无 schema/状态/flag/依赖/lockfile 变更；registry 侧兼容不变。

## 最终裁定
**PASS_WITH_LIMITATIONS** — 唯一限制：provenance 真实 attestation 仅在首真实 cohort 可验证（fail-closed 兜底），所有其他门禁与回归测试完整通过。

## Follow-ups
1. G3.1 A 项：7 包 candidate 机制扩展（installer leg 之外）
2. G3.2 build-once train shared-dist（跨 leg 更深度复用，需版本偏移风险评估）
3. release-metadata Console 2→1 skip flag（env flag + fail-loud，~2.5s/leg）
4. 跨 leg build-once 记账重构（解耦 TOOLS/PRODUCT 版本偏移风险，需单独 SPEC）
5. provenance 首真实 cohort attestation 验证项（附于下次产品发布 run）

---

完整交付报告：`docs/implementation-reports/PD_RELEASE_G3_2_BUILD_DEDUP_DELIVERY_REPORT.md`。