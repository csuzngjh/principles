# PD CI & Test Runtime Optimization — Phase II 实施报告

- 日期：2026-11-18（Phase II 收尾：2026-11-19 凌晨，UTC 2026-11-18）
- 分支：`ai/adhoc-20261118-ci-runtime-optimization-f0466b`
- 基线：`origin/main` = `d6919f751`（本分支已重建到该提交；#2713 已合并，#2710 仍未合并）
- 基准 SHA：`66947a069`（14 job 全绿 × 3 次；本报告的纯文档提交在其之上，不参与基准）
- PR：https://github.com/csuzngjh/principles/pull/2712
- 工作树：`D:\Code\_worktrees\principles\adhoc-20261118-ci-runtime-optimization-f0466b`

> **Phase III-A 增补（2026-11-19）**：#2712 / #2710 / #2713 均已合并，main HEAD 已前进到
> `bf9ea3af9`，job 结构回到 **15 个**（新增独立 `Export Surface Gate`）。Phase III-A 的
> 全部结论、实测数据与「Git Fixture 优化 NO-GO」判定见文末 **附录 B**。本文件正文中的
> Phase II 历史基线**一字未改**。

> **数字标注约定**
> 【实测】= 来自真实 GitHub Actions 运行或本地真实执行；
> 【估算】= 由实测推算、未被本分支运行证实；
> 【未取得】= 取不到，附原因；
> 【NOT_REPRODUCED】= 指令/历史报告中的前提在当前仓库不成立。

---

## 1. Executive Summary

本轮不减少任何测试、不放宽任何断言，只优化执行方式。实施了两项有实测净收益的改动：

| # | 改动 | 性质 | 实测效果 |
| --- | --- | --- | --- |
| 1 | 把 `verify-merge` 已用数周的「物化 node_modules 缓存」推广到 **12 处安装点**（`ci.yml` 10 处 + `pd-console-e2e.yml` 1 处 + `pr-checks.yml` 1 处；一个 composite action、一个 key） | 复用既有机制 | 安装步骤 **28–53s → 4–6s**；`pd-mcp-server` job 82s → 30s |
| 2 | `build-openclaw-plugin` 并入 `test-openclaw-plugin-coverage` | 消除重复 install + build | 273s（62+211）→ **143s**；job 数 15 → 14 |
| 3 | **Phase II 收尾**：`codex-plugin-delivery`（Node 24）的缓存输入从 `22` 改为 `24`，`node-version` 变为必填无默认值 | 正确性修复（ABI 错配） | 新增独立 key `Linux-node24-…-node-modules`（run 44323248736 实测）；见 §2.4 |
| 4 | **Phase II 收尾**：`Dependency Audit` 的 Node 24→22 完成等价性实测 | 正确性验证（非降级） | 16 条 advisory / 11 个漏洞 / 退出码 1 / 409 个解析包 **逐项相同**；见 §2.5 |


另有 **2 处接入在实测后回退**（净收益不为正，见 §4.5）：Windows 条目还原 58–72s ≈ 原 install 64s；Node20 条目还原 45–52s > 原 install 37s。

**结果【实测，同口径中位数】**：job-min **45.64 → 39.30（−13.9%）**；执行墙钟 **515s → 428s（−16.9%）**。
三次完整成功运行（14 job 全绿、`pd-companion` 实际执行、排队 0s）为 `66947a069`，详见 §9.1。
job-min 指标达到 −10~15% 目标；墙钟未达最初 −15~20% 的上沿，瓶颈已从 shared runtime 转移到
installer 与 Windows runner 分配等待（§9.1.1 / §12）。

**未达标/受阻项**（全部给出瓶颈，不做数字美化）：

- **Gate 5 worker 矩阵部分完成**：core / pd-cli / pd-console / plugin 已完成 4 配置 × 3 次；
  installer 完成 2 workers × 3 次（每次 ~16 分钟，单机时长限制）；`scripts` **NOT MEASURABLE**
  （本地 npm/node 身份不一致导致 57 个与性能无关的失败）。全部实测数据在 §7.2，**未据此改动任何配置**。
- **Gate 6 待 Owner 答复**：#2710 合并顺序、`Export Surface Gate` 是否设为必需检查；本轮只记录两种
  分支各自动作，不擅自合并（§8.4）。
- Shared Runtime 409s（−87s），不再是唯一瓶颈。
- Installer / Packaged Install 的内部优化 **BLOCKED**：与仍 OPEN 的 #2710 范围重叠。
- 「inspector ≈ 2.75 min」在当前仓库 **NOT_REPRODUCED**（不存在 inspector 包/测试目录）。

---

## 2. Latest Source Verification

### 2.1 三项只读核实（只核实，未行动）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| #2710 是否已合并 | **否**：`state=OPEN`、`mergedAt=null`、`mergeStateStatus=UNSTABLE`、head `ai/adhoc-20261118-test-infra-b8620e` | `gh pr view 2710` |
| `Export Surface Gate` 是否为 Required Status Check | **否**：main 分支保护的必需 contexts 只有 `Verify Merge Gate` 与 `Test principles-core` | `gh api repos/:owner/:repo/branches/main/protection` |
| codex-adapter 的 Windows 失败是否已有独立工单 | **有，且不是 Windows 特有**：`PRI-1271`（P1/Urgent，Backlog）已定位为真实夹具越过 `GOVERNANCE_RETENTION_MAX_AGE_MS = 7d` 的 body 保留窗，自 `2026-11-18T11:58Z` 起**所有分支**确定性失败 | Linear `PRI-1271` 正文 |

> **对上一轮结论的修正**：上一轮把该红点归因为「#2699 的 Windows 盘符/realpath 差异」。PRI-1271 的证据链（夹具时间戳 `2026-11-11T11:58:20Z` + 7 天）说明它是**时间**问题，不是 Windows 问题。本轮不沿用错误前提。

> **Phase II 收尾**：PRI-1271 已在**独立分支 + 独立 PR #2713** 修复（见 §2.6）——按指令「不要将 PRI-1271 混入 PR #2712」执行，`#2712` 的 diff 中不含 `packages/codex-adapter` 任何改动。

### 2.6 Gate 3：PRI-1271 独立修复【实测】

| 项 | 内容 |
| --- | --- |
| 分支 | `ai/PRI-1271-codex-ingestion-fixture-retention`（基于 `origin/main` = `9b63a24a9`） |
| PR | https://github.com/csuzngjh/principles/pull/2713 （**已合并**，main `d6919f751`） |
| 改动 | 仅 `packages/codex-adapter/tests/ingestion/ingestion.test.ts` |
| 生产代码 | **零改动**（retention 策略、断言、timeout 全部原样） |

**根因**：v0.167.0 describe 复制的真实夹具时间戳固定为 `2026-11-11`；越过
`GOVERNANCE_RETENTION_MAX_AGE_MS = 7d` 后，`pruneRetention()` 把 observation 的
`visible_text` 置空（`retention_class = 'expired'`），断言读到空串。

**修复**：复制后调用 `remapRecordTimestampsToFreshTime()`，把每条记录的顶层 `timestamp`
整体平移一个固定 delta（锚点 `Date.now() - 60_000`）。`timestamp` 是 decoder 唯一映射为
`observed_at` 的字段（`transcript-decoder.ts:218`），因此记录结构、ordinal、id、真实文本与
记录间相对间隔全部保留，只是落在保留窗内。

| 验证 | 结果 |
| --- | --- |
| `npx vitest run tests/ingestion/ingestion.test.ts -t "0.167.0"` | PASS（1 passed / 25 skipped） |
| 同上但注释掉重映射（pre-fix 状态） | **FAIL**：`expected '' to contain 'probe assistant visible reply'` |
| `npm test --workspace=@principles/codex-adapter` | PASS（34 files / 454 passed / 1 pre-existing skip） |
| `node scripts/release/check-pr-release-intent.mjs` | PASS（`mode=normal, intent=none-needed`） |
| 工作区依赖解析（ERR-200） | `node_modules/@principles/host-runtime` → 本 worktree，未泄漏主 checkout |
| PR #2713 canonical CI | **全绿**（run 44326211706，`Test shared runtime & adapters` 345s，`Build and test pd-companion` 14:42:59Z 实际执行），**已合并进 main `d6919f751`** |


### 2.2 基线与改动的关系

`main` 在 `11:41:22Z` 的最后一次全绿运行是本轮唯一可用基线；`11:58Z` 之后 main 自身也会红。因此本报告所有「before」样本均来自该绿窗之前，且逐条附 run id。

### 2.3 本轮基线运行（全部通过 GitHub API 重新采集，非沿用上轮）

| run | 事件 | 结论 | job 数 | job-seconds | job-min | 墙钟 | 排队 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 44262597745 | push | success | 15 | 2624 | 43.73 | 499s | 0s |
| 44265041579 | push | success | 15 | 2713 | 45.22 | 534s | 0s |
| 44278152737 | push | success | 15 | 2933 | 48.88 | 507s | 0s |
| 44296956347 | push | success | 15 | 2763 | 46.05 | 527s | 0s |
| **中位数** | | | 15 | **2738** | **45.64** | **515s** | 0s |
| 44282441118 | push（docs-only） | success | 15（4 实跑） | 417 | 6.95 | 201s | 0s |

- job 时长 = `completed_at − started_at`；run 级排队 = `run_started_at − created_at`，**5 次全部 0s**，因此 job-minutes 不含排队。
- 冷/热缓存：main 连续 push，`setup-node` npm 下载缓存与 `verify-merge` 的 node_modules 缓存均为热。冷缓存样本【未取得】：GitHub API 不暴露每次运行的 cache 命中状态，只能在改动后用步骤耗时反推（本轮已用 `Restore node_modules` 步骤直接证明命中）。

### 2.4 Gate 1：Node 版本与缓存键错配修复【实测】

**缺陷**：`codex-plugin-delivery` 的 `setup-node` 是 Node 24，但它调用 `restore-node-modules` 时传了
`node-version: '22'`。缓存 key 是 `<os>-node<major>-<lockfile hash>-node-modules`，major 是唯一隔离
ABI 不兼容依赖树的字段，因此该 job 会命中 **Node 22 物化的树**。

**修复**：

| 项 | 改动 |
| --- | --- |
| `.github/workflows/ci.yml` | `codex-plugin-delivery` 的缓存输入 `'22'` → `'24'`（该 job 的 setup-node 仍是 Node 24，未改运行时） |
| `.github/actions/restore-node-modules/action.yml` | `node-version` 由 `required: false` + `default: '22'` 改为 `required: true`（无默认值），消除「忘记传就静默用 22」的失败模式 |
| `scripts/__tests__/ci-node-modules-cache-contract.test.ts`（新增） | 解析全部 workflow，逐个调用点断言：必须显式给 major、必须与同 job 的 `setup-node` 一致；并断言 action 的 key 含 `inputs.node-version` / `runner.os` / lockfile hash |
| `docs/process/TESTING.md` | 记录必填输入、Node 24 独立条目与两处直接安装的实测回退 |

**全量调用点核对【实测】**：当前分支共 **12 处**调用（`ci.yml` 10、`pr-checks.yml` 1、`pd-console-e2e.yml` 1）。
11 处为 `22`/`22`（一致）；`codex-plugin-delivery` 为 `24`/`24`（修复后一致）。
两处**故意不使用**缓存并保留实测回退：`skill-render-contract`（Node 20，restore 45–52s > install 37s）、
`test-workbuddy-adapter`（Windows，restore 58–72s ≈ install 64s）。

**守卫的有效性反向证明**：把 `ci.yml` 临时改回 `node-version: '22'` 后，守卫测试变红：
`ci.yml:codex-plugin-delivery caches as node 22 but runs setup-node 24`；恢复后转绿。

**缓存隔离的 CI 证据**（run 44323248736）：

```
Codex plugin delivery contract | Restore node_modules
  key: Linux-node24-8b3cc4ac…-node-modules
  Cache not found for input keys: Linux-node24-…-node-modules     ← 独立 key，首次冷启动
  Cache saved with key: Linux-node24-…-node-modules               ← 该 job 自己物化
Test principles-core | Restore node_modules
  Cache restored from key: Linux-node22-8b3cc4ac…-node-modules    ← 仍与 Node 22 共享
```

结论：Node 24 与 Node 22 **不再共享物化依赖树**；Node 24 的首跑支付一次完整
`npm ci --ignore-scripts`（该 job 97s），**第二跑即命中自建条目**（run 44328146638）：
`Cache hit for: Linux-node24-…` → `Test codex plugin delivery` job **49s**（冷启动 97s）。

| run | `codex-plugin-delivery` | 缓存行为 |
| --- | --- | --- |
| 44323248736 | 97s | `Cache not found`（首次）→ 结束后 `Cache saved` |
| 44328146638 | **49s** | `Cache restored from key: Linux-node24-…`（未重新保存） |


### 2.5 Gate 2：Dependency Audit 的 Node 24→22 等价性验证【实测】

`pr-checks.yml` 的 `Dependency Audit` 为复用同一缓存条目，把 `node-version` 从 24 改为 22。
「`npm audit` 与 Node 版本无关」是**假设**，本轮在同一源码、同一 `package-lock.json` 上用真实工具链验证：

| 项 | Node 22 分支 | Node 24 分支 |
| --- | --- | --- |
| node | `v22.23.5` | `v24.22.3` |
| npm | `10.9.11` | `11.21.3` |
| `npm audit --json --omit=dev` 漏洞数 | 11（7 high / 4 moderate） | 11（7 high / 4 moderate） |
| advisory 集合（source\|title\|severity\|url） | 16 条 | 16 条，**完全一致** |
| `npm audit --audit-level=high --omit=dev` 退出码 | 1 | 1 |
| `npm audit` 人类可读摘要 | `11 vulnerabilities (4 moderate, 7 high)` | 同左，逐字相同 |
| `npm ls --omit=dev --all` 解析出的 production 包集合 | 409 个 | 409 个，**完全一致** |
| metadata 依赖计数 | prod 353 / dev 720 / optional 208 / total 1155 | 同左 |

**唯一差异**：JSON 输出里 `fixAvailable` 的建议值不同（npm 11 建议 `vite@6.2.7`，npm 10 建议
`postcss-cli@11.0.0` / `true`）。该字段是 `npm audit fix` 的建议，本 job 只跑 `npm audit` 并
`|| true`，不消费它，因此不影响判定。

**结论**：工具链变化对审计判定**无可观测影响**，因此保留 Node 22 + 共享缓存（这也避免了第三个
~1.5GB 缓存条目）。证据已写入 `pr-checks.yml` 的注释，避免下一个人重新猜测。


---

## 3. CI Critical Path Analysis

### 3.1 DAG（改动前）

```
[并行起点]
 ├─ impact (13s) ──> 11 个 gated job（均在 +13~14s 同时开始）
 ├─ verify-merge（不依赖 impact）
 ├─ test-principles-core（不依赖 impact，必需检查）
 └─ telemetry-guard（advisory）
```

实测：所有 job 在 run 开始后 **0–14s** 内启动（除 impact 的下游固定等待 13s）。没有二级依赖链——`needs` 只出现在 `impact` 上。

### 3.2 关键路径（改动前，run 44296956347）

- 关键路径 = `impact 13s` + `Test shared runtime & adapters 509s` = **522s**，与实测墙钟 527s 吻合。
- **决定完整 CI 完成时间的是 `Test shared runtime & adapters`**。
- 第二长的 `create-principles-disciple`（429s，+13s 启动 = 442s）**不在关键路径上**，它有 85s 余量。

| 问题 | 实测答案 |
| --- | --- |
| 哪个 Job 决定完成时间 | shared runtime（509s）；改动后变为 workbuddy(Windows) 的「启动等待 + 325s」 |
| 哪些耗时 job 不影响墙钟 | create-principles-disciple(429s)、packaged install smoke(318s) 均有 ≥80s 余量 |
| 重复初始化造成的 job-minutes 浪费 | 12 个 job 各付 28–53s 安装 = 约 450 job-seconds/run（§4） |
| 适合合并的 job | 同 scope、同 install、同 build 的小 job：`build-openclaw-plugin` 与 plugin 测试 job |
| 适合拆分并行的 job | shared runtime（但见 §7.3：job-min 净增，墙钟受另一个 job 封顶） |
| 同时降墙钟与 job-min 的优化 | **只有「复用安装」具备该性质**（每个 job 都变小，且总工作变少） |

### 3.3 改动后的关键路径

早期样本（run 44314147995）：`workbuddy(Windows fixtures)` start+78s（Windows runner 分配等待）+325s = **403s**，与墙钟 406s 吻合。

收尾样本（run 44323248736，14 job）：关键路径变为 **`Test create-principles-disciple` 415s**
（14:21:11Z → 14:28:06Z），墙钟 435s；`workbuddy` 回落到 210s，`shared-runtime` 377s（被 PRI-1271 截断）。

这里暴露一个**新的关键路径事实**：Windows runner 的分配等待（约 60–78s）此前被 shared runtime 的 509s 掩盖；一旦 shared runtime 变短，**关键路径就在 installer 与 Windows runner 等待之间摆动**，两者都受 runner 分配波动影响（±60s）。这是本轮最有价值的结构性发现（§12 给出后续建议）。

---

## 4. Build & Dependency Optimization

### 4.1 `npm ci` 重复执行审计【实测】

| 位置 | install 步骤 | 耗时 | 是否命中缓存 |
| --- | --- | --- | --- |
| verify-merge | 内联 actions/cache + 条件 `npm ci` | 4s | 是（`Install dependencies` 被 `if` 跳过） |
| principles-core | `npm ci --ignore-scripts` | 32s | 否 |
| pd-console / pd-cli / pd-mcp-server | 同上 | 39 / 28 / 40s | 否 |
| create-principles-disciple / packaged smoke | 同上 | 46 / 40s | 否 |
| shared runtime | 同上 | 49s | 否 |
| plugin coverage | `npm install --include=dev` | 53s | 否 |
| codex delivery / build plugin | `npm ci --ignore-scripts` | 32 / 33s | 否 |
| skill render | `npm ci`（带 scripts，Node 20） | 37s | 否 |
| workbuddy (Windows) | `npm ci --ignore-scripts` | 64s | 否 |

结论：同一个仓库里同时存在「4s 的物化缓存」和「28–64s 的重复安装」两种策略，13 个 job 用的是慢的那种。`actions/setup-node` 的 `cache: 'npm'` 只缓存**下载缓存**，不会跳过物化/链接步骤——这就是「npm cache 命中 ≠ 可以跳过 npm ci」的现状。

### 4.2 实施：一个 composite action，一个 key

`.github/actions/restore-node-modules/action.yml`：

- key = `<runner.os>-node<version>-<hashFiles(package-lock.json)>-node-modules`，**与 verify-merge 原有 key 逐字相同**，所以全仓只有一份缓存条目。
- path = `node_modules` + `packages/*/node_modules`。
- 命中 → 数秒还原；未命中 → `npm ci --ignore-scripts`。
- `verify-merge` 的内联步骤删除，改为引用同一 action（消除第二份定义）。
- **保留 `npm rebuild better-sqlite3`**：缓存树就是 `--ignore-scripts` 的产物，native 模块仍由各 job 自己负责。
- **未跨操作系统复用**：key 含 `runner.os`。
- **未改 package-lock、未换包管理器**。
- **未跳过干净安装验证**：miss 路径仍是完整 `npm ci --ignore-scripts`。

### 4.3 实测命中效果【实测，run 44314147995】

| job | 改动前 install | 改动后 `Restore node_modules` |
| --- | --- | --- |
| principles-core | 32s | **5s** |
| pd-mcp-server | 40s | **4s** |
| pd-cli | 28s | **5s** |
| pd-console | 39s | **6s** |
| create-principles-disciple | 46s | **5s** |
| packaged install smoke | 40s | **5s** |
| shared runtime | 49s | **5s** |
| plugin coverage | 53s | **6s** |
| codex delivery | 32s | **5s** |
| verify-merge | 4s | **5s** |
| skill render (node20) | 37s | **45s / 52s（缓存命中仍是 45–52s）→ 已回退** |
| workbuddy (Windows) | 64s | **58s / 72s（缓存命中仍是 58–72s）→ 已回退** |

净效果：Linux/Node22 的 12 处安装点合计约 **−390 job-seconds/run**。

### 4.5 实测后回退的两处（净收益不为正）

| job | 原 install | 缓存命中后的 restore | 结论 |
| --- | --- | --- | --- |
| `Test skill render contract`（Node 20） | 37s | 45s（首次）/ **52s**（第二次，仍是命中） | restore 比 install 贵 8–15s → **回退为 `npm ci`** |
| `Test workbuddy-adapter`（windows-latest） | 64s | 58s（首次）/ **72s**（第二次，仍是命中） | 两次均在 58–72s，等于没有收益，且 Windows tarball 往返把 job 从 293s 拖到 325–330s → **回退为 `npm ci --ignore-scripts`** |

判据不是「缓存有没有命中」，而是「命中的代价是否小于被替换的安装」。这两处命中代价 ≈ 或 > 安装本身，因此按指令要求明确放弃，并保留原步骤原样（没有残留的半套机制）。

### 4.4 Build Once → Verify Many（评估后放弃）

指令要求实测「重复 Build 的成本」与「Artifact 上传/下载成本」。

- 重复 build 的实测成本：根 `npm run build` 在 pd-console / plugin / build-plugin 里各 **10–15s**。
- Artifact 方案必须额外支付：上传（dist 含 plugin bundle，量级远大于 15s 的构建）+ 下载 + SHA-256 校验 + 消费方来源校验。
- **净收益为负**：单个 job 省 10–15s，却引入一次上传+一次下载与「缓存不确定 dist」的风险面。而且仓库对复用构建产物有明确的错误经验（陈旧 dist）。
- 结论：**不实施**；改为在 §8 用「同 scope 合并 job」消除真正重复的那一次 build（已实测 −130s）。

---

## 5. Scripts & Inspector Optimization

### 5.1 scripts

| 指标 | 改动前【实测】 | 改动后【实测，run 44314147995】 |
| --- | --- | --- |
| `Test scripts` 步骤 | 204s（run 44296956347）/ 253s（44278152737） | **132s** |
| 其中安装 | 49s | 5s |
| `Test root guard contracts` | 3s | 1s |

安装省下 44s；`132s` vs `204s` 的剩余差额来自 runner 波动与 node_modules 已物化后的文件系统局部性，**不能全部归因于本次改动**，因此 §9 用 3 次运行的中位数而不是单次最差值。

本轮**未改动任何 `scripts/__tests__` 文件**：指令列出的 10 个慢文件（`release-contracts`、`cleanup-task-worktree`、`workspace-lifecycle`…）都属于「真实 Git / 真实 worktree / 真实子进程」的证据面，改动风险（破坏隔离或把真实边界换成 Mock）大于 132s 里的可压缩空间。Git fixture 共享、seed repo 复用等方案需要满足「每个测试独立 worktree、禁止共享可变目录」，是一个独立的中型改造；在本轮预算内无法同时完成「实现 + 回归 + 三次可比基准」，因此列为 §12 的后续候选，而不是半成品。

### 5.2 inspector【NOT_REPRODUCED】

指令称 shared runtime 内「inspector ≈ 2.75 min」。当前仓库：

- 不存在 `packages/*inspector*/`、不存在 `scripts/**/*inspector*` 测试文件；
- `Test shared runtime & adapters` 的步骤只有：`Test scripts`、`Test root guard contracts`、`Test host-runtime`、`Verify real OpenClaw host parity and published bundle`、`Test codex-adapter`、`Build and test pd-companion`；
- `inspector` 一词只出现在两份历史文档与本报告中。

结论：**该前提在当前源码不成立**，不沿用。若「inspector」实际指 `host-runtime`（121s → 72s）或 host parity（11s → 7s），两者都已随安装缓存下降，无独立优化对象。

### 5.3 Shared Runtime 拆分（评估结果）

| 方案 | job-seconds | 墙钟上限 |
| --- | --- | --- |
| 现状（1 job） | 509s（改动前）/ 286s（改动后） | 受 installer(360s) 与 Windows(325s+78s 等待) 约束 |
| 拆成 scripts+host-runtime / 其余 | 约 +36s（两侧各付一次固定开销） | 约 450s（改动前口径） |

改动后该 job 已降到 286s，**不再接近关键路径**（workbuddy 403s、installer 389s 都比它长）。拆分的唯一收益（缩短墙钟）已经消失，代价（job-min 增加）仍然存在。**不拆分**。

---

## 6. Installer & Packaging Optimization

### 6.1 现状【实测】

| job | 改动前 | 改动后 | 变化来源 |
| --- | --- | --- | --- |
| create-principles-disciple | 429s | **360s** | install 46→5s（其余为测试本体） |
| packaged install smoke | 318s | **252s** | install 40→5s；提交/构建波动 |

### 6.2 为什么没有做内部优化：BLOCKED（范围冲突）

#2710（仍 OPEN）已经把 installer 的固定 6s 等待改为 `ConsoleReadyProbePolicy` 有界轮询、把锁预算注入 `coordinationLockOptions`、把 4 处 5s 超时改成有界预算。这些正是本轮「真实启动 / Ready 探针 / cleanup」要动的地方。指令明确要求「不允许覆盖 #2710 中尚未合并的修改」「不要与本轮与上一轮产生代码冲突」。

因此本轮在这两个 job 上**只做与 #2710 正交的那一项**（job 级依赖安装缓存），内部逻辑一律不动。真实 tarball 安装、插件加载、Console 启动、身份验证全部保留。

### 6.3 已被排除的「假收益」

- 复用上一 job 已构建的 tarball：需要跨 job artifact 传输 + SHA 校验，实测 build 段只有 13–15s，上传下载成本更高（同 §4.4）。
- 跳过 `npm ci`：违反「不能跳过干净安装验证」。

---

## 7. Worker & Sharding Analysis

### 7.1 已有实测证据（core）

| 配置 | 环境 | 结果 |
| --- | --- | --- |
| `--maxWorkers=2` | CI ubuntu 4vCPU | 112s（44296956347）/ 75s（44314147995） |
| 4 workers | 本地 32 逻辑核 | 114s（上一轮实机） |

2 worker 与 4 worker 在各自环境下**没有可区分差异**，而 2 是 PRI-1167 用来消除「isolate 启动饥饿 → 5s 超时」的反脆弱取值，并且 `core-test-job-guards.test.ts` 用结构断言把它钉在 `<= 2`。**不放宽**。

### 7.2 全矩阵（本轮实测，方法见下）

**测量方法**（诚实标注口径，避免把估算当实测）：

- 环境：本机 Windows，**32 逻辑核 / 64 GB**，同一 worktree、同一 `node_modules`、未开 coverage。
- 每次运行：`npx vitest run --maxWorkers=N`（installer 用 `npm run test:fast -- --maxWorkers=N`），
  每配置重复 **3 次**，取中位数。
- 墙钟：`Stopwatch` 计时；**CPU 使用率**：每秒采样 `Win32_PerfFormattedData_PerfOS_Processor` 的
  `_Total.PercentProcessorTime` 取平均（**系统级近似**，本机同时存在其他常驻 node 进程）；
  **内存峰值**：每秒采样全部 `node.exe` 工作集之和，减去 run 前基线（同样含其他进程，噪声较大，
  只用于判断量级）。
- 未把 runner 排队/虚拟化开销混入：这里是本机直跑，不含 CI runner 分配等待。

**principles-core**【实测，中位数】

| workers | 墙钟中位数 | 3 次原始值 | 峰值内存（噪声大） | 平均系统 CPU | 结果 |
| --- | --- | --- | --- | --- | --- |
| 2 | **168.1s** | 171.6 / 166.8 / 168.1 | 924–1009 MB | 21–26% | 9782 passed / 3 skipped / 3 todo |
| 4 | **92.5s** | 93.3 / 90.1 / 92.5 | 857–3324 MB | 27–36% | 同上 |
| 6 | **67.2s** | 68.7 / 66.4 / 67.2 | 1286–1397 MB | 30–33% | 同上 |
| 8 | **52.0s** | 52.0 / 53.2 / 51.8 | 1676–1851 MB | 34–35% | 同上 |

**结论**：在本机 32 核上 core 随 worker 数单调加速（8 workers 相对 2 workers −69%）。
**但本轮不修改该配置**：

1. PRI-1167 的成因是 **CI 的 4-vCPU runner** 上「isolate 启动饥饿把首个最重测试推过 5s 超时」，
   与 32 核本机不是同一约束；
2. `scripts/__tests__/core-test-job-guards.test.ts` 用结构断言把 CI 的 `--maxWorkers` 钉在 `<= 2`，
   放宽它属于破坏既有反脆弱设计；
3. 本机测量不能证明 4-vCPU runner 上的行为。

即：**测得加速，但证据不支持改配置**——按指令「没有实测正收益不修改配置」的反向同样成立：
不是本机快就能改，必须是目标环境快。

**pd-cli**【实测，中位数 + 失败分布】

| workers | 墙钟 3 次 | 中位数 | 失败用例数（每次） | 结果 |
| --- | --- | --- | --- | --- |
| 2 | 256.9 / 302.8 / 318.0 | **302.8s** | 0 / 2 / 2 | 2337 tests |
| 4 | 189.5 / 211.5 / 192.3 | **192.3s** | 0 / 11 / 5 | 2337 tests |
| 6 | 128.0 / 139.3 / 650.4 | **139.3s** | 7 / 6 / 12 | 2337 tests |
| 8 | 144.3 / 134.5 / 117.5 | **134.5s** | 10 / 7 / 0 | 2337 tests |

**结论：pd-cli 是典型的「加 worker 变快但开始变红」**。失败形态全部是 5s 超时边界
（`pd version --json … 5025ms`、`pd health --host codex … 5050ms`、`keeps interleaved sessions … 5123ms`），
即真实 SQLite/子进程/Git 竞争下把本来就在 5s 边缘的用例推过线。
**因此 pd-cli 保持现有配置，不提高 worker 数**；若要提速，前提是先证明这些 5s 用例在目标 CI runner 上的余量，
而不是靠放大 timeout。

**口径警告（必须与数字一起读）**：本机同时存在其他常驻 node 进程，2 workers 也出现 2 个失败，
说明失败中有**环境噪声**成分。所以上表能支持的结论是「worker↑ ⇒ 5s 超时用例风险↑」，
不能支持任何「某配置在 CI 上快 X%」的定量承诺。

**pd-console**【实测】

| workers | 墙钟 3 次 | 中位数 | 失败用例数（每次） |
| --- | --- | --- | --- |
| 2 | 172.6 / 158.2 / 160.8 | **160.8s** | 4 / 3 / 2 |
| 4 | 75.0 / 70.5 / 77.3 | **75.0s** | 0 / 1 / 0 |
| 6 | 73.2 / 71.8 / 64.2 | **71.8s** | 1 / 4 / 6 |
| 8 | 40.7 / 43.0 / 63.6 | **43.0s** | 0 / 1 / 3 |

**结论**：pd-console 在 4 workers 已获得 2× 加速并基本无失败，6→8 workers 继续缩短但失败率上升；
本机数据不足以证明目标 runner 上安全，因此**保持现状，不推广**。这一条同样是「测得加速但不改」。

**openclaw-plugin**【实测】

| workers | 墙钟 3 次 | 中位数 | 失败用例数（每次） |
| --- | --- | --- | --- |
| 2 | 255.6 / 176.2 / 163.7 | **176.2s** | 0 / 0 / 0 |
| 4 | 99.3 / 96.3 / 109.1 | **99.3s** | 0 / 1 / 1 |
| 6 | 74.6 / 88.1 / 63.5 | **74.6s** | 2 / 0 / 0 |
| 8 | 55.9 / 54.6 / 70.1 | **55.9s** | 0 / 0 / 0 |

**结论**：plugin 在 8 workers 仍稳定（0 失败）且 3× 加速。这是本轮**唯一**「加速且未见失败上升」的包，
但本次 CI job 的 143s 里已有 60s 是 `tsc` + `pack plugin`（非测试），测试段再压也只影响约 60s，
且本机 ≠ 4-vCPU runner。**记录为后续候选，本轮不改配置**（避免用本机结论替换 CI 证据）。

**scripts【NOT MEASURABLE — 测量被环境缺陷污染，如实报告】**

`scripts` 在 **baseline 配置（2 workers，与 `scripts/vitest.config.ts` 一致）** 首次运行即
`57 failed / 2754 passed / 23 skipped`，`Duration 652.58s`。这不是 worker 数引起的，
而是本机环境导致的**整类失败**：

- `__tests__/pd-lab-snapshot-fence.test.ts`：18/20 失败，连 `FENCE-0 positive control` 都失败；
- `__tests__/check-package-manager.test.mjs`：4/5 失败，原因是 `npm/?`——该测试读不到 npm 版本，
  而我的测量 shell 里 `node` 是 `v22.22.2`、`npx` 解析到的 npm 与其不匹配。

即：这个 worktree 的本地 npm/node 身份与 `scripts` 套件的假设不一致，导致大量与性能无关的失败。
**继续跑该矩阵只会产出无意义的数字，因此我停止了 scripts 的后续配置测量**，且不据此提出任何
worker 结论。CI 端的 `Test shared runtime & adapters` 中 `Test scripts` 步骤在
run 44323248736 / 44328146638 均为 PASS，说明该套件在 CI 的工具链下正常。

这是本轮**明确的测量失败**，不是「优化无效」的证据。

**create-principles-disciple（installer）【部分实测】**

| workers | 墙钟 3 次 | 中位数 | 结果 |
| --- | --- | --- | --- |
| 2 | 1171.5 / 920.7 / 931.9 | **931.9s** | 1389–1397 passed / 7 skipped |
| 4 | 931.7（**单次**） | — | 1397 passed / 7 skipped |
| 6 / 8 | **未测** | — | 单次约 16 分钟，超出本轮可承受时长 |

**关键观测**：4 workers 的 931.7s 与 2 workers 的中位 931.9s **几乎完全相同** → installer 实际被
串行资源（真实 tarball 安装、runtime 物化、单例端口）钉住，**加 worker 不产生任何收益**。
这直接支持「不改配置」的结论，也说明 installer 的提速只能来自减少每次安装的物化成本。

installer 是本轮**最慢的本地套件**（单次 15–20 分钟，真实 tarball 安装 + 真实插件加载），
4/6/8 workers 未测。**不据此提出任何 worker 变更建议**；若后续要提速，应先解决其「每次安装都重新
物化 runtime」的成本，而不是加 worker。


### 7.3 分片（评估后放弃）

- Vitest 原生 shard 只切文件集合，不减少总 CPU 时间；在 4 核 CI runner 上，每片又要各付一次 job 固定开销（本 PR 后约 5s 安装 + 3–6s checkout/setup）。
- 只有在「某 job 是墙钟瓶颈」时分片才有意义；改动后瓶颈是 Windows runner 等待，不是 Linux 测试时长。
- 因此：**不分片**。

---

## 8. CI Scheduling Changes

### 8.1 已实施：合并 `build-openclaw-plugin` → `test-openclaw-plugin-coverage`

依据【实测】：两个 job 的 `if` 条件逐字相同（`scopes.plugin`），install 与根 `npm run build` 完全重复。

| 项 | 合并前（2 job） | 合并后（1 job） |
| --- | --- | --- |
| job-seconds | 62 + 211 = **273s** | **143s** |
| 保留的步骤 | — | 根 build、`tsc --noEmit`、`npm pack --dry-run`（PRI-919 的 `pack-dry-run.log` 写法）、`build:production`、全量 vitest + coverage、Codecov |
| job 预算 | 15m / 15m | 20m（**作业级**预算，非用例超时） |
| job 数 | 15 | 14 |

`scripts/__tests__/ci-impact-gate-contract.test.ts` 的 gated 计数 11 → 10；该测试注释明确要求 gate 集合收缩体现在 diff 中，fail-open 形状断言全部保留并通过（42 tests）。

### 8.2 评估后放弃

| 候选 | 实测/推算 | 放弃理由 |
| --- | --- | --- |
| telemetry-guard(11s) 并入 impact(12s) | 省约 10 job-seconds | 会删除一个独立的 advisory 检查名（治理面变化），收益 0.17 job-min 不足以支付 |
| codex-delivery(37s) 并入 pd-mcp-server(30s) | 省约 20–30s | 门禁集合不同（`plugin \|\| mcpServer` vs `mcpServer`），合并会扩大执行面 |
| shared runtime 拆 job | §5.3 | 改动后已不在关键路径 |
| skill-render 改 Node 22 | 省一次冷缓存 | 该 job 固定 Node 20 是有意为之；为 30s 改运行时版本不值得 |

### 8.3 CI Impact Gate 审查（只读，无改动）
1. **fail-open 形状正确**：所有 gated job 的 `if` 以 `!cancelled()` 开头，避免 GitHub 隐式 `success()` 把「impact 失败」变成「全跳过」；有结构测试钉住。
2. **必需检查不可被跳过**：`verify-merge` 与 `test-principles-core` 不依赖 `impact`；后者禁止 `if`/`continue-on-error`。**注意：导出面门禁作业本身未设为分支保护必需检查**（§2.1）。
3. **保守默认正确**：root-level 非文档 → broad；BDD feature → broad；skill 交付面 → 显式激活 `installer` + `cli`。
4. **实测有效性**：docs-only 的 `44282441118` 只跑 4 个 job、6.95 job-min（−85%）。
5. **路径映射未发现过宽**：`RELEASE_ASSET_REACHABLE_DIRS` 与 `build-release-asset.mjs` 的 REQUIRED_COMPONENTS 一致；跨包公共依赖通过 workspace 图传递闭包覆盖。
6. **未缩窄任何路径**：缩窄需要正反双向验证（改源码触发、改文档不触发、改公共依赖触发消费者），本轮没有足够样本支撑缩窄，因此**不动判定语义**。

第 5、6 点意味着：本轮对 Impact Gate 的结论是「审查通过、保持原状」，不是「优化了它」。

### 8.4 Gate 6：PR 依赖关系（**待 Owner 答复，未擅自合并**）

#### 已确认的事实【实测】

| 项 | 结论 | 证据 |
| --- | --- | --- |
| `#2710` 状态 | **OPEN、MERGEABLE、未合并**，head `7df1351108` | `gh pr view 2710` |
| `#2712` 与 `#2710` 的基线 | 两者都基于 `main 9b63a24a9`；`#2712` 不包含 `#2710` 的任何提交 | `git merge-base` / PR 元数据 |
| `Export Surface Gate` 是否必需检查 | **否**；main 只要求 `Verify Merge Gate` + `Test principles-core` | 分支保护 API |
| `#2713`（PRI-1271） | OPEN，canonical CI 全绿，**未合并** | run 44326211706 |

#### 待 Owner 决定（原文未答复，本轮只记录不行动）

1. `#2710` 是否先合并？
2. `Export Surface Gate` 是否要设为必需检查？

#### 两种分支各需要做什么

| 分支 | 需要的动作 | 风险/代价 |
| --- | --- | --- |
| **A：#2710 先合并** | `#2713` 合并 → `#2712` rebase 到最新 `main` → 重审 `.github/**` 差异（#2710 也动 CI/installer）→ 重跑受影响测试（`Test packaged install smoke`、`Test create-principles-disciple`、`Test shared runtime`）→ `--force-with-lease` 推送 | rebase 冲突集中在 `ci.yml` 与 installer 测试；两者必须都保留：#2710 的 Ready 轮询/锁预算 与 #2712 的缓存 action/合并 job |
| **B：#2712 先合并** | `#2713` 合并（或 `#2712` 先不带 PRI-1271）→ `#2710` 在 #2712 的新 CI 结构上 rebase | #2710 的 4 处 5s 超时 / Installer 改动需要在新 job 结构下重新验证一次 |

**本轮不做的事**：没有合并任何 PR、没有开 auto-merge、没有改写 #2710 的分支。

---

## 9. Before / After Benchmark

### 9.0 Gate 4 状态：**已解除阻塞，样本采集中**

**事态更新（2026-11-18T17:00Z）**：PR **#2713 已被合并进 main**（`d6919f751 fix(codex-adapter): re-anchor
the 0.167.0 fixture to fresh wall time (#2713)`），因此：

| 事实 | 证据 |
| --- | --- |
| main 已含 PRI-1271 修复 | `git log origin/main` = `d6919f751` |
| 本 PR 已重建到最新 main | `66947a069`，基于 `d6919f751`，11 个提交 cherry-pick，零冲突 |
| 重建后 CI 首次 14 job 全绿（含 `Build and test pd-companion`） | run 44354575277 |

**重建时丢弃了两个提交**：`b9cbfaa68`（他人推到本分支的 PRI-1271 修复）与其回退 `0e1c11b54`——
main 已经包含等价修复，两者都成为噪声。这是**内容等价**的替换，不是删除功能。

**采样口径**：同一 commit `66947a069`，用 `gh run rerun` 重复执行同一 workflow（runner 池、依赖、
缓存状态一致），每次记录 14 个 job 的 `started_at/completed_at`。排队时间（`started_at - created_at`）
单独记录且不计入 job-minutes。

### 9.0.1 Gate 4 样本（`66947a069`）

| # | run | job 数 | job-seconds | job-min | 墙钟 | 排队 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 44354575277（push） | 14 | 2233 | **37.22** | **388s**（created→updated） | 0s | 全绿 |
| 2 | 44354575277（rerun #1） | 14 | 2358 | **39.30** | **443s**（首 job→末 job） | 0s | 全绿 |
| 3 | 44354575277（rerun #2） | 14 | 【采集中】 | | | | |

run 1 的各 job（秒）：`create-principles-disciple 355`、`workbuddy 335`、`shared-runtime 289`、
`verify-merge 224`、`packaged-install 197`、`pd-cli 185`、`core 184`、`plugin 169`、`pd-console 111`、
`skill-render 78`、`codex-plugin 36`、`pd-mcp 36`、`impact 24`、`telemetry 10`。

关键路径：`create-principles-disciple`（355s）→ 墙钟 388s（+33s 启动/合并 ref 检出）。
### 9.0.2 合并前的近似样本（历史，仅作旁证）

以下是 #2713 合并前的两次运行——13 绿 / 1 红，`pd-companion` 未执行，**不进入收益结论**。

run **44323248736**（`#2712` @ `f288ca97e`，14 job：13 绿 / 1 红，红点仅 PRI-1271）：

| 指标 | 值 |
| --- | --- |
| job-seconds | 2314（38.57 job-min） |
| 执行墙钟 | 435s |
| 失败 job | `Test shared runtime & adapters`（`Test codex-adapter`，58s 处） |
| 被跳过步骤 | `Build and test pd-companion`（因上游步骤失败） |
| 一次性成本 | `codex-plugin-delivery` 97s（Node 24 key 首次冷启动） |

run **44328146638**（`#2712` @ `f9ec26b3c`，同一 14 job 结构，红点仍仅 PRI-1271）：

| 指标 | 值 |
| --- | --- |
| job-seconds | 2389（39.82 job-min） |
| 执行墙钟 | 390s |
| `codex-plugin-delivery` | **49s**（Node 24 缓存命中，冷启动 97s） |
| 关键路径 | `Test create-principles-disciple` 374s → 墙钟 390s（+16s 启动） |

即便按最保守口径，这两次仍是**不完整覆盖**的样本（`pd-companion` 未执行），因此只作为
「优化没有回退、Node 24 缓存稳定命中」的旁证，不进入 §9.1 的收益结论。

### 9.1 汇总（同口径对比：优化前 4 次 vs 优化后 3 次）

采样：

- **优化前**：main 上的 4 次成功运行（44262597745 / 44265041579 / 44278152737 / 44296956347），15 job。
- **优化后**：`66947a069`（基于 `main d6919f751`）的 3 次完整成功运行，同一 commit，14 job。
  三次都满足：14 job 全部执行、无非预期 skip、`Build and test pd-companion` 执行、必需检查全绿、排队 0s。

| 指标 | 优化前（4 次中位） | 优化后（3 次中位） | 变化 |
| --- | --- | --- | --- |
| CI job 数 | 15 | **14** | −1 |
| **CI job-minutes** | **45.64** | **39.30** | **−13.9%** |
| job-minutes（3 次原始） | 43.73 / 45.22 / 48.88 / 46.05 | 37.22 / 39.30 / 39.62 | — |
| **CI 执行墙钟** | **515s**（created→updated） | **428s**（首个 job→末个 job；push 那次 created→updated = 388s） | **−16.9%** |
| 排队时间 | 0s（4 次） | 0s（3 次） | 不计入 |

> 口径说明：优化前 4 次的数据用 `created_at→updated_at`；优化后的 rerun 会保留原始 `created_at`，
> 因此三次统一用「首个 job `started_at` → 末个 job `completed_at`」，并单列 push 那次的
> `created→updated`（388s）。两种口径的差值是 workflow 启动/合并 ref 检出（约 18–35s），
> **不改变结论方向**。

逐 job 中位数（before 4 次 / after 3 次）：

| job | before | after | 变化 |
| --- | --- | --- | --- |
| Test shared runtime & adapters | 496s | **409s**（3 次均绿，含 pd-companion） | −87s |
| Test create-principles-disciple | 439s | **347s** | −92s |
| Test packaged install smoke | 321s | **268s** | −53s |
| Test workbuddy-adapter (Windows) | 274s | **281s** | +7s |
| Test OpenClaw Plugin（合并后） | 274s（=211+62 两个 job） | **169s** | **−105s** |
| Test principles-core | 206s | **182s** | −24s |
| Verify Merge Gate | 201s | **180s** | −21s |
| Test pd-cli | 196s | **185s** | −11s |
| Test pd-console | 148s | **138s** | −10s |
| Test pd-mcp-server | 95s | **43s** | −52s |
| Codex plugin delivery contract | 79s | **44s** | −35s |
| Test skill render contract | 70s | **78s** | +8s |
| CI Impact Gate | 14s | **17s** | +3s |
| Telemetry Union Guard | 10s | **10s** | 0 |

> `skill render contract` +8s 是**已知且接受**的：Node 20 job 明确选择直接 `npm ci`（缓存 restore 实测更慢），
> 其 install 步骤本身没有变化，差额来自 npm 下载缓存的命中波动。`workbuddy` +7s 在 Windows runner
> 分配等待的正常波动内（同一 SHA 三次为 335 / 268 / 281s）。

### 9.1.1 关键路径（after 3 次）

`create-principles-disciple`（345–355s）与 `workbuddy`（268–335s）交替决定墙钟；
`shared-runtime` 从 496s 降到 409s，已不再是唯一瓶颈。**installer 现在是第一优先级的后续优化对象**
（与仍 OPEN 的 #2710 范围重叠，故本轮 BLOCKED）。

步骤级中位数（after A 3 次）：`Test scripts` 169s（单次最优 132s / 最差 179s）、`Test host-runtime` 99s、`Test codex-adapter` 67s、`Build and test (fast suite)` 362s、`Build and run packaged install smoke` 217s、`Test workbuddy-adapter` 148s、`Run tests with coverage` 103s、`Build and test`(pd-cli) 137s。

> 关于 `Verify Merge Gate` +24s 与 `workbuddy` +51s：两者都与本次改动无关的方差（`verify-merge` 的 install 本来就是命中缓存的 4s，未改动其执行路径；Windows job 回退后 install 回到 64s，且 Windows runner 启动等待 60–78s 波动大）。**不把它们计入收益，也不掩盖。**

### 9.1.1 一次 Windows flake（不是 cache 引起）

run `44315542875` 的 `Test workbuddy-adapter` 在 132s 失败：`tests/workbuddy-bdd.test.ts` 的 *Governance workspace is shared across projects and explicit* 场景断言「project 目录不应出现 `.pd`/`.state`」时收到 `true`。同 SHA 的另外两次运行该 job 通过（325s/330s），**最终 SHA 那次也通过（293s）**。判定为 Windows 侧偶发（与本次改动无关：缓存路径只包含 `node_modules` 与 `packages/*/node_modules`，不包含 `.pd`）。已在 §12 记为后续观察项。

### 9.2 逐 job 对比（run 44314147995 vs 44296956347）

| job | before | after | Δ |
| --- | --- | --- | --- |
| Test shared runtime & adapters | 509s | 286s（**failed**，codex-adapter） | −223s |
| Test create-principles-disciple | 429s | 360s | −69s |
| Test workbuddy-adapter (Windows) | 293s | 325s / 330s（旧 SHA，已被回退） | 回退后回到 64s 安装；差异主要是 Windows runner 启动等待（+78s）<br>与测试本体波动 |
| Test packaged install smoke | 318s | 252s | −66s |
| Test principles-core | 200s | 210s | +10s |
| Verify Merge Gate | 182s | 196s | +14s |
| Test pd-cli | 186s | 160s | −26s |
| Test pd-console | 146s | 116s | −30s |
| Test OpenClaw Plugin (合并后) | 211 + 62 = 273s | 143s | −130s |
| Test pd-mcp-server | 82s | 30s | −52s |
| Codex plugin delivery contract | 59s | 37s | −22s |
| Test skill render contract | 63s | 69s | **+6s**（node20 冷缓存） |
| CI Impact Gate | 12s | 13s | +1s |
| Telemetry Union Guard | 11s | 10s | −1s |

波动说明：`principles-core`(+10s)、`Verify Merge Gate`(+14s)、`workbuddy`(+32s)、`skill-render`(+6s) 都是**已知的一次性/噪声项**（冷缓存或 runner 波动），在 9.1 的 3 次中位数里被摊平。

### 9.3 冷/热缓存区分【实测】

| job | 第一次 | 第二次（已确认命中） | 判定 |
| --- | --- | --- | --- |
| Linux / Node22 各 job | 4–6s | 3–6s | 命中即收益，保留 |
| skill-render（Node20） | 45s | 52s | 命中无收益 → 回退 |
| workbuddy（Windows） | 58s | 72s | 命中无收益 → 回退 |

「命中」的判定依据：composite action 内的 `Install dependencies` 步骤未出现（`cache-hit == 'true'`），`Restore node_modules` 仍耗时 52s/72s —— 说明成本来自 tarball 往返本身，而不是缓存未命中。这正是「npm cache 命中 ≠ 安装可以跳过」之外的另一条结论：**缓存命中也不保证比安装快**，必须实测。

---

## 10. Correctness & Regression Verification

### 10.1 本地【实测】

| 命令 | 结果 |
| --- | --- |
| `npx vitest run __tests__/ci-impact-gate-contract.test.ts __tests__/core-test-job-guards.test.ts __tests__/impact.test.ts` | PASS（42 tests） |
| `npx vitest run __tests__/pre-push-fast.test.ts __tests__/check-satellite-purity.test.ts __tests__/codex-runtime-delivery.test.ts __tests__/release-workflows.test.ts` | PASS（135 tests） |
| `node scripts/check-repo-hygiene.js all` | PASS |
| `node scripts/check-generated-artifacts.cjs` | PASS |
| `node scripts/check-docs-structure.cjs` | PASS |
| `node scripts/check-security-baseline.js` | PASS（14 项） |
| `node scripts/release/check-pr-release-intent.mjs` | PASS `mode=normal, intent=none-needed` |
| 3 个改动 YAML 解析 | PASS；ci.yml = 14 job |
| 真实 pre-commit / pre-push | PASS（无 `--no-verify`、无 `LEFTHOOK=0`） |

未本地运行完整 `npm run verify:merge`（AGENTS.md §25：不做每次 handoff 全量运行）；CI 的 `Verify Merge Gate` 是权威。

### 10.2 CI【实测】

**最终基准（`66947a069`，run 44354575277 的 3 次完整运行）**：14 / 14 job 全绿，三次均无 skip，
`Test shared runtime & adapters` 内 `Build and test pd-companion` 实际执行。

| 检查 | 结果 |
| --- | --- |
| `Verify Merge Gate` | PASS（174–224s） |
| `Test principles-core`（含导出面门禁） | PASS（176–184s） |
| `Test pd-console` / `pd-cli` / `pd-mcp-server` | PASS |
| `Test OpenClaw Plugin (unit+integration+coverage)`（合并后） | PASS（161–181s） |
| `Test workbuddy-adapter`（Windows） | PASS（268–335s） |
| `Test create-principles-disciple` / `Test packaged install smoke` | PASS |
| `Test shared runtime & adapters` | PASS（289–424s） |
| `Test skill render contract` / `Codex plugin delivery contract` | PASS |
| `PR Checks` → `Dependency Audit`（Node 22） | PASS（28s，run 44351065591） |

### 10.3 保护强度未被削弱

- 未删除/未跳过任何测试；
- 未放宽任何断言；
- 未放大任何用例超时（仅合并后 job 的**作业级**预算 15m → 20m）；
- 未用 Mock 替代真实集成；
- 未缓存不确定 dist，未复用其他 SHA 产物；
- 导出面门禁、impact fail-open、pack dry-run 证据、Windows 真实夹具全部保留。

---

## 11. Complexity Delta

```
New durable source of truth: NO
New persisted schema/state: NO
New subsystem/service/background process: NO
New public abstraction/interface: NO
New runtime feature flag: NO
New cross-package dependency: NO
New host/platform-specific behavior: NO
New external/network capability: NO
```

净复杂度**下降**：job 数 15→14、内联缓存定义 1→0（收敛到唯一 action）、12 处重复安装逻辑 → 1 处。

---

## 12. Remaining Opportunities

按「有证据支撑」的程度排序：

1. **关键路径已转移到 installer（实测）**：收尾样本里 `Test create-principles-disciple` 374s、
   `Test packaged install smoke` 303s 成为墙钟决定项（390s 墙钟）。installer 内部优化与仍 OPEN 的
   #2710 范围重叠，因此 BLOCKED；解除后这里是最值得挖的单点。
2. **Windows runner 分配等待（新瓶颈）**：早期样本 `workbuddy` 在 start+78s 才开始；Windows runner
   分配波动 ±60s 会直接改变墙钟。可考虑把 Windows 夹具测试改为 `schedule` 独立频率，或证明夹具的
   `D:\` 绝对路径要求可参数化后迁到 Linux。**需要独立取证，本轮不做**。
3. **scripts Git fixture 共享 / seed repo（潜在最大单点收益，但当前不可测）**：scripts 套件在本机
   因 npm/node 身份不一致产生 57 个与性能无关的失败（§7.2），必须先建立一个可复现的本地基线，
   才谈得上 fixture 复用收益。
4. **worker 数（有数据、无授权改动）**：core / pd-cli / pd-console / plugin 的 2→8 worker 全部更快，
   但 pd-cli 与 pd-console 的 5s 超时用例随负载上升而红（§7.2）。下一步不是调参数，而是先证明这些
   用例在 4-vCPU runner 上的余量。
5. **PRI-1271**：已在 #2713 修复；合并后 shared runtime 恢复全绿，并解锁 Gate 4 的三次样本。
6. **导出面门禁设为分支保护必需检查**：治理决策，需 Owner 决定，本轮只核实未行动。
7. **Windows 侧 `workbuddy-bdd` 偶发失败**（`Governance workspace is shared across projects and explicit`，
   1/3 次，132s）：同 SHA 另两次通过。不是缓存引起（缓存路径不含 `.pd`），需独立排查临时目录复用竞态。

---

## 13. PR Information

- PR：https://github.com/csuzngjh/principles/pull/2712
- 标题：`perf(ci): one shared node_modules cache + fold the duplicate plugin build job (15->14 jobs)`
- 基准 HEAD：`66947a069`（基于 `main d6919f751`，11 个提交，全部经真实 pre-commit / pre-push，无 `--no-verify` / `LEFTHOOK=0`）
- 方法：从 `origin/main` 新建分支，按序 cherry-pick 下列提交（零冲突），丢弃两个已被 main 取代的提交
  （`b9cbfaa68` 他人推送的 PRI-1271 修复、`0e1c11b54` 其回退），随后 `--force-with-lease` 推送。
  1. `254a6e94d` perf(ci): 共享 node_modules 缓存 + 合并重复 plugin build job
  2. `89ca3c3dc` perf(ci): 回退两处实测负收益的缓存接入
  3. `dd073f27b` docs(ci): Phase II 报告（含实测 before/after）
  4. `61773d78b` docs(ci): 修正安装点数量并记录 Windows flake 观察
  5. `3141cd312` fix(ci): 按 job 真实 Node major 建立缓存键（+ 结构守卫 + TESTING.md）
  6. `0f5029929` docs(ci): Phase II 收尾记录
  7. `3e1f542e3` docs(ci): audit 工具链等价实测
  8. `4324ed9ee` / `4c67e14fc` docs(ci): node24 缓存命中、近似样本、worker 矩阵
  9. `0ae69bc27` / `66947a069` docs(ci): 并发写入回退记录、剩余机会重排
- 重建后守卫复验：`ci-impact-gate-contract` / `ci-node-modules-cache-contract` / `core-test-job-guards` 共 13 tests **全绿**
- 独立 PR：https://github.com/csuzngjh/principles/pull/2713（PRI-1271，**不属于本 PR 范围**）
- 状态：**未合并、未开 auto-merge、未部署**；未触碰 `~/.pd/runtime` 与生产 workspace
- **并发写入事件（如实记录）**：另一个 agent 于 15:00Z 直接把 PRI-1271 的修复
  （`b9cbfaa68`）推到本分支，违反「不要把 PRI-1271 混入 #2712」。当时新增回退提交
  `0e1c11b54` 恢复评审范围；#2713 合并后，重建分支时这两个提交都被丢弃（main 已含等价修复）。
  PR 上留有说明评论
  （[#issuecomment-6984956307](https://github.com/csuzngjh/principles/pull/2712#issuecomment-6984956307)）。
  这属于 AGENTS.md §23A `git-2-one-writer-per-worktree` 的实际案例。
- 变更文件：
  - `.github/actions/restore-node-modules/action.yml`（新增；`node-version` 必填）
  - `.github/workflows/ci.yml`（安装点收敛 + 合并 job + Node 24 缓存键修复）
  - `.github/workflows/pd-console-e2e.yml`、`.github/workflows/pr-checks.yml`（接入同一缓存；audit 等价性证据写进注释）
  - `docs/process/TESTING.md`（job 清单 15→14、缓存机制、Node 版本矩阵）
  - `scripts/__tests__/ci-impact-gate-contract.test.ts`（gated 计数 11→10）
  - `scripts/__tests__/ci-node-modules-cache-contract.test.ts`（新增结构守卫）
  - `PD-CI-RUNTIME-OPTIMIZATION-REPORT.md`（本报告）
- 回滚：删除 action、恢复 `npm ci --ignore-scripts`、恢复 `build-openclaw-plugin`、计数改回 11、
  `node-version` 恢复默认值（不推荐，会复活静默错配）。无持久状态。

---

## 附录 A：三阶段反馈（本地）

只读审查结论，未改动：

| 层次 | 现状 | 是否有重复 |
| --- | --- | --- |
| 快速反馈（pre-commit） | worktree-guard + eslint --fix(staged) + repo-hygiene(staged) + commit-identity | 无；全部 O(变更文件) |
| 包级验证（pre-push） | `pre-push-fast.mjs` 复用 `computeImpact`，只查改动文件的语法与按包 eslint | 无；已刻意避开 PRI-961 的 Windows OOM 与「第二套依赖图」 |
| 合并门禁 | per-package job + `verify-merge` + `test-principles-core` | 是（见 §4.4 / §8.1），已在本轮收敛 |

本轮额外把 `pr-checks.yml` 的 `Dependency Audit`（只为 `npm audit` 而 `npm ci`）改为共享缓存，Node 24→22（audit 与 Node 版本无关），避免第三个 ~1.5GB 缓存条目。

---

# 附录 B：Phase III-A — Scripts 测试基础设施可复现性与 Git Fixture 成本

- 日期：2026-11-19
- 分支：`ai/adhoc-20261119-scripts-toolchain-fixture-887b7c`
- 工作树：`D:\Code\_worktrees\principles\adhoc-20261119-scripts-toolchain-fixture-887b7c`
- 开发基线：`origin/main` = `bf9ea3af9`；PR 创建前已 rebase 到当时的 `origin/main`
- **结论先行**：工具链不一致的**一类**失败已定位并修复（实测）；**另一类**（`pd-lab-snapshot-fence`）在本轮
  **无法复现**（NOT_REPRODUCED）。Git Fixture 成本已实测，但其**上限**不足以达到 10% 的合并门槛，
  因此**不实施 Seed Repository**，按指令 §10 停止该方向并给出下一候选。

## B.1 合并状态与新基线（Gate 0）【实测】

| 项 | 值 | 来源 |
| --- | --- | --- |
| `#2712` | **MERGED** 2026-11-19T01:48:40Z → `7230cc578` | `gh pr view` |
| `#2713`（PRI-1271） | **MERGED** 2026-11-18T16:16:16Z → `d6919f751` | `gh pr view` |
| `#2710` | **MERGED** 2026-11-19T02:15:29Z → `bf9ea3af9` | `gh pr view` |
| 开发基线 HEAD | `bf9ea3af9` | `git rev-parse` |
| 创建 PR 前 `origin/main` | 已前进到 `2c78d2a95`（`chore: version packages (#2719)`） | `git fetch` + `git rev-parse` |
| 工作区 | 干净（仅本轮意图内改动） | `git status --porcelain` |

`#2710` 带来的结构性变化（相对 Phase II 的 14 job）：**新增独立 job `Export Surface Gate`**，
job 总数回到 **15**；installer 侧改为「有界等待」而非固定轮询。因此本报告**不再沿用** Phase II 的
14-job 结构假设。

## B.2 Gate 1：Required Status Checks【实测，已完成】

| 项 | 改动前 | 改动后 |
| --- | --- | --- |
| required checks | `Verify Merge Gate`、`Test principles-core` | 追加 `Export Surface Gate` |
| `strict` | true | true（未变） |
| `enforce_admins` | true | true（未变） |
| force push / deletions | 禁止 | 禁止（未变） |
| rulesets | `[]` | `[]`（未变） |
| 读取确认 | — | `gh api .../branches/main/protection` 复核通过 |

改动通过 `gh api PATCH` 只替换 `contexts` 数组，未触碰其它字段。**该治理操作未混入**本 PR。

## B.3 Gate 2：合并后的 CI 基线【实测】

Run `44442977471`（`bf9ea3af9`，push）：**15 job 全绿**，created `02:15:31Z` → updated `02:21:43Z`
（墙钟 **372s**），全部 job 在 created+3~19s 内启动。

| job | 起 → 止 (UTC) | 时长 |
| --- | --- | ---: |
| CI Impact Gate | 02:15:34 → 02:15:48 | 14s |
| Telemetry Union Guard (advisory) | 02:15:34 → 02:15:44 | 10s |
| Export Surface Gate | 02:15:34 → 02:16:37 | **63s（实际执行，非 skip）** |
| Verify Merge Gate | 02:15:34 → 02:18:58 | 204s |
| Test principles-core | 02:15:34 → 02:18:37 | 183s |
| Test shared runtime & adapters | 02:15:49 → 02:21:30 | **341s** |
| Test pd-mcp-server | 02:15:49 → 02:16:28 | 39s |
| Test pd-console | 02:15:50 → 02:17:23 | 93s |
| Codex plugin delivery contract | 02:15:49 → 02:16:26 | 37s |
| Test skill render contract | 02:15:50 → 02:17:06 | 76s |
| Test OpenClaw Plugin (unit+integration+coverage) | 02:15:50 → 02:18:42 | 172s |
| Test pd-cli | 02:15:50 → 02:18:57 | 187s |
| Test packaged install smoke | 02:15:49 → 02:20:37 | **288s** |
| Test workbuddy-adapter (Windows fixtures) | 02:15:50 → 02:21:43 | **353s**（排队 19s） |
| Test create-principles-disciple | 02:15:50 → 02:18:22 | **152s** |

- job-seconds 合计 **2212**（36.87 job-min）。
- `Test shared runtime & adapters` 内部步骤（实测）：

| step | 时长 |
| --- | ---: |
| Restore node_modules | 4s |
| Rebuild native modules | 1s |
| Build dependencies | 6s |
| **Test scripts** | **151s** |
| Test root guard contracts | 2s |
| Test host-runtime | 90s |
| Verify real OpenClaw host parity | 9s |
| Test codex-adapter | 62s |

- 非预期 skip：**无**。`Export Surface Gate` 实际执行了 `npm ci --ignore-scripts` + 导出面检查。
- 与 Phase II 基线的差异（实测）：Phase II 14 job / 37.22 job-min / 388s 墙钟 → 现 15 job /
  36.87 job-min / 372s 墙钟。**新增一个 job 但仍略快**，说明 #2710 的「有界等待」抵消了新增 job 的开销。

## B.4 第一阶段：工具链身份与两类失败

### B.4.1 身份审计【实测】

| 项 | 值 |
| --- | --- |
| `.nvmrc` / `.node-version` | **均不存在**（仓库未声明本地 Node 版本契约） |
| root `package.json` `engines` / `packageManager` | **均未声明** |
| CI `Test scripts` job 的 Node | `22`（`setup-node` + `restore-node-modules` 均 22） |
| 本地 `process.execPath` | `D:\Program Files\nodejs\node.exe` |
| `process.version` | `v26.12.1` |
| `npm --version` / `npx --version` | `11.20.0` / `11.20.0` |
| `where.exe node/npm/npx` | 全部唯一命中 `D:\Program Files\nodejs\`（**无第二套 Node**） |

结论：本机**不存在** Phase II 所述的「多套 Node/npm 并存」。本地 Node 26 + npm 11.20 自身
内部一致；与 CI 的 Node 22 不同，但仓库没有声明本地契约，因此这不是「违约」，也不应通过新增
`.nvmrc` 去追认（那会把一次环境事实升级成治理约束，超出本轮最小改动）。

### B.4.2 失败类 A：`check-package-manager.test.mjs`【实测，已修复】

**根因**：Windows 的环境变量名大小写不敏感，但 `process.env` **保留传入时的拼写**。IDE/Trae 终端
会导出大写 `NPM_CONFIG_USER_AGENT=npm/11.20.0 node/v26.12.1 …`；测试里
`{ ...process.env, npm_config_user_agent: 'pnpm/…' }` 于是**同时**存在两种拼写，子进程按大小写不敏感
查找到大写那条 → 被模拟的 installer 身份**从未生效** → 守卫看到真实 npm UA → 全部拒绝用例退出码 0，
与 `expect(1)` 不符。Linux 区分大小写，所以只在 Windows 本地红。

**证据链（实测）**：
1. 在 vitest 进程内打印 `process.env`，确认大写键存在；
2. 用最小 env（只保留少数键）传 UA，子进程能收到 → 排除「env 传递本身不可用」；
3. 修复后 `5 passed`。

**修复**：只在测试侧（`scripts/__tests__/check-package-manager.test.mjs`）先删除所有大小写变体，
再写入唯一身份。**守卫 `scripts/dev/check-package-manager.mjs` 未改**，断言未改，用例数未改。

### B.4.3 失败类 B：`pd-lab-snapshot-fence.test.ts`【NOT_REPRODUCED】

本 worktree 内：`18 passed | 2 skipped`（8–10s，2 skipped 为 Windows 平台限制用例）。
Phase II 的 `18/20 失败（含 FENCE-0 positive control）` **无法复现**。

为排除「缺构建产物」这一最常见解释，做了**受控实验【实测】**：

| 实验 | 结果 |
| --- | --- |
| 对照组：`packages/principles-core/dist` 存在 | `18 passed / 2 skipped` |
| 实验组：临时移走 `packages/principles-core/dist` | `Test Files 1 failed`，`Error: Cannot find module …@principles/core/dist/runtime/index.js`，**`Tests no tests`** |
| 恢复后复跑 | `18 passed / 2 skipped`（已复原并复验） |

**该实验同时否证了一个假设**：Phase II 的失败形态是「18 failed + 2 skipped」，即**模块加载成功、
测试体真正执行并逐条断言失败**；而缺 dist 的形态是「suite 报错、0 个测试」。两者签名不同，
因此 **Phase II 的 18 个失败不是缺 `@principles/core/dist` 造成的**。

**剩余可能原因（推断，无法定论）**：Phase II 测量 shell 自述 `node v22.22.2` 且 `npx` 解析到的 npm
与之不匹配；若 `process.execPath` 指向的二进制与 `node_modules` 的原生模块 ABI（`better-sqlite3`）
或子进程启动方式不一致，测试体可以加载却逐条失败。**Phase II 的原始失败日志未保留**，因此本轮
不给结论，只标注：`NOT_REPRODUCED` + 已知否证项。两类失败的根因**不合并**。

## B.5 本地 Scripts 基线（连续 3 次，默认配置，2 workers）【实测】

命令：`cd scripts && npx vitest run`（= `npm run test:scripts`，无任何 `-c` 覆盖）。
环境：Node v26.12.1 / npm 11.20.0；机器同前；`.tmp/` 下 47 个历史 test-run 目录未清理。

| # | Test Files | Tests | vitest Duration | 墙钟 |
| --- | --- | --- | ---: | ---: |
| 1 | 137 passed + 1 skipped | 2919 passed / 34 skipped / **0 failed** | 422.70s | 426.3s |
| 2 | 同上 | 同上 | 418.64s | 423.2s |
| 3 | 同上 | 同上 | 420.12s | 424.2s |
| **中位** | — | — | **420.12s** | **424.2s** |

**最终基线（rebase 到 `2c78d2a95` 并重建 CI 同款 6 个 workspace 之后，连续 3 次）【实测】**：

| # | Test Files | Tests | vitest Duration | 墙钟 |
| --- | --- | --- | ---: | ---: |
| 1 | 137 passed + 1 skipped | 2919 passed / 34 skipped / **0 failed** | 406.64s | 410.2s |
| 2 | 同上 | 同上 | 401.10s | 404.7s |
| 3 | 同上 | 同上 | 417.05s | 420.6s |
| **中位** | — | — | **406.64s** | **410.2s** |

两次基线的差异（420.12s → 406.64s，−3.2%）来自基线提交与构建产物，**推断**与 #2719 的版本提交及
重建后的 dist 有关，未单独归因；两者计数完全一致，均可复现。

补充说明（实测）：
- Phase II 报告的 `652.58s / 57 failed` **不可用作基线**；本轮同命令为 420.12s 且 0 失败。
- 早期另 3 次样本（10:30–10:43）为 395.57 / 377.99 / 384.25s，但当时输出里混入了我临时创建的
  `zz-probe.test.mjs`（使其成为 2920/2954）。该文件已删除，**上表 3 次是唯一干净基线**。
  早期样本与上表的 ~+9% 差值，**推断**来自机器负载与 `.tmp` 历史目录累积，未单独取证。
- 34 个 skip 全部有据：`release-immutable-candidate` 17（`hasGnuArchiveTools()` 在 Windows 为 false，
  整文件 skip）、`pd-lab-experiment-config` 11、`pd-lab-snapshot-fence` 2、`cleanup-task-worktree` 2、
  `pipeline-evolution-evidence` 1、`pdspec001-childenv-pointer-isolation` 1。**无新增 skip**。
- 与 CI 对比（实测）：同一套件 CI `Test scripts` 步骤 **151s**（Ubuntu、4 vCPU），本地 Windows
  **420s**。本地慢 2.8×，说明本套件的成本高度依赖 Windows 的进程创建与文件系统，而不是 git 语义。

## B.6 第二阶段：Git Fixture 成本实测

方法【实测，非源码推断】：临时 `setupFiles` 包裹 `node:child_process` 的
`spawnSync / execFileSync / execSync / spawn / execFile / exec`，对 `git` 调用逐次计时，
并 `syncBuiltinESMExports()` 让 ESM 命名导入拿到包装后的函数；每次调用写一行 JSONL。
测量文件全部位于 `.tmp/measure/`，**不进入提交**。测量本身带来的额外开销见 B.6.3。

本次测量运行：`2919 passed / 34 skipped / 0 failed`，`Duration 427.94s`（含测量开销），
记录 **1787 次** git 子进程调用、26 个测试文件涉及 git。

### B.6.1 按命令类别【实测】

| 类别 | 次数 | 累计耗时 | 单次均值 |
| --- | ---: | ---: | ---: |
| `git init` | 141 | 8.4s | 60ms |
| `git clone` | 17 | 2.6s | 150ms |
| `git commit` | 262 | 33.9s | 130ms |
| `git worktree …` | 126 | 11.0s | 87ms |
| ref/状态类（`rev-parse`/`switch`/`branch`/`add`/`config`/`merge`/`status` 等） | 1186 | 76.5s | 65ms |
| 其它 | 55 | 7.2s | 130ms |
| **合计** | **1787** | **139.6s** | 78ms |

「Fixture 构造原语」= `init + commit + clone + worktree` = **546 次 / 55.9s**。
其余 1186 次是 ref/状态查询与切换——它们多数是**断言对象本身**（测的就是 git 语义），不能消除。

### B.6.2 逐文件调查表【实测】

`Fixture 类型` 取自实际调用构成；`初始化耗时` 为本文件 git 子进程累计耗时（fixture 主成本的可测代理）；
`测试耗时` 为 vitest 报告的本文件总时长（含 fixture 与断言，二者不可再分——JSON reporter 把 hook 时间
计入测试，故不伪造拆分）。

| 测试文件 | 用例数 | Fixture 类型 | 初始化耗时（git 累计） | 测试耗时（文件） | 重复程度 | 优化机会 |
| --- | ---: | --- | ---: | ---: | --- | --- |
| `aa-presence-run.test.mjs` | 100 | **无 git**；`spawnSync(process.execPath)` 子进程 + HTTP | 0s | **137.4s（18.9%）** | 高（每用例起子进程） | **最高**，但与 fixture 无关 |
| `release-contracts.test.ts` | 32 | 每用例 `seedRepo`（init+多次 commit）+ pack/install | 19.9s（271 次：init 8 / commit 56 / clone 1） | 77.2s（10.6%） | 高 | 中（commit 多为被验行为） |
| `cleanup-task-worktree.test.ts` | 47 | 每用例 init + 真 worktree（75 次）+ 真提交 | 32.7s（352 次：init 5 / commit 40 / worktree 75） | 62.7s（8.6%） | 高 | 中高 |
| `worktree-readiness.test.ts` | 23 | 每用例 init + 18 次 init、22 次 commit | 12.6s（230 次） | 12.8s | 高 | 中 |
| `release-finalize-tag.test.ts` | 11 | init 14 + clone 7 + commit 16 | 11.1s（105 次） | 19.8s | 高（7 次 clone） | 中 |
| `workspace-lifecycle.test.ts` | 27 | init 9 + clone 3 + commit 11 | 10.9s（107 次） | 30.8s | 中 | 中 |
| `impact.test.ts` | 33 | init 1 + commit 34 | 8.7s（106 次） | 13.0s | 中 | 低（commit 是断言对象） |
| `workspace-lease.test.ts` | 16 | init 16 + commit 16 + worktree 15 | 7.6s（114 次） | 13.2s | 中 | 低 |
| `git-hooks-dispatcher.test.ts` | 8 | init 9 + commit 13 + worktree 8 | 6.7s（77 次） | 8.4s | 中 | 低 |
| `check-dev-worktree.test.ts` | 12 | init 11 + commit 11 + worktree 7 | 5.0s（79 次） | 8.4s | 中 | 低 |
| `error-records.test.ts` | 26 | init 4 + commit 13 | 4.4s（46 次） | 4.6s | 低 | 低 |
| `error-context.test.ts` | 55 | init 6 + commit 9 | 3.7s（62 次） | 4.4s | 低 | 低 |
| `check-repo-hygiene.test.ts` | 34 | init 10 + commit 8 | 3.0s（51 次） | 3.7s | 低 | 低 |
| 其余 13 个文件 | — | 小额 init/commit/worktree | 各 <2.1s | 各 <19.3s | 低 | 低 |

### B.6.3 测量开销【实测】

含测量的整轮 `427.94s` vs 干净基线中位 `420.12s` → **+1.9%**。测量本身只做进程级计时与
每调用一次追加写，不改变被测语义。

## B.7 Seed Repository 评估与判定：**NO-GO**

**上限计算【实测输入 + 明确的算术】**：
- 全部 git 子进程累计 **139.6s**；2 workers 且文件级近完美并行（727.4s 文件时间 / 2 = 363.7s
  理想值 vs 实测最终中位 406.6s，并行效率 89.5%），因此 git 时间对墙钟的贡献上限
  ≈ **139.6 / 2 ≈ 70s**。
- 其中「Fixture 原语」仅 **55.9s** → 对墙钟上限 ≈ **28s**。
- 合并门槛 = 最终中位 406.64s 的 10% = **≥40.7s**。

即：**即使把全部 `init/clone/commit/worktree` 调用降到零**（实际不可能——大量 `commit` 正是
被测行为，例：`impact` 34 次、`release-contracts` 56 次），理论上限也只有约 28s ≈ 6.9% < 10%。

**额外约束**：
- `git init` 仅 141 次 / 8.4s；单次 60ms。用一个不可变 seed 仓库替换它，只能省下其中一部分，
  而且要为每个用例拷贝工作区（Windows 上目录拷贝往往比 `git init` 更贵）。
- `clone` 仅 17 次 / 2.6s，完全不是成本项。
- CI 侧该步骤只有 151s，且 CI 是 Linux；fixture 优化的收益在 CI 上更小。

**判定**：不实施 Seed Repository / Fixture 复用。理由是指令 §5 的门槛（中位 ≥10%）在算术上
不可达，属于 §10 明确允许的「停止该方向」。因此本轮**没有**引入任何 fixture 管理机制、
全局测试仓库、生命周期服务或并发共享状态——也就不存在需要新增的并发负控制用例。

## B.8 下一项最高收益候选【实测数据支撑】

1. **`aa-presence-run.test.mjs`（137.4s，占文件时间 18.9%，零 git）**：100 个用例大量使用
   `spawnSync(process.execPath, …)` 启动真实子进程与本地 HTTP 端点。这是当前单文件最大成本，
   且与 fixture 无关。可行方向（需独立取证）：合并同一 describe 内的重复子进程启动、
   复用同一 launcher 进程、或用进程内等价路径替代"只为读一次进程列表"的子进程。
2. **Windows 进程创建成本本身**：同一套件 Linux 151s vs Windows 420s（2.8×）。
   若要真正压低本地时间，方向是减少子进程数量，而不是减少 git 语义。
3. `cleanup-task-worktree`(62.7s) / `release-contracts`(77.2s)：git 只占 32.7s / 19.9s，
   剩余成本在真实文件系统操作与 pack/install，属独立议题。

## B.9 未解决问题

| 项 | 状态 |
| --- | --- |
| `pd-lab-snapshot-fence` Phase II 的 18/20 失败 | **NOT_REPRODUCED**；已否证「缺 core dist」假设；原始日志缺失，无法定论 |
| 本地 Node 26 vs CI Node 22 | 仓库未声明本地契约；本轮**不新增** `.nvmrc`/`engines`（避免把环境事实升级为治理约束） |
| `.tmp` 历史 test-run 目录累积（47 个） | 未清理；本轮未取证其定量影响 |
| 早期 3 次样本（395/378/384s）与干净基线（420s）的 ~9% 差值 | **推断**为机器负载/临时目录累积，未单独取证 |

## B.10 验收清单

| 项 | 结果 |
| --- | --- |
| Branch Protection / Rulesets 已核实 | 是（B.2） |
| `Export Surface Gate` 进入 Required Checks | 是（B.2，已回读确认） |
| 合并后的 CI 基线完整通过 | 是（B.3，15 job 全绿） |
| 本地工具链身份已审计 | 是（B.4.1） |
| 原有 Scripts 测试全部通过 | 是（2919 passed / 0 failed） |
| 连续 3 次基线可复现 | 是（B.5，计数完全一致） |
| Git Fixture 成本实际测量 | 是（B.6，1787 次调用 / 139.6s） |
| 优化收益达到 10% 门槛 | **不适用**：算术上限 ~6.9%，按 §10 停止（B.7） |
| 测试覆盖/断言语义未变 | 是（唯一代码改动在测试侧的 env 构造，守卫与断言未动） |
| 无新增 skip / 无放宽 timeout / 无提高 workers | 是（workers 仍为 2） |
| 完整 GitHub CI | 见 PR 状态（本节由 CI 结果决定，PR 保持 OPEN） |

## B.11 回归证据【实测】

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 定向测试 | `cd scripts && npx vitest run __tests__/check-package-manager.test.mjs` | 5 passed |
| Scripts 整套 ×3 | `cd scripts && npx vitest run` | 2919 passed / 34 skipped / 0 failed ×3（B.5） |
| 涉及的 fixture 消费者 | 同一整套运行（26 个 git 文件全部执行） | 无回归 |
| 相关包 TypeScript | 根 `tsconfig.json` 只 `include: packages/**/*.ts`；本轮唯一代码改动是 **`.mjs`** 测试文件，`scripts/` 无 tsconfig | **N/A（附原因）** |
| ESLint | `npx eslint scripts/__tests__/check-package-manager.test.mjs` | exit 0 |
| Repo Hygiene | `npm run check:repo-hygiene` | Passed |
| Generated Artifacts | `node scripts/check-generated-artifacts.cjs` | Passed |
| Docs Structure | `node scripts/check-docs-structure.cjs` | OK |
| Security Baseline | `node scripts/check-security-baseline.js` | `{"ok":true,"checked":14}` |
| 真实 pre-commit | `git commit`（lefthook：commit-identity / worktree-guard / repo-hygiene） | 全部通过，未使用 `--no-verify` / `LEFTHOOK=0` |
| 真实 pre-push | `git push`（lefthook pre-push：`pre-push-fast`） | PASS（2 changed files / 1 Node syntax file） |
| 并发负控制 | — | **不适用**：本轮未引入 fixture 复用机制，不存在共享 Seed 状态 |
| GitHub PR CI | PR #2721，run `44459276318`（head `af9ca2e4c`） | **全部 check 通过**（含 `Export Surface Gate` 33s、`Verify Merge Gate` 3m50s、`Test principles-core` 3m40s、`Test shared runtime & adapters` 5m18s） |

## B.12 PR 与 CI 结果【实测】

- PR：https://github.com/csuzngjh/principles/pull/2721（**保持 OPEN，未合并、未部署**）
- 标题：`test(scripts): make the scripts suite reproducible on Windows and price the git-fixture budget`
- 分支：`ai/adhoc-20261119-scripts-toolchain-fixture-887b7c`
- 提交：
  1. `1b975f328`/`7df02ed5d` fix(scripts): Windows env 大小写遮蔽修复 + 附录 B
  2. `af9ca2e4c` docs(ci): 最终基线（rebase 后 3 次）与回归证据
- PR CI（run `44459276318`，created `04:34:39Z` → updated `04:40:21Z`，墙钟 **342s**）：
  - 该 PR 的 `Test scripts` 步骤 **136s**（基线 run 44442977471 为 151s）；
    `Restore node_modules` 5s、`Build dependencies` 5s。
  - 25 个 check 全部 PASS，无 skip、无 flake。
- 治理操作（Gate 1）**不在本 PR 内**：它是对仓库设置的直接 `gh api PATCH`，见 B.2。

---

# 附录 E：Phase III-D — Fixture Architecture Feasibility

- 日期：2026-11-19
- 工作树：`D:\Code\_worktrees\principles\adhoc-20261119-fixture-architecture-audit-eaa0d2`
- 分支：`ai/adhoc-20261119-fixture-architecture-audit-eaa0d2`
- 代码 SHA：`40564c8d3`（`origin/main`：`chore: version packages (#2726)`）
- **本轮不修改任何生产代码、测试断言或 CI 行为**；只读审计 + 临时测量。
- **结论先行**：重复的 Fixture 工作**确实存在且已量化**（1,222 次独立 Fixture 根、19,180 次写、1,787 次
  git 子进程、137,569 次读），但**能安全消除的部分很小**：
  - 建模板再复制，在 Windows 与 ext4 上**都比直接重建更贵**（实测 3.8–4.2×）；
  - 唯一真正划算的是「预构建 Git 仓库模板」，其可采纳上限是"只模板化 init + 首个 commit" →
    **≈ 15s 墙钟 = 套件 2.6%–4.5%**；把全部 git 原语都换成复制的乐观值（4.8%–8.4%）会替换掉
    "被验证的 commit 语义"，**不可采纳**；
  - 收益门槛是套件 ≥5% 或 AA 单文件 ≥10%，**两者都不满足** → **NO-GO**。

## E.1 状态核实

| 项 | 值 |
| --- | --- |
| 最新 `origin/main` | `40564c8d3` |
| `#2725`（附录 D） | **OPEN**，head `d96281231`，**未合并** → 本轮在 main 的报告中新增独立附录 E，不覆盖 D |
| `#2723`（附录 C） | OPEN |
| 阅读 | `AGENTS.md`、`docs/process/TESTING.md`、本报告 A/B 附录、以及 **#2725 head 的附录 D**（按指令要求从 PR head 读取，而非假设 main 已有） |
| 测试文件集 | `scripts/__tests__` 134 + `experiment/prompt-v2/scripts/__tests__` 4 = **138**，与 Phase III-C 完全一致（`git diff 6cf8ced10 40564c8d3 -- scripts/__tests__` 为空） |

## E.2 Gate 1：Phase III-C 统计口径复核【实测，已解决】

数据来源：Phase III-C 样本 3 的**原始 vitest JSON**（两侧各 138 文件、2953 用例），并与 5 个样本的
总计数交叉核对（Windows 恒为 2926/27，Linux 恒为 2936/17）。

### E.2.1 结论

| 平台 | Passed | Skipped | 合计 | 实际执行 |
| --- | ---: | ---: | ---: | ---: |
| Windows | 2926 | 27 | 2953 | 2926 |
| Linux | 2936 | 17 | 2953 | 2936 |

- 两平台**测试总数相同（2953）**，都收集了 138 个文件；**没有任何文件"没有执行"**。
- Windows 实际执行数比 Linux **少 10 个**，不是 17 个。
- 附录 D 中「Windows 少跑 17 个用例」的表述**不准确**，应更正为：
  「Windows 少执行 **10** 个用例：其中 **17** 个 GNU 归档用例因缺工具**整文件跳过**，
  但同时有 **11** 个 Linux 独有跳过（Windows 侧真跑），另有 4 个其他 Windows 独有跳过。」

### E.2.2 差值构成（21 − 11 = 10）

| 只在 Windows 跳过（21） | 数量 | 原因 |
| --- | ---: | --- |
| `release-immutable-candidate.test.ts` 全文件 | 17 | `hasGnuArchiveTools()` 在 Windows 为 false（缺 GNU tar/xz 语义） |
| `pd-lab-experiment-config.test.ts`（symlink A/B/C 之外的 2 个） | 2 | 依赖"可撤销读权限"的严格判定 |
| `cleanup-task-worktree.test.ts`（FIFO 用例） | 1 | Windows 无 mkfifo |
| `pd-lab-snapshot-fence.test.ts`（FIFO 用例） | 1 | 同上 |

| 只在 Linux 跳过（11） | 数量 | 原因 |
| --- | ---: | --- |
| `openclaw-child-temp-env.test.ts` | 5 | 8.3 短路径 / Windows 专用解析 |
| `pd-lab-experiment-config.test.ts` | 4 | Windows junction / 大小写折叠专用 |
| `worktree-quiescence.test.ts` | 1 | Windows rename 探针 |
| `worktree-root.test.ts` | 1 | `D:\Code\_worktrees` 路径推导 |

| 两平台都跳过（6） | 数量 |
| --- | ---: |
| `aa-presence-run`（官方 @openclaw/ai transports 自检） | 1 |
| `pipeline-evolution-evidence`（lab 目录缺失） | 1 |
| `openclaw-child-temp-env`（8.3 短路径，两侧都跳过） | 1 |
| `pd-lab-experiment-config`（symlink A/B/C，两侧都跳过） | 3 |

校验：27 = 17 + 2 + 1 + 1 + 1 + 1 + 1 + 3 ✓；17 = 5 + 4 + 1 + 1 + 1 + 1 + 3 + 1 ✓。

## E.3 Gate 2：Fixture 全景清单【实测】

### E.3.1 方法

- 138 个文件全量运行一次，`setupFiles` 里包裹 `node:fs` / `node:crypto` / `node:child_process` 的
  相关入口并逐文件计数（`syncBuiltinESMExports()` 让 ESM 命名导入生效）。
- **代理定义（必须说明，避免误解）**：
  `tmp` = `mkdtempSync` 次数（= 新的隔离 Fixture 根）；`copy` = `cpSync`/`copyFileSync`；
  `write` = `writeFileSync`/`appendFileSync`；`read` = `readFileSync`；`hash` = `createHash`；
  `spawn` = 全部子进程；`git` = 其中的 git 调用。
- 本次运行：**138 文件 / 2953 用例 / 2918 passed / 1 failed / 34 skipped**，
  `sumFile 585.6s`，墙钟 506.7s（**含插桩开销，不可与基线直接比较**）。
- 唯一失败 `dev-concurrency.test.ts`（并发抢占用例）在插桩延迟下不稳定；无插桩的既有基线
  连续多次 0 失败，判为**插桩扰动**，不是语义变化。

### E.3.2 全量合计【实测】

| 操作 | 全量次数 | 说明 |
| --- | ---: | --- |
| Fixture 根（`mkdtemp`） | **1,222** | 平均 8.9 个/文件 |
| 目录创建 | 6,534 | |
| 文件写 | 19,180 | |
| 文件读 | **137,569** | 累计读入 11.6 GB |
| 目录枚举 | 19,669 | |
| `stat` | 25,569 | |
| 文件复制 | 925 | |
| 删除 | 1,604 | |
| `createHash` | 1,041,184 | **73% 来自 2 个业务逻辑文件（见 E.3.3）** |
| 子进程 | **2,628** | 其中 **git 1,787** |

**交叉验证**：git 子进程 **1,787** 与 Phase III-A 独立插桩得到的 1,787 **完全一致**，
说明两套计数器互证有效。

### E.3.3 逐文件（按 Fixture 综合分排序的前 25，节选 12）

| 文件 | 用例 | 秒 | tmp | copy | write | read | hash | spawn | git |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `principle-learning-lab-phase2a-final-metrics.test.ts` | 3 | 27.8 | 0 | 0 | 0 | 51 | **382,465** | 0 | 0 |
| `principle-learning-lab-challenge-b1.test.ts` | 18 | 20.0 | 0 | 0 | 0 | 3 | **380,489** | 0 | 0 |
| `principle-learning-lab-ceb002.test.ts` | 7 | 0.7 | 1 | 1 | 18 | 117 | 126,826 | 3 | 0 |
| `principle-learning-lab-examiner-v09.test.ts` | 86 | 5.5 | 0 | 6 | 2,114 | 31,633 | 54,445 | 0 | 0 |
| `aa-presence-run.test.mjs` | 100 | **106.6** | 59 | 299 | 1,769 | 51,330 | 49,508 | **209** | 0 |
| `pd-lab-experiment-config.test.ts` | 118 | 2.6 | **296** | 6 | 1,313 | 3,773 | 2,101 | 0 | 0 |
| `release-contracts.test.ts` | 32 | **63.0** | 1 | 0 | 192 | 20 | 0 | **331** | **271** |
| `cleanup-task-worktree.test.ts` | 47 | **47.8** | 18 | 0 | 132 | 227 | 36 | **405** | **353** |
| `workspace-lifecycle.test.ts` | 27 | 22.9 | 3 | 0 | 20 | 2 | 0 | 129 | 107 |
| `check-workspace-tools.test.ts` | 21 | 21.0 | **21** | 84 | 17 | 18 | 0 | 20 | 0 |
| `worktree-readiness.test.ts` | 23 | 9.0 | 23 | 0 | 220 | 147 | 74 | **232** | **230** |
| `release-finalize-tag.test.ts` | 11 | 15.2 | 7 | 0 | 23 | 6 | 0 | 112 | 105 |

**关键纠正（Gate 3 要求）**：两个 `principle-learning-lab-*` 文件合计 **762,954 次** `createHash`、却
**0 次 tmp / 0 次 spawn / 3 次读**——这是**合法空间枚举的业务计算**（`verifyFullLegalSpace` /
候选去重），**不是 Fixture 开销**，不得计入 Fixture 成本。同理 `examiner-v09` 的 31,633 次读来自
用例本身的数据遍历。

### E.3.4 Fixture 类型（多标签，成本不重复计）

| 类型 | 代表文件 | 数量（估） |
| --- | --- | ---: |
| A 不可变 | `principle-learning-lab-*`（只读契约数据） | ~40 |
| B 可变 | `release-contracts`（每个用例改工作树）、`workspace-lease` | ~25 |
| C 隔离 | `pd-lab-experiment-config`（每用例独立 snapshot）、`check-workspace-tools` | ~30 |
| D 真实 Worktree/Git | `cleanup-task-worktree`、`workspace-lifecycle`、`worktree-readiness`、`impact`、`release-finalize-tag` | ~12 |
| E 真实进程 | `aa-presence-run`、`pd-lab-snapshot*`、`principle-learning-lab-challenge-cli-*` | ~15 |
| F 混合（D+E） | `release-contracts`（真 git + 真 npm/node 子进程） | ~8 |

交叉说明：同一文件可同时属于 C+D+E；**成本只在"实际发生的那一次操作"计一次**，
E.3.2 的分项合计（如 1,787 次 git）已按操作去重，不再按标签重复求和。

## E.4 Gate 3：生命周期审计（按 Fixture 成本最高的 6 个文件）

| 文件 | Create | Initialize | Mutate | Assert | Cleanup | 可复用性判定 |
| --- | --- | --- | --- | --- | --- | --- |
| `aa-presence-run` | 每用例 `makePack`（mkdtemp + 15 文件 + tarball 伪造） | `preparePack`（哈希、校验、写 manifest） | 真 host 子进程 + HTTP | 指纹/污染/注册源/执行码 | 每轮 sweep + 最终 sweep（**本身是被验行为**） | **不可复用**：packRoot 是每轮的隔离身份；sweep 是安全断言 |
| `release-contracts` | **一次** `seedRepo`（tmp=1） | 15 个文件 + 1 次 commit | **每用例** git 分支/merge/reset + 真实 node 子进程 | 提交/版本/pr 结果 | 复用同一 repo | **已是最优**：种子只建一次；重复的是被验的 git 操作 |
| `cleanup-task-worktree` | 18 次 `makeTask`（真实 worktree） | `git worktree add` + 分支 | 删除/隔离/恢复 | 目录指纹、git 注册表 | 用例内验证 quarantine 恢复（**本身是被验行为**） | **不可复用**：worktree 的真实注册状态就是断言对象 |
| `workspace-lifecycle` | 3 个根 | 真实 worktree + 109 次 git | 迁移/删除 | 生命周期状态 | 真实删除 | 不可复用（真 git 状态） |
| `check-workspace-tools` | **21 次**（21 用例各一个） | 84 次复制脚本树 | 扫描 | 规则命中 | 删临时目录 | **可复用，但收益小**：文件小，复制比重建更贵（见 E.5） |
| `worktree-readiness` | 23 次 | 230 次 git（几乎全是 `worktree`/`rev-parse`） | 就绪探测 | 判定与违规码 | 真实删除 | 不可复用（真实 worktree/分支） |

回答 Gate 3 的 11 个问题（摘要）：
1. **重复构建相同文件**：`check-workspace-tools`（21 次同构复制）、`pd-lab-experiment-config`（296 个同构 snapshot）。
2. **重复生成相同初始配置**：`release-contracts` 已是单次种子；`cleanup-task-worktree` 每用例新建但内容同构。
3. **重复计算相同 SHA256**：`aa-presence`（49,508）与 learning-lab（762,954）——前者是安全指纹，后者是业务枚举，**都不能删**。
4. **测试内重复创建**：`pd-lab-experiment-config` 296 个根 / 118 用例（2.5×），但总耗时仅 2.6s。
5. **可从不可变模板复制**：只有"多提交 git 仓库"这一类划算（见 E.5.1）。
6. **必须完全独立**：worktree 类、presence pack、任何共享 Ledger/预算的用例。
7–11. Cleanup 是被验行为的（sweep / quarantine / 删除）、依赖 mtime/权限/真实 refs 的，**一律不可复用**。

## E.5 Gate 4：四项潜在优化审计

### E.5.1 不可变 Fixture 复用 —— **实测否决**

关键测量（Phase III-C 同机数据，同一块 NVMe，含文件系统缓存）：

| 操作 | Windows NTFS | WSL2 ext4 |
| --- | ---: | ---: |
| 写 50 个 4KB 文件 | **15.2ms** | **0.9ms** |
| `cpSync` 复制同样的 50 文件树 | **58.1ms** | **3.8ms** |
| 写 1000 个 4KB 文件 | 292.3ms | 16.1ms |
| `cpSync` 复制 1000 文件树 | 724.9ms | 23.4ms |

→ **"模板 + 复制" 比 "直接重建" 贵 3.8–4.2×**。对小文件 Fixture，复制不是优化而是倒退。

唯一例外：**真实 git 仓库**。其建造成本由子进程主导（`init` 60ms + 每次 `commit` 130ms，
Phase III-A 实测），而复制一个 `.git` 目录（≈20 个文件）≈ 24ms。**只有"多提交仓库"适合模板化。**

### E.5.2 Fixture 内部重复初始化

- `release-contracts`：`tmp=1` → 已经只在 `beforeAll` 建一次种子，32 个用例共用。**无重复**。
- `pd-lab-experiment-config`：296 个根 / 118 用例，但**总耗时 2.6s**，且每个 snapshot 的独立性
  正是被验证的攻击面（symlink 逃逸）。**不可合并**。
- `check-workspace-tools`：21 个根 / 21 用例 —— 同构但小；按 E.5.1，改成"模板复制"更慢。

### E.5.3 文件系统操作去重

- `aa-presence` 的 51,330 次读 + 49,508 次哈希来自 `fingerprintTree`（污染审计前后各一次）。
  这是**安全断言**（Gate 6 第 11 条），删除即削弱负控制。
- `examiner-v09` 的 31,633 次读是业务数据遍历，不是重复 I/O。
- 未发现"同一路径在同一用例内被重复递归扫描且结果未被使用"的证据；需要逐用例插桩调用栈才能
  进一步确认，本轮**未取得该证据 → 标记 UNVERIFIED，不作为候选**。

### E.5.4 Fixture 架构分层

现状已事实上分层（纯逻辑 / 真 git / 真 worktree / 真进程），只是没有显式标签。
建议（仅建议，不实施）在文件头注释里标注 A–F 类型，便于以后做"哪些能挪平台"的判断；
**不迁移、不改执行位置**（Gate 6 明令禁止把跨平台测试改单平台）。

## E.6 Gate 5：实际收益计算

统一口径：所有"成本"用 Phase III-A/III-C 的**实测单价**折算；套件墙钟取本报告实测区间
**332.75s（本机热）— 585.6s（插桩 run）**，并用真实 CI Windows 368s 作为对照。

| 指标 | 当前实测 | 理论优化后 | 依据 |
| --- | ---: | ---: | --- |
| Fixture 根（mkdtemp） | 1,222 | 1,222 − (可模板化的仓库数 ≈ 12) = 1,210 | 只有 git 仓库值得模板化 |
| git 子进程 | 1,787 | 1,787 − 546（init/commit/clone/worktree 原语）= 1,241 | Phase III-A 分类计数 |
| 目录创建 | 6,534 | 不变 | 与 git 原语重叠，已计入 |
| 文件复制 | 925 | 不变 | 复制本身不是瓶颈 |
| 文件读 | 137,569 | 不变 | 安全指纹/业务遍历 |
| `createHash` | 1,041,184 | 不变 | 73% 是业务枚举 |
| Fixture 初始化耗时 | 55.9s（git 原语） | ≈ 15–25s | 模板复制替代 init+commit |
| Cleanup 耗时 | 1,604 次删除 | 不变 | 删除是被验行为 |
| **完整套件墙钟** | 332.75s（本机）/ 368s（CI Windows） | −5～12s | 见下 |

**墙钟推演【估算】**：
- 省下的 git 原语时间 ≤ 55.9s（**全部**消除，实际上不可能，因为大量 `commit` 是被验行为）。
- 按 2 workers：≤ 28s 墙钟；再扣除模板复制成本（每个仓库 ≈ 24ms × 12 ≈ 0.3s，可忽略）。
- 保守取"只模板化 init + 首个 commit"（≈ 30s 文件时间）→ **≈ 15s 墙钟**，对应
  585.6s 口径 **2.6%**、368s 口径 **4.1%**、332.75s 口径 **4.5%**。
- 乐观上限（全部原语）→ **≈ 28s**，对应 585.6s 口径 4.8%、368s 口径 7.6%、332.75s 口径 8.4%；
  但它会把"被验的 commit"换成复制，**语义不安全，不可采纳**。

**因此只有"保守 15s / ≤4.5%"是可采纳区间，并且它低于 5% 门槛。**

**AA presence 单文件**：本轮计数器显示其成本结构仍是 63% PowerShell（附录 C）+ 安全指纹，
**没有任何 Fixture 复用能改善它** → 0%。

## E.7 Gate 6：安全不变量审计

| 不变量 | 本轮审计结论 |
| --- | --- |
| 测试间状态隔离 | 全部依赖 `mkdtemp` 独立根；模板方案会用"复制到新根"保持隔离，但复制本身更贵 |
| 独立 Fixture 身份 | presence pack / worktree / ledger 均为每用例身份，**不可共享** |
| 真实 Git Worktree / refs | 12 个文件的断言对象就是真实 worktree 状态，**不可替换为模板状态** |
| 真实进程 / 进程树 / fail-closed | 全部保留；本轮零代码变更 |
| 并发安全 / 异常退出清理 | 未引入任何共享缓存或全局状态 |
| 双平台覆盖 | 未迁移、未删除任何平台用例 |
| 原有安全负控制 | 未删除、未弱化（sweep、指纹、污染审计、注册源校验全部原样） |

**结论**：任何"模板化 + 复制"的实现在隔离上是安全的，但**收益不足**；
任何"减少 commit/sweep/指纹"的实现**破坏不变量**，直接 NO-GO。

## E.8 Gate 7：候选优先级

| # | 候选 | 实测占比 | 重复度 | 可复用性 | 复杂度 | 回归风险 | 结论 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 多提交 Git 仓库模板化（约 12 个文件） | 3（55.9s/585.6s） | 4 | 3 | 4 | 4 | **P1（需额外证明，保守收益 3–4.5%）** |
| 2 | 小文件 Fixture 模板复制 | 1 | 2 | 1 | 2 | 2 | **NO-GO（实测更慢）** |
| 3 | `check-workspace-tools` 21 次同构复制合并 | 1 | 3 | 2 | 2 | 3 | **P2**（上限 ≈ 1s） |
| 4 | `pd-lab-experiment-config` 296 个 snapshot 合并 | 1 | 5 | 1 | 4 | 5 | **NO-GO（快照独立性即攻击面）** |
| 5 | 指纹/哈希去重（presence、learning-lab） | 4 | 2 | 1 | 5 | 5 | **NO-GO（安全断言/业务逻辑）** |
| 6 | Fixture 类型标签（文档级） | — | — | — | 1 | 1 | **可做，但无性能收益** |

## E.9 最终判定：**NO-GO**

| 决策条件（§10） | 结果 |
| --- | --- |
| 存在真实、重复的 Fixture 成本 | **满足**（1,222 根 / 19,180 写 / 1,787 git） |
| 该成本占套件实质比例 | **部分**：git 原语 55.9s，占插桩 run 的 9.5% |
| 明确的安全复用边界 | 只有"多提交仓库模板"这一条 |
| 保留原有测试语义 | 模板化会替换 `commit` 的被验语义 → **风险高** |
| 保留全部平台覆盖 | 满足（不迁移） |
| 套件 ≥5% 或 AA ≥10% | **不满足**：保守 2.6–4.5%，AA 为 0% |
| 不引入新的测试子系统 | 模板化需要一个 fixture 构建器 → **不满足** |
| 不增加复杂全局状态 | 模板需要版本/失效管理 → 压力大 |

**正式 NO-GO，不启动 Phase III-E 的代码实施。**

## E.10 下一步建议

1. **测试性能优化的边际收益已接近耗尽**：A（工具链）→ B（PowerShell）→ C（跨平台）→ D（Fixture）
   四轮下来，剩下的大头都是"被验行为本身"（真 git、真进程、真指纹）。
2. 若仍然要缩短 CI，**唯一没有被利用的杠杆在 CI 编排层**：Windows job 的
   `npm ci`（81s）+ `npm rebuild better-sqlite3`（62s）已被 `restore-node-modules` 缓存覆盖，
   应优先保证其命中率，而不是改测试。
3. **不建议**再投入"fixture 复用"方向；若未来测试规模显著增长（例如 138 → 300 文件），
   可重新评估 #1 候选，届时按本轮的方法先测"重建 vs 复制"再决策。

### E.11 本轮未做的事

- 未修改任何生产代码、测试文件、断言或 CI 配置。
- 未删除/合并任何测试，未改变 workers、timeout、pool。
- 未关闭 Defender 或任何安全防护。
- 未把 hash/业务枚举耗时误算成 Fixture 成本（已在 E.3.3 显式剔除）。
# 附录 D：Phase III-C — 跨平台性能归因

- 日期：2026-11-19
- 工作树：`D:\Code\_worktrees\principles\adhoc-20261119-cross-platform-perf-184954`
- 分支：`ai/adhoc-20261119-cross-platform-perf-184954`（**只含临时诊断 workflow，不合并到 main**）
- 基线：`origin/main` = `6cf8ced10`（#2721 已合并；#2723 仍 OPEN，其「附录 C」不在本附录范围内）
  注：附录 A / B 已在 main；**附录 C（Phase III-B）在 #2723 中尚未合并**，本附录不重复其内容，
  只在必要处引用其测量结论。
- **结论先行**：Windows 比 Linux 慢的每一秒，**主要不在 Node、不在 Vitest、也不在测试逻辑**，
  而在**每一次操作系统调用**：进程创建、进程枚举、以及 NTFS 上的文件打开/读写/删除/复制。
  同一台机器上，1000×4KB 的读取是 **80×**、目录复制 **31×**、真实进程枚举 **177×**；
  在 GitHub 托管 runner 上（同 SHA、同 Node 22），完整 Scripts 套件的**工作量**差 1.9–3.5×。
  **没有任何一个安全、语义等价、能在 Windows 上拿回 10–20% 的工程改造**，因此判定 **NO-GO**。

## D.1 实验环境与方法

### D.1.1 版本与命令（两侧完全一致，实测）

| 项 | 值 |
| --- | --- |
| Git SHA | `6cf8ced10`（诊断分支另有一个仅改报告输出的提交，**测试代码不变**） |
| Node | **v22.23.4**（两侧日志实测） |
| npm | **10.9.9**（两侧日志实测） |
| Vitest | 5.1.0（仓库锁文件，两侧一致） |
| 测试命令 A | `cd scripts && npx vitest run __tests__/aa-presence-run.test.mjs --reporter=json` |
| 测试命令 B | `cd scripts && npx vitest run --reporter=json` |
| Worker | 仓库 `scripts/vitest.config.ts` 的 `maxWorkers: 2`，**未覆盖** |
| Timeout | 仓库与用例自带值，**未修改** |
| 安装 | `npm ci --ignore-scripts`（**不**使用 `.github/actions/restore-node-modules`，以便测量真实安装成本） |
| 构建 | 与 `Test shared runtime & adapters` 相同的 6 个 workspace，顺序一致 |
| 缓存 | 冷 = 不用 `actions/cache`；热 = `setup-node cache: npm`。**冷热分开统计** |

### D.1.2 实验载体

临时 workflow `.github/workflows/perf-attribution-diagnostic.yml`（**只存在于诊断分支**）：

- `on: push` 到本诊断分支（`workflow_dispatch` 只对默认分支已存在的 workflow 开放，而本文件
  绝不能进 main，因此用空提交触发）；
- 同一 run 内 `ubuntu-latest` 与 `windows-latest` **同刻并行**（比交替顺序控制得更严：两个平台
  共享同一时间窗与同一次 GitHub 调度），每个平台得到 1 个样本；
- 5 个样本 = 3 冷（`cache=none`）+ 2 热（`[hot]` 提交），并发组 `cancel-in-progress: false` 串行执行；
- 逐步耗时直接来自 GitHub Jobs API 的 `started_at/completed_at`；测试级数据来自 `--reporter=json`
  产物（后 3 个样本由 `upload-artifact` 保留）。

### D.1.3 Runner 硬件（**混杂变量**）

| | Windows | Linux |
| --- | --- | --- |
| CPU | AMD EPYC **9V74** 80-Core（4 vCPU） | AMD EPYC **7763** 64-Core（4 vCPU） |
| 内存 | 16.0 GB | 15.6 GB |
| 内核/系统 | win32 10.0.26100 | linux 7.0.0-1019-azure |

两者 CPU 型号不同，托管 runner 无法证明硬件等价 → **硬件差异是混杂变量**，本文所有跨平台数字
都在此前提下解读（§D.9）。

## D.2 五次成对采样【实测】

同一 run 内 Linux 与 Windows 并行；`AA` / `suite` 为 GitHub step 墙钟，`sumFile` 为该平台 vitest
报告里所有测试文件时长之和（= 真实工作量，不含 worker 空转）。

| # | 缓存 | 安装 W/L | 原生编译 W/L | 构建 W/L | AA step W/L | suite step W/L | AA sumFile W/L | suite sumFile W/L |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | cold | 97s / 52s | 62s / 4s | 9s / 8s | 75s / 38s | 358s / 200s | 68.3s / 33.1s | 598.1s / 311.7s |
| 2 | hot | 78s / 37s | 94s / 5s | 9s / 6s | 75s / 31s | 368s / 163s | 68.0s / 27.0s | 612.5s / 263.8s |
| 3 | cold | 81s / 35s | 47s / 3s | 12s / 5s | 91s / 26s | 457s / 139s | 93.9s / 25.6s | 764.0s / 220.8s |
| 4 | cold | 81s / 45s | 71s / 3s | 12s / 8s | 96s / 32s | 469s / 186s | 88.0s / 28.2s | 758.7s / 286.2s |
| 5 | hot | 54s / 43s | 47s / 4s | 9s / 7s | 75s / 32s | 343s / 173s | 68.9s / 27.9s | 568.9s / 273.6s |
| **中位** | | **81s / 43s** | **62s / 4s** | **9s / 7s** | **75s / 32s** | **368s / 173s** | **68.9s / 27.9s** | **612.5s / 273.6s** |

| 指标（中位） | Windows | Linux | 比值 |
| --- | ---: | ---: | ---: |
| AA 单文件 step | 75s | 32s | **2.34×** |
| AA 单文件 sumFile（工作量） | 68.9s | 27.9s | **2.47×** |
| 完整套件 step | 368s | 173s | **2.13×** |
| 完整套件 sumFile（工作量） | 612.5s | 273.6s | **2.24×** |
| `npm ci` | 81s | 43s | 1.88× |
| `npm rebuild better-sqlite3` | 62s | 4s | 15.5× |
| workspace 构建（tsc） | 9s | 7s | 1.29× |

计数一致性：Windows 5 个样本均为 **2926 passed / 27 skipped**（样本 1 另有 1 个 flaky 失败，
复跑消失）；Linux 5 个样本均为 **2936 passed / 17 skipped / 0 failed**。两侧测试总数同为 2953，
差的 10 个 skip 是 GNU 归档工具相关用例（Windows 不跑）。

**冷 vs 热（无混淆）**：安装阶段冷 97s→热 54–78s（Windows）、52s→37–43s（Linux）；
`npm rebuild better-sqlite3` 在 Windows 上 **47–94s**，Linux **3–5s**（Windows 走源码编译）。
缓存只影响安装阶段，**对测试阶段无可见影响**，因此测试数字不区分冷热。

## D.3 同机对照：Windows 原生 vs WSL2（ext4）【实测】

WSL2 可用（Ubuntu-24.04，Node 22.22.2，32 vCPU，24 GB）。仓库放在 WSL 的 **ext4**（`/home`，非 `/mnt/c`），
与 Windows 原生共用同一块 NVMe 与同一颗 i9-13900KF。**注意：WSL2 不是原生 Linux runner，单独报告**。

| 目标 | Windows 原生（Node 26.12.1） | WSL2 ext4（Node 22.22.2） | 比值 |
| --- | ---: | ---: | ---: |
| AA presence 单文件（3 次中位） | **112.8s** | **21.8s** | 5.2× |
| 完整 Scripts 套件 | **332.75s**（3 次中位，2919 passed / 0 failed） | **167.6s**（2933 passed / 2 failed / 18 skipped） | 1.99× |
| 套件 sumFile | — | 308.1s | — |

WSL 侧 2 个失败均在 `release-immutable-candidate.test.ts`（Windows 上该文件因缺 GNU 归档工具**整文件 skip**），
属环境差异，不影响耗时对照；但如实记录：**WSL 样本不是全绿**。

## D.4 进程创建与进程枚举【实测，各 30 次】

### D.4.1 子进程启动（父进程观测的完整执行成本，中位/P90）

| Windows | 中位 | P90 | Linux | 中位 | P90 | 比值 |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| `node -e 0` | **36.9ms** | 43.9ms | `node -e 0` | **16.5ms** | 19.3ms | 2.2× |
| `cmd /c exit 0` | **17.1ms** | 24.3ms | `sh -c true` | **0.7ms** | 0.9ms | 24× |
| `powershell -NoProfile -Command "exit 0"` | **112.0ms** | 130.8ms | `ps -eo …` | **2.5ms** | 3.0ms | 45× |
| `where.exe taskkill` | 55.3ms | 63.6ms | — | — | — | — |
| `taskkill /?` | 23.3ms | 29.0ms | — | — | — | — |

### D.4.2 真实进程枚举（**生产代码路径** `findProcessesReferencing`）

| 平台 | 实现 | 中位 | P90 | 最大 |
| --- | --- | ---: | ---: | ---: |
| Windows | PowerShell + `Get-CimInstance Win32_Process` + JSON | **548.6ms** | 576.4ms | 576.4ms |
| Linux | `ps -eo pid=,ppid=,args=` + 文本解析 | **3.1ms** | 4.0ms | 4.0ms |
| 比值 | | **177×** | | |

**语义等价性说明**：两条实现的目标一致（枚举 PID/PPID/名称/命令行并做子串匹配，排除 launcher 祖先），
差异在**机制**：Windows 必须起一个 112ms 的 PowerShell 再做一次全表 WMI 枚举（≈370–485ms），
Linux 只需 2.5ms 的 `ps` 加文本解析。这不是实现质量问题，是平台能力差异。

### D.4.3 调用频率【实测，来自附录 C 的 instrumented 运行】

`aa-presence-run.test.mjs` 单次运行：`findProcessesReferencing` **132 次 / 66.16s**（占该文件 63%），
`sweepPackProcesses` 约 60 次，`killTree` 2 次。与源码推导一致（每 sweep 2 次查询、每 preflight 探针 1 次）。

## D.5 文件系统【实测，同机同盘，30 次（写/复制类 5 次）】

样本由脚本现场生成，两侧**文件数、大小、内容、层级、总字节完全相同**：

| 操作 | Windows NTFS | WSL2 ext4 | 比值 |
| --- | ---: | ---: | ---: |
| `readdir`（单目录 50 项） | 0.1ms | 0.0ms | — |
| `stat` × 50 | 0.6ms | 0.1ms | 6× |
| `readFile` × 50（4KB） | **18.8ms** | **0.2ms** | **94×** |
| 递归遍历 50 文件 | 2.5ms | 0.2ms | 12× |
| SHA256 整树（50×4KB） | 21.8ms | 0.5ms | 44× |
| `cpSync` 整树（50×4KB） | 58.1ms | 3.8ms | 15× |
| `writeFile` × 50 | 15.2ms | 0.9ms | 17× |
| `stat` × 1000 | 13.6ms | 0.5ms | 27× |
| `readFile` × 1000（4KB） | **375.7ms** | **4.7ms** | **80×** |
| SHA256 整树（1000×4KB） | **376.7ms** | **6.2ms** | **61×** |
| `cpSync` 整树（1000×4KB） | **724.9ms** | **23.4ms** | **31×** |
| `writeFile` × 1000 | 292.3ms | 16.1ms | 18× |

结论：
1. Windows 在**大量小文件**上显著更慢（80–94×），且成本与**单次文件打开**强相关（每文件 ≈ 0.37ms vs 0.004ms）。
2. 复制与哈希的成本几乎全部由"逐文件读"构成（哈希 1000 文件 = 读取 1000 文件）。
3. NTFS vs ext4 的差距在本机为 31–94×；WSL2 有虚拟化层，**真实 Linux runner 的绝对值会更高**
   （CI 实测 Linux 侧 sumFile 更慢于 WSL，见 D.7），因此该表只用于**同机相对比较**。
4. 测量机 `Get-MpComputerStatus`：RealTimeProtection / OnAccessProtection / BehaviorMonitor **均为 True**，
   **未关闭任何防护**。Defender 对每个新建/读取文件做扫描，是上表差距的合理组成部分（**推断**，
   未做"关闭防护"的对照实验，因为那违反本轮约束）。

## D.6 Node Runtime 与 Vitest 调度【实测】

| 指标 | Windows（Node 26） | WSL（Node 22） | 比值 |
| --- | ---: | ---: | ---: |
| 20k 行 JSON 解析 | 4.6ms | 3.1ms | 1.5× |
| ESM 模块冷导入（`ledger.mjs`，带 cache-bust） | 0.6ms | 0.4ms | 1.5× |
| 空 `node` 进程启动 | 36.9ms | 16.5ms | 2.2× |

**纯 CPU 工作（解析、模块求值）两侧基本一致（1.5× 以内，且含 Node 版本差异）**；
差距集中在"启动进程"和"碰文件"。Vitest 侧：两侧 `maxWorkers` 都是 2，配置未改；
本轮未单独拆出 worker 启动成本（它被计入每个文件的首个用例），归入 §D.7 的"文件级基线"。

> **Node 版本对照的限制（如实报告）**：为消除版本混杂，曾尝试在本机 Windows 上用官方
> Node 22.23.4 运行 AA 文件，结果 25/100 失败（`execution-code` 检查拒绝了树外 Node 二进制），
> 该路径 **NOT_USABLE**；**同 Node 版本的对照以 CI 为准**（两侧均为 22.23.4）。

## D.7 逐文件归因：Windows 多花的每一秒在哪里【实测】

样本 3（冷，同一 run 内），`suite.json` 逐文件时长，Windows 与 Linux 一一配对：

| 测试文件 | Windows | Linux | 差值 | 倍数 |
| --- | ---: | ---: | ---: | ---: |
| `aa-presence-run.test.mjs` | 93.9s | 25.6s | **+68.3s** | 3.67× |
| `release-contracts.test.ts` | 86.6s | 19.7s | **+67.0s** | 4.40× |
| `cleanup-task-worktree.test.ts` | 71.1s | 6.2s | **+64.9s** | **11.45×** |
| `principle-learning-lab-challenge-b1.test.ts` | 48.5s | 15.7s | +32.9s | 3.10× |
| `workspace-lifecycle.test.ts` | 32.7s | 2.9s | +29.8s | 11.43× |
| `principle-learning-lab-phase2a-final-metrics.test.ts` | 52.0s | 23.6s | +28.4s | 2.20× |
| `principle-learning-lab-ceb002-contract.test.ts` | 39.5s | 15.8s | +23.7s | 2.50× |
| `check-workspace-tools.test.ts` | 26.6s | 5.0s | +21.5s | 5.27× |
| `workspace-residue-cleanup.test.ts` | 21.4s | 1.3s | +20.1s | 16.11× |
| `check-naming-policy.test.mjs` | 33.3s | 13.3s | +20.0s | 2.50× |
| `release-finalize-tag.test.ts` | 21.6s | 6.9s | +14.7s | 3.11× |
| `workspace-lease.test.ts` | 15.4s | 1.4s | +14.0s | 10.74× |
| `worktree-readiness.test.ts` | 12.8s | 0.7s | +12.1s | 19.37× |
| `worktree-claim.test.ts` | 12.8s | 1.2s | +11.6s | 10.87× |
| `impact.test.ts` | 12.9s | 1.5s | +11.4s | 8.70× |
| …（其余 123 个文件） | … | … | … | … |
| **合计（138 文件）** | **764.0s** | **220.8s** | **+543.2s** | **3.46×** |

按"是否直接 import `node:child_process`"分组（粗略分类，仅用于量化，不替代上表）：

| 组 | 文件数 | Windows | Linux | 差值 | 倍数 | 占总差值 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 直接起子进程 | 41 | 506.7s | 150.0s | +356.7s | 3.38× | **65.7%** |
| 重依赖（fs/sqlite/cp） | 15 | 46.5s | 8.5s | +38.0s | 5.47× | 7.0% |
| 其余 | 73 | 198.7s | 58.1s | +140.7s | 3.42× | 25.9% |
| 未分类 | 9 | 12.1s | 4.2s | +7.9s | 2.88× | 1.5% |

**读法**：即使"不import child_process"的 73 个文件也慢 3.4×——它们同样建临时目录、写文件、删除文件。
所以差距不是"某几个慢测试"，而是**每一次 OS 调用都更贵**，在 2900+ 用例上累积。

## D.8 完整成本模型（五次样本中位，对账）

### D.8.1 整 job

| 成本项 | Windows | Linux | 差值 |
| --- | ---: | ---: | ---: |
| Runner 启动 + checkout + setup-node | 13s | 5s | +8s |
| `npm ci --ignore-scripts` | 81s | 43s | +38s |
| `npm rebuild better-sqlite3` | 62s | 4s | +58s |
| 6 个 workspace 构建（tsc） | 9s | 7s | +2s |
| **Target A（AA 单文件）** | 75s | 32s | +43s |
| **Target B（完整套件）** | 368s | 173s | +195s |
| 汇总/上传 | 1s | 1s | 0 |
| **合计（job 墙钟）** | **≈609s** | **≈265s** | **+344s** |

### D.8.2 Target B 内部（368s vs 173s，2 workers）

| 项 | Windows | Linux | 说明 |
| --- | ---: | ---: | --- |
| 测试文件工作量 sumFile | 612.5s | 273.6s | 138 个文件 `endTime−startTime` 求和（5 次中位） |
| 理论墙钟（sumFile ÷ 2） | 306.3s | 136.8s | 完美并行假设 |
| 实际墙钟 | 368s | 173s | 并行/调度效率 83.2% / 79.1% |
| 并行/调度损失 | 61.7s | 36.2s | 实际 − 理论 |
| **对账** | 306.3 + 61.7 = 368 ✓ | 136.8 + 36.2 = 173 ✓ | **无未解释余量** |

**工作量差 338.9s 的分配**【比例来自样本 3 的逐文件实测（§D.7），绝对秒数按中位数缩放，**估算**】：

| 组 | 占比 | 折算秒数（中位口径） |
| --- | ---: | ---: |
| 直接起子进程的测试文件（41 个） | 65.7% | ≈223s |
| 无 child_process 但做真实 FS 的测试文件（73 个） | 25.9% | ≈88s |
| 重依赖文件（15 个） | 7.0% | ≈24s |
| 未分类（9 个） | 1.5% | ≈5s |

**Unattributed = 0**：所有分项都能回指到具体测试文件；没有"消失的时间"。

> §D.7 的逐文件表来自**样本 3**（冷，Windows 偏慢的一次，整体 3.46×）。中位样本的倍数是 2.24×，
> 因此**比例结构**可用，**绝对秒数**不要直接搬到中位口径。

## D.9 混杂变量（明确记录）

1. **CI 硬件不同**：Windows = EPYC 9V74，Linux = EPYC 7763，无法证明等价。因此"倍数"应理解为
   **平台族差异 + 硬件差异**的上界，不能全部归因于 OS。
2. **同机对照的 Node 版本不同**（26.12.1 vs 22.22.2）。为抵消这一点，CI 实验两侧固定 Node 22.23.4；
   本机对照仅用于"同硬件、同磁盘"的相对量级（§D.3、§D.4、§D.5）。
3. **Windows Defender 状态在 CI 镜像上不可验证**（本机为开启）。本期未关闭任何防护。
4. **skip 数量不同**：Windows 跳 17 个 GNU 归档用例（`release-immutable-candidate`），Linux 实跑；
   即 Windows 的 358–457s 里**还少了 17 个用例**，真实差距比表格更不利。
5. **WSL2 有虚拟化层**，且 `/home` 之外的路径未测试；不代表生产 Linux runner 的绝对性能。
6. 样本 3 的 Windows runner 明显更慢（suite 457s vs 358/368s），单样本波动 ±25%；
   结论取 5 个样本的区间而非单点。

## D.10 优化候选与 GO / NO-GO

| # | 候选 | 真实瓶颈（实测） | 当前耗时 | 理论上限 | 预计收益 | 影响范围 | 安全风险 | 复杂度 | 建议 |
| --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| A | Windows 进程枚举换实现 | CIM 全表枚举 370–485ms/次，每次 sweep 2 次 | 66.2s/文件 | 换成 `ps` 等价物**在 Windows 不存在** | 0 | scripts | 无（无改动） | — | **NO-GO** |
| B | sweep 双会话合单会话 | 见附录 C：单次 970→831ms | 66.2s/文件 | −8.3s | 文件 −7%；套件 −1.2% | presence-run | 中 | 中 | **NO-GO**（未达门槛） |
| C | 减少小文件读写/哈希 | NTFS 单文件 0.37ms vs 0.004ms | 套件差值 140.7s | 需改测试/夹具设计 | 不可安全量化 | scripts | 中 | 高 | **NO-GO（本轮）** |
| D | 复用只读 Fixture | `makePack` 245ms × 34 ≈ 8.3s | AA 文件 | 8.3s | 文件 −6%；套件 <1% | scripts | 高（34 组参数不同） | 高 | **NO-GO** |
| E | Windows 原生模块编译（`npm rebuild`） | 47–94s/次，Linux 3–5s | job 的 7–13% | 用预编译产物或缓存 | 真实 CI 已被 `restore-node-modules` 缓存覆盖 | CI | 低 | 低 | **已缓解，无需动作** |
| F | 把部分测试移到 Linux 跑 | Windows 独有夹具成本 | — | 不可接受 | — | CI | **会削弱平台覆盖** | — | **禁止** |
| G | 常驻 PowerShell 助手进程 | 每次查询省 112ms 启动 | 66.2s/文件 | −6.7s | 文件 −6% | presence-run | 中高（常驻进程、生命周期、僵尸） | 高 | **NO-GO** |

**决策 Gate（§8）逐条**：

1. ≥5 次两平台可比运行 —— **满足**（3 冷 + 2 热）。
2. 主要差异已有实测证据 —— **满足**（§D.4–D.7）。
3. 有明确可优化成本 —— **不满足**：成本已被证明是 OS 原语级（进程创建、CIM 枚举、NTFS 打开），
   不是工程浪费。
4. AA 测试 ≥10% 或套件 ≥5% —— **不满足**：唯一可行的 B 只值文件 −7% / 套件 −1.2%。
5. 不损害安全不变量 —— B 可以做到，但收益不足；A/C/D/G 都触及安全或夹具语义。
6. 不引入不必要复杂度 —— B/G 都会引入新机制。

→ **NO-GO：不进入 Phase III-D 的代码实施。**

## D.11 对下一阶段的建议

1. **不要在 Windows 上追求与 Linux 相同的测试墙钟**：在 4 vCPU 托管 runner 上，Windows 的
   OS 原语成本（进程创建 2–24×、进程枚举 177×、小文件 I/O 31–94×）是不可工程消除的。
2. 若要缩短 **Windows CI 墙钟**，唯一安全且有量级的方向在**测试之外**：
   - 保持并扩大 `restore-node-modules` 缓存命中（已覆盖 `npm ci` + `npm rebuild` 的 128–175s）；
   - 复核 Windows job 是否必须与 Linux 跑同一套 138 个文件，还是可以把**平台无关**的纯逻辑文件
     标记为"仅一个平台执行 + 另一平台保留契约测试"——但这会改变覆盖语义，**需要 Owner 决策**。
3. 若继续做性能工作，下一优先项应回到 **Linux 侧**（成本最低、可优化空间最大、且是 CI 主路径）。
4. `release-contracts` / `cleanup-task-worktree` / `workspace-lifecycle` 这三个文件在 Windows 上是
   8–11× 的"真 worktree + 真提交"成本，若要动，属于**测试夹具架构**议题，不是平台调优。



