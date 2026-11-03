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

## Post-merge Addendum（2026-11-03，G3.1-A 收尾时复核）

本节只补充事实与勘误，不覆盖上文历史记录。

### A1. 勘误：PR 编号
本报告上文写的 PR `#2307` 与 GitHub 实际记录不符：

- G3.2 实际合并 PR = **#2309**（head `ai/pd-release-g32-build-dedup`，merge commit
  `77e6b7f348f44ebb44899fc281a693d0cb85c55a`，merged 2026-11-03T04:22:30Z）。
- `#2307` 是同一时段的 “Version Packages” PR（merge `3bcbc8c6…`，02:34:50Z），不是 G3.2。
- 因此上文 “PR #2307：25/25 required+advisory 全 PASS” 应读作 **PR #2309**。

### A2. 真实发布结果（已发生的 cohort）
| Run | Cohort | Publish job | Finalize job | Run 结论 |
|---|---|---|---|---|
| 41561315808 | `a107d8a8…` | success | success | failure（仅 `Reconcile Codex plugin runtime maintenance PR`） |
| 41567130757 | `3bcbc8c6…` | success | success | failure（同一 job） |

- npm 侧真实发布：`@principles/core@2.0.0`、`codex-adapter@0.6.3`、`workbuddy-adapter@0.2.17`、
  `principles-disciple@2.2.13`、`@principles/pd-cli@1.162.8`、`create-principles-disciple@1.146.7`
  于 02:39–02:57Z 发布；`@principles/host-runtime@0.14.6` 于 03:50Z 由 cohort `3bcbc8c` 发布。
- run 级 failure 不是 npm 发布失败：八条 npm leg 与 finalize 均 success。
- `41578899039`（cohort `9ef8d607…`）在本次收尾时仍 in_progress：15/15 matrix 已 success，
  Windows N-1 upgrade gate 进行中，publish job 尚未创建 → 该 cohort 的发布状态 **NOT RUN**。

### A3. Provenance 验证（真实 registry，非 mock）
对上述已发布版本逐个读取 `/-/npm/v1/attestations/<name>@<version>`，解码 in-toto Statement，
把 subject `digest.sha512`（hex）与 registry `dist.integrity`（`sha512-<base64>` 转 hex）比较：

| 包 | 版本 | attestation | subject sha512 == dist.integrity |
|---|---|---|---|
| @principles/core | 2.0.0 | 存在 | MATCH |
| @principles/host-runtime | 0.14.6 | 存在 | MATCH |
| @principles/codex-adapter | 0.6.3 | 存在 | MATCH |
| @principles/workbuddy-adapter | 0.2.17 | 存在 | MATCH |
| principles-disciple | 2.2.13 | 存在 | MATCH |
| @principles/pd-cli | 1.162.8 | 存在 | MATCH |
| create-principles-disciple | 1.146.7 | 存在 | MATCH |
| @principles/install-layout | 0.4.0 | 存在 | MATCH |

结论：上文 “provenance 真实 attestation 未演练” 对 **目录发布路径** 已可更正为 **已验证**；
但这 8 次发布均发生在 G3.1/G3.2 合并之前（tools checkout 早于 #2305/#2309），
因此 **candidate tarball publish 路径的真实 provenance 仍未演练**（待 `41578899039` 发布 job 完成）。

### A4. Build-once 正确性审查（代码 + 测试证据）
| 问题 | 结论 | 证据 |
|---|---|---|
| cohort 是否绑定构建结果 | 是 | `build-once.mjs` 复用前比较 `entry.cohort`；候选 tarball 再写入 `gitHead=cohort`（`prepare-npm-candidate.mjs`） |
| version 是否参与复用判断 | 是 | 比较 `entry.version` 与当前 manifest version；`release-build-once.test.ts` “version changed → rebuild” |
| dist SHA-256 能否识别新增/删除/改名/内容 | 是 | `<rel>\0<size>\0<bytes>` 逐文件哈希；测试覆盖 rename/content/缺失 |
| ledger 损坏是否必然重建 | 是 | `readLedger()` 解析失败返回 `{}` + `::warning::`，测试 “never skips on a corrupt ledger” |
| build 失败是否不会记成功 | 是 | `execFileSync` 抛错即退出；测试 “fails the step and records nothing” |
| 是否可能错误复用旧产物 | 否（在同 job 内，见下） | ledger 路径默认 `RUNNER_TEMP`（job 内），跨 job 不可见；dist 缺失/为空/内容变化均重建 |
| 跨组件/跨 job 版本偏移 | 无 | key=`workspace#script`；跨 job 由 `RUNNER_TEMP` 隔离，preamble 各 leg 改为 fail-closed 验证而非复用 |

### A5. digestDist 的 symlink/特殊文件缺口（已修复）
- 事实：`digestDist()` 原来只收集 `entry.isFile()`，对 symlink/特殊文件既不入哈希也不报错
  → 同一 dist 里新增/改指向/删除 symlink 时 digest 不变，可能错误复用。
- 构建产物契约证据：本 worktree 全量扫描 `packages/**`（排除 node_modules）非普通文件数 = **0**；
  构建命令均为 `tsc`/`esbuild` + `clean-dist.mjs`，不产生 symlink。但这是“当前事实”，不是契约，
  无法证明未来不会出现 → 采用 **fail-closed**：
  - `digestDist()` 遇到非普通文件抛错，不再静默忽略；
  - `build-once.mjs` 复用检查阶段视为“不可复用 → 重建”，构建后仍出现则 `exit 1` 且不记账。
- 回归：`release-build-once.test.ts` 新增 2 项（构建产出 symlink → 失败且无 ledger；digest 直接调用 →
  抛 `non-regular entry`）；Windows 无符号链接权限时用 junction 覆盖同一代码路径。

### A6. Follow-up 状态（以代码与实际执行证据判定）
| # | Follow-up | 状态 | 依据 |
|---|---|---|---|
| 1 | G3.1-A 七包 immutable candidate | **COMPLETED**（本 PR） | `publish-npm-package/action.yml` 全 leg 单一 candidate + tarball publish；测试 8 项 |
| 2 | build-once train shared-dist | **DEFERRED** | 涉及 TOOLS/PRODUCT 版本偏移；本轮不实施，需单独方案 |
| 3 | release-metadata Console 2→1 skip flag | **COMPLETED**（实现+单测）；生产执行 **NOT RUN** | `release-metadata.yml` 仅 asset step 设 flag；`console-dist-freshness.test.ts`；合并后无 release-metadata run |
| 4 | 跨 leg build-once 记账重构 | **DEFERRED** | 同上，需单独方案；本 PR 未引入跨 leg 全局状态 |
| 5 | provenance 首真实 cohort 验证 | **COMPLETED**（目录发布路径，见 A3）；candidate tarball 路径 **NOT RUN** | 8 包 subject MATCH；新路径待 41578899039 |

---

完整交付报告：`docs/implementation-reports/PD_RELEASE_G3_2_BUILD_DEDUP_DELIVERY_REPORT.md`。