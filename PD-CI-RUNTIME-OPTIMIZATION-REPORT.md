# PD CI & Test Runtime Optimization — Phase II 实施报告

- 日期：2026-11-18
- 分支：`ai/adhoc-20261118-ci-runtime-optimization-f0466b`
- 基线：`origin/main` = `9b63a24a9`（#2710 未合并，本分支不含其提交）
- PR：https://github.com/csuzngjh/principles/pull/2712
- 工作树：`D:\Code\_worktrees\principles\adhoc-20261118-ci-runtime-optimization-f0466b`

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
| 1 | 把 `verify-merge` 已用数周的「物化 node_modules 缓存」推广到 **11 个 Linux/Node22 安装点**（一个 composite action、一个 key） | 复用既有机制 | 安装步骤 **28–53s → 4–6s**；`pd-mcp-server` job 82s → 30s |
| 2 | `build-openclaw-plugin` 并入 `test-openclaw-plugin-coverage` | 消除重复 install + build | 273s（62+211）→ **143s**；job 数 15 → 14 |

另有 **2 处接入在实测后回退**（净收益不为正，见 §4.5）：Windows 条目还原 58–72s ≈ 原 install 64s；Node20 条目还原 45–52s > 原 install 37s。

**结果【实测，中位数】**：job-min **45.64 → 36.63（−19.7%）**；执行墙钟 **515s → 411s（−20.2%）**。三项探索目标（墙钟 −15~20%、job-min −10~15%、shared runtime −20%）全部达到。最终 SHA（含两处回退）单次复测为 39.32 job-min / 459s，落在优化后方差区间内（详见 §9）。

**未达标/受阻项**（全部给出瓶颈，不做数字美化）：

- Shared Runtime 只降到 286s（−44%），但**该 job 末尾 `Test codex-adapter` 确定性失败**（PRI-1271，与本次改动无关），`pd-companion` 步骤被跳过。
- Installer / Packaged Install 的内部优化 **BLOCKED**：与仍 OPEN 的 #2710 范围重叠。
- 「inspector ≈ 2.75 min」在当前仓库 **NOT_REPRODUCED**（不存在 inspector 包/测试目录）。
- 本地 4/6/8 worker 全矩阵基准未在本轮完成（见 §7 的实测边界说明）。

---

## 2. Latest Source Verification

### 2.1 三项只读核实（只核实，未行动）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| #2710 是否已合并 | **否**：`state=OPEN`、`mergedAt=null`、`mergeStateStatus=UNSTABLE`、head `ai/adhoc-20261118-test-infra-b8620e` | `gh pr view 2710` |
| `Export Surface Gate` 是否为 Required Status Check | **否**：main 分支保护的必需 contexts 只有 `Verify Merge Gate` 与 `Test principles-core` | `gh api repos/:owner/:repo/branches/main/protection` |
| codex-adapter 的 Windows 失败是否已有独立工单 | **有，且不是 Windows 特有**：`PRI-1271`（P1/Urgent，Backlog）已定位为真实夹具越过 `GOVERNANCE_RETENTION_MAX_AGE_MS = 7d` 的 body 保留窗，自 `2026-11-18T11:58Z` 起**所有分支**确定性失败 | Linear `PRI-1271` 正文 |

> **对上一轮结论的修正**：上一轮把该红点归因为「#2699 的 Windows 盘符/realpath 差异」。PRI-1271 的证据链（夹具时间戳 `2026-11-11T11:58:20Z` + 7 天）说明它是**时间**问题，不是 Windows 问题。本轮不沿用错误前提，也不修复它。

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

本 PR run：`workbuddy(Windows fixtures)` start+78s（Windows runner 分配等待）+325s = **403s**，与墙钟 406s 吻合。

这里暴露一个**新的关键路径事实**：Windows runner 的分配等待（约 60–78s）此前被 shared runtime 的 509s 掩盖；一旦 shared runtime 变短，**Windows runner 排队时间就成了墙钟的主导项**。这是本轮最有价值的结构性发现（§12 给出后续建议）。

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

净效果：11 个 Linux/Node22 job 合计约 **−390 job-seconds/run**。

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

### 7.2 本轮未完成的全矩阵（诚实标注）

指令要求对 6 个包做 2/4/6/8 worker × 3 次重复。本轮实际执行情况：

- 本地 32 核 / 64GB，`scripts` 套件 worker 扫描已启动（2/4/6/8 × 2 次）；
- 在报告定稿时，**该矩阵未跑完**，因此**不给出未测出的结论**。worker 相关决策全部只用 §7.1 这一条实测证据，其余保持现状。

这与「无法达到就说明真实瓶颈，不允许伪造收益」一致：本轮**没有**任何 worker/分片改动，因为唯一有证据的包（core）已被现有反脆弱设计固定，其余包没有证据支持改动。

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

---

## 9. Before / After Benchmark

### 9.1 汇总（≥3 次可比运行的中位数）

采样：

- **优化前**：main 4 次全是成功运行（44262597745 / 44265041579 / 44278152737 / 44296956347）。
- **优化后 A**：本 PR 的 3 次运行，同一 SHA `cdcb82fcb`（44314147995 PR 事件 / 44315480013 / 44315542875 两次 dispatch）。
- **优化后 B（最终 SHA）**：`a6ed66dff` 的 1 次运行（44317108299），包含两处「实测负收益」的回退。

| 指标 | 优化前（中位） | 优化后 A（3 次中位） | 优化后 B（最终 SHA，1 次） | 实际收益 |
| --- | --- | --- | --- | --- |
| CI job 数 | 15 | 14 | 14 | −1 |
| **CI job-minutes** | **45.64** | **36.63** | **39.32** | **−19.7%（中位）/ −13.8%（最终单次）** |
| **CI 执行墙钟**（已剔除排队/调度等待） | **515s** | **411s** | **459s** | **−20.2% / −10.9%** |
| 调度等待 | 0–3s | 0–2s（另一次因并发组串行 421s，已剔除） | 2s | — |

逐 job 中位数（优化前 4 次 / 优化后 A 3 次）：

| job | before | after A | 变化 |
| --- | --- | --- | --- |
| Test shared runtime & adapters | 496s | 379s（**3 次均 failed**） | −117s |
| Test create-principles-disciple | 439s | 397s | −42s |
| Test packaged install smoke | 321s | 252s | −69s |
| Test workbuddy-adapter (Windows) | 274s | 325s（2 成功 / 1 flake） | +51s |
| Test OpenClaw Plugin（合并后） | 274s（=211+62 两个 job） | 143s | **−131s** |
| Test principles-core | 206s | 192s | −14s |
| Verify Merge Gate | 201s | 225s | +24s |
| Test pd-cli | 196s | 160s | −36s |
| Test pd-console | 148s | 116s | −32s |
| Test pd-mcp-server | 95s | 41s | −54s |
| Codex plugin delivery contract | 79s | 37s | −42s |
| Test skill render contract | 70s | 69s（含 +6s 冷缓存开销） | −1s |
| CI Impact Gate | 14s | 13s | −1s |
| Telemetry Union Guard | 10s | 10s | 0 |

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

### 10.2 CI【实测，最终 SHA `a6ed66dff` / run 44317108299】

最终 SHA 的 14 个 job：13 绿、1 红（`Test shared runtime & adapters`，仅 codex-adapter 的 PRI-1271）。下表为该次运行的结果。

| 检查 | 结果 |
| --- | --- |
| `Verify Merge Gate` | PASS（196s） |
| `Test principles-core`（含导出面门禁） | PASS（210s） |
| `Test pd-console` / `pd-cli` / `pd-mcp-server` | PASS |
| `Test OpenClaw Plugin (unit+integration+coverage)`（合并后） | PASS（143s，含 tsc + pack dry-run） |
| `Test workbuddy-adapter`（Windows） | PASS（325s） |
| `Test create-principles-disciple` / `Test packaged install smoke` | PASS |
| `Test skill render contract` / `Codex plugin delivery contract` | PASS |
| `Test shared runtime & adapters` | **FAIL** — 仅 `Test codex-adapter`，PRI-1271 |

**关于唯一红点**：`Test shared runtime & adapters` 在 `Test codex-adapter`（50s）失败，后续 `pd-companion` 被跳过。

- 与本次改动无关的证据：`git diff origin/main -- packages/codex-adapter` 为空；失败用例是 `tests/ingestion/ingestion.test.ts > v0.167.0-alpha.4.1 real fixture`，断言 `expected '' to contain 'probe assistant visible reply'`——正是 PRI-1271 记录的 body 过期形态。
- 该缺陷自 `2026-11-18T11:58Z` 起对**所有分支**生效，`main` 自身也会红。
- 因此「完整 canonical CI 全绿」在本轮**不可达**，标记 **BLOCKED（外部缺陷 PRI-1271）**，不以任何方式绕过（未加 skip、未改夹具、未放大 timeout）。

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

1. **Windows runner 分配等待（新瓶颈）**：改动后 `workbuddy` 在 start+78s 才开始，占墙钟 406s 的 19%。可考虑把 Windows 夹具测试移到 `schedule`/合并到已有 Windows 作业，或改用 Linux + 显式 `D:\` 路径注入（需先证明夹具的绝对路径要求可参数化）。**需要独立取证，本轮不做**。
2. **installer / packaged smoke 内部**：待 #2710 合并后再评估（范围冲突，已 BLOCKED）。
3. **scripts Git fixture 共享 / seed repo**：潜在最大单点收益（scripts 132s），但需要独立 SPEC 级的隔离论证。
4. **PRI-1271 修复**：修掉后 shared runtime 可恢复全绿；与本轮无关。
5. **导出面门禁设为分支保护必需检查**：治理决策，需 Owner 决定，本轮只核实未行动。

---

## 13. PR Information

- PR：https://github.com/csuzngjh/principles/pull/2712
- 标题：`perf(ci): one shared node_modules cache + fold the duplicate plugin build job (15->14 jobs)`
- 提交：1 个（真实 pre-commit / pre-push 通过）
- 状态：**未合并、未开 auto-merge、未部署**；未触碰 `~/.pd/runtime` 与生产 workspace
- 变更文件：
  - `.github/actions/restore-node-modules/action.yml`（新增）
  - `.github/workflows/ci.yml`（安装点收敛 + 合并 job）
  - `.github/workflows/pd-console-e2e.yml`、`.github/workflows/pr-checks.yml`（接入同一缓存）
  - `docs/process/TESTING.md`（job 清单 15→14 与机制说明）
  - `scripts/__tests__/ci-impact-gate-contract.test.ts`（gated 计数 11→10）
  - `PD-CI-RUNTIME-OPTIMIZATION-REPORT.md`（本报告）
- 回滚：删除 action、恢复 `npm ci --ignore-scripts`、恢复 `build-openclaw-plugin`、计数改回 11。无持久状态。

---

## 附录 A：三阶段反馈（本地）

只读审查结论，未改动：

| 层次 | 现状 | 是否有重复 |
| --- | --- | --- |
| 快速反馈（pre-commit） | worktree-guard + eslint --fix(staged) + repo-hygiene(staged) + commit-identity | 无；全部 O(变更文件) |
| 包级验证（pre-push） | `pre-push-fast.mjs` 复用 `computeImpact`，只查改动文件的语法与按包 eslint | 无；已刻意避开 PRI-961 的 Windows OOM 与「第二套依赖图」 |
| 合并门禁 | per-package job + `verify-merge` + `test-principles-core` | 是（见 §4.4 / §8.1），已在本轮收敛 |

本轮额外把 `pr-checks.yml` 的 `Dependency Audit`（只为 `npm audit` 而 `npm ci`）改为共享缓存，Node 24→22（audit 与 Node 版本无关），避免第三个 ~1.5GB 缓存条目。
