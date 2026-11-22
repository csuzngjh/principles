# CodeQL CI 性能审计（只读量测版）

- 日期：2026-11-11
- 仓库：`csuzngjh/principles`（public）
- 范围：仅量测与方案，**未修改任何工作流/配置**
- 原始证据：`.tmp/codeql-audit/`（会话临时目录，已 gitignore）

---

## 0. 结论摘要

1. **CodeQL 不是 PR 的 required check，也几乎不在关键路径末端**：15 个成功 PR 中只有 1 次（7%）CodeQL 是最后完成的检查；中位数比最后一个其它检查**早 6.9 分钟**结束。
2. **但它确实是 CI 的容量黑洞**：7 天内 943 次运行，总墙钟约 **6,600 分钟/周（≈110 小时/周）**，处于 4 vCPU 的 hosted runner 上，因此把 CI 排队时间推高（CodeQL job 排队 p90 = **456s**，p50 = 52s）。
3. **单次 job 的真实耗时**：p50 **425s（7.1 min）**，p90 **562s（9.4 min）**，max 581s；其中 `Perform CodeQL Analysis` 一步占 **92%**，而这一步里 **56% 是查询求值、24% 是源码抽取**。
4. **主因不是语言、matrix、多入口或缓存**（这些都已是最优），而是三件事：`security-and-quality` 这个重量级 suite（203 条查询）、**对零 AngularJS 代码的仓库仍执行 9 条 AngularJS 查询（占查询串行时间 23.3%）**、以及**触发量过大（每次 push 都跑 + 每次合并到 main 再跑一遍）**。
5. **不降覆盖的提速组合**（本报告 Phase 1）预计把单次 PR 分析从 7.1 min 压到 **4.3–5.0 min（−30%~−40%）**，并让 **20% 的 PR 完全跳过**；合计每周节省约 **2,500 个 runner 分钟（≈42 小时）**，安全覆盖在 main/周扫全量中完整保留。

---

## 1. 现状盘点（配置事实）

### 1.1 唯一入口

| 项目 | 实测值 | 证据 |
| --- | --- | --- |
| 工作流文件 | 只有 `.github/workflows/codeql.yml` | `.github/**` 全量 grep `codeql/CodeQL` 仅命中该文件 |
| GitHub 默认设置（Default setup） | **未启用**（`state: not-configured`） | `GET /repos/.../code-scanning/default-setup` |
| 已上传分析的 analyzer | 只有 `CodeQL 2.27.4`，category 只有 `/language:javascript-typescript` | `GET /repos/.../code-scanning/analyses` 最近 30 条 |
| `.github/codeql/**` 配置目录 | **不存在**（无 codeql-config.yml） | 文件系统检查 |

结论：**不存在"旧版 action + 新版默认扫描并存"的双入口问题**，可以排除该类根因。

### 1.2 工作流关键参数（[codeql.yml](file:///d:/Code/principles/.github/workflows/codeql.yml)）

| 维度 | 配置 |
| --- | --- |
| 触发 | `push: main`、`pull_request: main`、`workflow_dispatch`、`schedule: 23 4 * * 1`（每周一） |
| paths-ignore | `docs/**`、`**.md`、`**.mdx`（2026-10-27 新增） |
| concurrency | `codeql-{pr号或ref}`，仅 PR 上 `cancel-in-progress: true` |
| 语言矩阵 | 1 个：`javascript-typescript` |
| query suite | `security-extended,security-and-quality`（两个 suite 叠加） |
| build-mode | 未声明；实际走 `autobuild`，对 JS/TS 是空操作（实测 2–4s） |
| action 版本 | `github/codeql-action/*@v4.38.2`（CodeQL bundle 2.27.4） |
| checkout | `fetch-depth: 0` + `persist-credentials: false` |
| permissions | `contents: read` + `security-events: write` |
| job timeout | 30 min |
| 缓存 | 无自定义缓存（bundle 由 hosted runner toolcache 提供） |

### 1.3 required check 与分支保护

`GET /repos/.../branches/main/protection`：

- `required_status_checks.contexts = ["Verify Merge Gate"]`，`strict = true`
- `Analyze (javascript-typescript)` **不在** required checks 中

所以：**CodeQL 不阻塞合并**；`strict: true` 才是"每次 rebase/更新 base 都要重跑一遍所有检查（含 CodeQL）"的放大器。

---

## 2. 运行量（近 7 天）

| 指标 | 值 |
| --- | --- |
| CodeQL 运行总数（7 天） | **943** |
| 抽样 600 次的事件分布 | `pull_request` 480（80%）、`push` 118（20%）、`schedule` 1、`workflow_dispatch` 1 |
| 被 concurrency 取消 | 82 / 596 = **14%**（取消前已平均跑约 2.3 分钟，属纯浪费） |
| 完成运行的墙钟总和（抽样 596 次） | **4,169 分钟** |
| 墙钟分布（抽样） | p50 7.1 min、p90 9.6 min、max 21.6 min |
| 外推到 7 天全部 943 次 | ≈ **6,600 分钟/周 ≈ 110 小时/周** |

突发性极强：最近 40 次运行集中在 **92 分钟**内；单个 PR（#2535）在 92 分钟内触发了 **7 次** CodeQL 分析。

其中 `push: main` 的 20% 是**天然重复**：同一份代码刚在 PR 上分析完，合并进 main 后再全量分析一次。

---

## 3. 耗时分布（job 级，实测）

CodeQL 工作流只有 1 个 job：`Analyze (javascript-typescript)`，无 matrix 扇出。

| 统计项 | 样本 | p50 | p90 | max | min |
| --- | --- | --- | --- | --- | --- |
| job 执行时长（成功） | 21 | **425s (7.1 min)** | **562s (9.4 min)** | 581s (9.7 min) | 278s (4.6 min) |
| job 执行时长（被取消） | 9 | —— | —— | —— | 中位 136s，合计 21.6 min |
| **排队时长**（run 创建 → job 启动） | 30 | **52s** | **456s (7.6 min)** | **690s (11.5 min)** | —— |

排队 p90 接近 8 分钟，说明 hosted runner 并发额度被同仓 CI（单 PR 20+ 个 job）挤占；这段等待与 CodeQL 自身计算无关，但用户感知就是"CI 很慢"。

---

## 4. 关键路径分析

对 15 个成功 PR 的 head SHA 拉取全部 check-runs，比较 CodeQL job 结束时间与其它所有成功检查的最晚结束时间：

| 指标 | 实测 |
| --- | --- |
| CodeQL 是最后完成的检查 | **1 / 15（7%）** |
| CodeQL 结束 − 最后其它检查结束 | 中位 **−415s（早 6.9 分钟）** |
| 该 PR 全部检查的跨度 | 748s–1,590s（12.5–26.5 分钟） |
| CodeQL 结束时刻位于跨度中的位置 | 31%–97%，中位约 50% |

**判定：CodeQL 通常不在关键路径末端**。PR 真正的尾部是 `Test shared runtime & adapters`、`Test release asset smoke`、`TypeScript Check (pd-console)`、`codecov/patch` 等测试类 job（单个常见 8–16 分钟）。

它对"CI 慢"的实际贡献有两条间接路径：

1. 每个 PR 固定占用 4 vCPU 约 7 分钟，与 CI 的 20+ 个 job 争抢同一并发池 → 抬高**所有人的排队时间**；
2. 每次 push 都跑一遍，把一个 7 分钟的串行环节叠加到快速迭代节奏上。

### 4.1 分位对照表（同一次 PR 内，示例）

| PR | 全部检查跨度 | CodeQL 时长 | CodeQL 结束相对最后一个检查 |
| --- | --- | --- | --- |
| #2535 | 1091s | 496s | −546s |
| #2538（f8cf4d54） | 1275s | 365s | −415s |
| #2540（044c1724） | 1590s | 425s | −876s |
| #2541（e790eb77） | 838s | 353s | −83s |
| #2536（ff6a640f） | 512s | 464s | **+55s（唯一一次最后完成）** |

---

## 5. Step 级拆解（真实日志）

样本：run [42986034585](https://github.com/csuzngjh/principles/actions/runs/42986034585)，job 总时长 499s，日志逐行时间戳。

| Step | 时长 | 占 job |
| --- | --- | --- |
| Set up job | 1s | 0.2% |
| `actions/checkout@v7`（fetch-depth 0） | 10s | 2.0% |
| Initialize CodeQL | 23s | 4.6% |
| Autobuild | **3s** | 0.6% |
| **Perform CodeQL Analysis** | **458s** | **91.8%** |
| Post 清理（3 步） | 4s | 0.8% |

### 5.1 `Perform CodeQL Analysis` 内部阶段

| 阶段 | 时间戳窗口 | 时长 | 占该 step |
| --- | --- | --- | --- |
| 建库骨架（init 阶段已完成，此处仅开始） | 08:27:01 → 08:27:03 | 2s | 0.4% |
| **源码抽取**（3,063 个仓库文件，0 个 node_modules 文件） | 08:27:03 → 08:28:53 | **110s** | **24%** |
| **finalize + 查询准备/编译** | 08:28:53 → 08:30:08 | **75s** | **16%** |
| **查询求值**（203 条查询，4 线程） | 08:30:08 → 08:34:26 | **258s** | **56%** |
| SARIF 导出(0.4s) + 上传(2s) + 等待处理(5s) | 08:34:26 → 08:34:39 | 13s | 3% |

关键事实：

- `Initialize CodeQL` 期间 bundle 命中 toolcache：`Finished downloading and extracting CodeQL bundle ... (4.0s)`，且 `Nothing downloaded`。**缓存没有可优化空间。**
- 抽取阶段**没有扫 node_modules**（node_modules 抽取计数 = 0），也没有编译 JS（JS/TS 是解释型）。
- runner 为 **4 vCPU**（日志：`found a cgroup CPUs file with 4 CPUs`），`--threads=4`。
- SARIF 上传只占 13s，**不是瓶颈**。

> step 级耗时来自真实日志，可完全复现；`Perform CodeQL Analysis` 的内部切分基于日志时间戳（`Extracting` / `database finalize` / `eval` / `Exporting results to SARIF` / `Successfully uploaded results`），非估算。

---

## 6. 查询层构成（决定 suite 收益）

同一份日志共 **203 条查询**，串行求值时间合计 **1,094.7s**，实际墙钟 258s（≈4.2× 并行度，与 4 vCPU 吻合）。

| 查询分组（按 query pack 目录） | 条数 | 串行耗时 | 串行占比 |
| --- | --- | --- | --- |
| **AngularJS** | **9** | **255.6s** | **23.3%** |
| Security（含 CWE 子目录） | 94 | 512.7s | 46.8% |
| Expressions | 22 | 106.8s | 9.8% |
| Declarations | 19 | 74.1s | 6.8% |
| DOM | 3 | 44.0s | 4.0% |
| Statements | 12 | 42.3s | 3.9% |
| LanguageFeatures | 21 | 24.4s | 2.2% |
| 其它（React/Vue/NodeJS/RegExp/Performance/Electron/Diagnostics/Summary） | 22 | 34.5s | 3.2% |

- 最慢单条：`Security/CWE-312/CleartextLogging` 34.9s；其次 `AngularJS/UseNgSrc` 29.0s、`DOM/MalformedIdAttribute` 29.0s。
- **本仓库中 `@angular/` 与 `angularjs` 关键字命中数为 0**（全仓 `**/package.json` grep）。即 23.3% 的查询算力产出恒为空集。
- `Security/*` 与"非 Security"几乎各占一半（46.8% vs 53.2%）——这解释了为什么"降级 suite"能省很多，也说明它确实是**用覆盖换速度**。

---

## 7. 根因判定

| 候选根因 | 判定 | 实测依据 |
| --- | --- | --- |
| 跑了不该跑的语言 / 重复语言 | **否** | 只有 `javascript-typescript` 一个语言，1 条 matrix |
| 每个 PR 都全量而非增量 | **部分是（机制性）** | CodeQL 是全程序分析；已启用 diff-informed（`exclude-from-incremental` + `pr-diff-range`），它只裁剪告警范围、**不减少求值** |
| 多个 CodeQL 入口并存 | **否** | 默认设置未启用；analyses 只有 1 个 tool/category |
| matrix 扇出过多 | **否** | 1 个 language，1 个 job |
| 用了重量级 query suite | **是（主因之一）** | 203 条查询；非 Security 查询占串行时间 53.2% |
| autobuild 但可 `build-mode: none` | **否（已等效 none）** | Autobuild 实测 2–4s，JS/TS 无可编译产物；`build-mode: none` 只能再省约 3s |
| 没有缓存 | **否** | bundle 命中 toolcache（4.0s）；分析不依赖 node_modules |
| push 与 pull_request 双跑 | **是** | `push: main` 占 20% 运行量，内容与刚通过的 PR 分析重复 |
| （新增）触发量过大 | **是（最大单一因素）** | 943 次/周；单 PR 92 分钟 7 次；`strict: true` 使每次更新 base 都重跑 |
| （新增）4 vCPU + 并发争抢 | **是** | 排队 p90 456s、max 690s |
| （新增）零收益的 AngularJS 查询 | **是** | 9 条查询占 23.3% 串行时间，仓库无 AngularJS 代码 |

---

## 8. 优化选项（逐条给出实测推算）

收益推算基准：单次 job p50 = 425s；查询阶段 258s；套用"实测串行占比 × 查询阶段墙钟"作为可解释的估算，并标注不确定项。

### A. 不降低覆盖的提速（建议直接做）

| # | 方案 | 预计节省（按实测推算） | 覆盖影响 | required check 影响 | 改动量 |
| --- | --- | --- | --- | --- | --- |
| A1 | **分层 suite**：PR 用 `security-extended`；`main`/周扫保留 `security-and-quality` | 查询阶段 −25%~−40%（−65~−105s/次），PR job 7.1→**约 5.5–6.0 min** | **整体不降**：全量 suite 仍在 main + 周扫跑；PR 上的 quality 告警最晚延迟 ≤7 天 | 无（本来就不是 required） | 中：1 个新 config 文件 + 按 event 分支 |
| A2 | **排除 AngularJS 查询**（query-filters 或自定义 `.qls`） | −23.3% × 258s ≈ **−60s/次**（job 7.1→6.1 min） | **实测为 0**：仓库无 AngularJS 代码，查询结果恒空 | 无 | 小：加 `query-filters` 3–5 行 |
| A3 | **paths 精准化**：用 `paths:` 白名单（`**/*.ts,tsx,js,jsx,mjs,cjs,html`）替代当前 `paths-ignore` | 近 20 个 PR 中 **4 个（20%）无任何 JS/TS 改动**（changeset/CHANGELOG/package.json/lockfile 类），每周约跳过 150 次 × 7.1 min ≈ **1,070 min/周** | **0**：非 JS/TS 文件的改动无法改变 JS/TS 分析结果 | 无 | 小：改 trigger 段 |
| A4 | **锁定单一入口**：保持 Default setup 关闭，CodeQL 只由本工作流产出 | 0（防回归） | 无 | 无 | 无（现状） |
| A5 | **版本升级** `v4.38.2` → 最新 | 未实测，预期 <5%（10–20s） | 无 | 无 | 极小 |

A1 + A2 + A3 合计效果（推算）：

- 单次 PR 分析：425s → **约 260–300s（4.3–5.0 min），−30%~−40%**
- 每周不再需要跑的 PR 分析：约 150 次
- 每周 CodeQL runner 分钟：5,353（PR 部分）→ 约 **2,800**，节省 **≈2,500 min/周（≈42 小时）**

### B. 用覆盖换速度（必须你批准）

| # | 方案 | 预计节省 | 覆盖代价 | required check 影响 | 改动量 |
| --- | --- | --- | --- | --- | --- |
| B1 | **永久降级为 `security-extended`**（main 也不跑 quality） | −65~−105s/次；周省约 1,000 min | 永久失去 code-quality 类告警（JS 侧多为 dead code / unused var，与 ESLint 重叠度高） | 无 | 小 |
| B2 | **去掉 `push: main`**（只留 PR + 周扫） | −186 次/周 × 7.1 min ≈ **1,320 min/周（22 小时）** | 默认分支告警基线从"每次合并"退化为"每周一次"（最长 7 天窗口） | 无 | 小 |
| B3 | **PR 只在 `ready_for_review` 或打 label 时触发** | 预计减少 30–50% PR 运行（需按真实推送节奏再测） | 草稿期的安全反馈消失，问题发现更晚 | 无 | 小 |
| B4 | **更大 runner（8 vCPU）** | 抽取/查询阶段近线性并行，job 预计 −40%~−47%（≈3.5–4 min） | 无 | 无 | 极小（改 `runs-on`），但需付费 runner |

### C. 已验证无效、不建议投入

| 方案 | 结论 |
| --- | --- |
| `build-mode: none` | Autobuild 实际只花 **3s**（JS/TS 无构建），改与不改几乎无差 |
| 增加依赖/bundle 缓存 | bundle 已命中 toolcache；分析不读 node_modules（抽取 0 个） |
| 精简 matrix | 只有 1 个 language |
| 合并 CodeQL 入口 | 只有一个 |
| 减少 `fetch-depth` | 仅 10s，且 diff-informed 需要完整历史，不建议动 |
| 优化 SARIF 上传 | 13s，占比 3% |

### D. 明确不做

- 不删除 CodeQL、不让它永久 `if: false`、不用 `continue-on-error` 假装通过——这些会直接归零安全覆盖。

---

## 9. 建议执行顺序（下一轮实施时）

1. **A2 + A3**（零覆盖损失、改动最小、收益可立即验证）：先拿这两项做一次 PR 实测 A/B。
2. **A1**（分层 suite）在同一 PR 里一起上：PR 路径快检、main/周扫全量。
3. 观察 1 周后，再决定是否需要 B 系列（尤其 B2：需要你确认默认分支告警新鲜度是否可以接受"周级"）。

**观测指标**（改造前后各取 7 天）：

- job 时长 p50/p90（当前 425s / 562s）
- 排队时长 p50/p90（当前 52s / 456s）
- 每周运行次数与总 runner 分钟（当前 943 次 / ≈6,600 min）
- code scanning 告警总数必须持平或上升，**不得下降**（这是"没有降覆盖"的硬证据）
- AngularJS 查询结果数（必须为 0）

---

## 10. 附录：数据来源与复现命令

```powershell
# 运行列表与事件分布
gh api "repos/csuzngjh/principles/actions/workflows/codeql.yml/runs?per_page=100" `
  --jq '.workflow_runs[] | [.id,.event,.conclusion,.created_at,.updated_at,.head_sha] | @tsv'

# job / step 级耗时（started_at / completed_at 即 step 级真实耗时）
gh api "repos/csuzngjh/principles/actions/runs/<RUN_ID>/jobs" `
  --jq '.jobs[] | .name as $j | .steps[] | [$j, .number, .name, .started_at, .completed_at] | @tsv'

# 真实日志（含 CodeQL 各阶段时间戳与 203 条查询求值耗时）
gh run view --repo csuzngjh/principles --job <JOB_ID> --log

# 关键路径：某 commit 的全部检查
gh api "repos/csuzngjh/principles/commits/<SHA>/check-runs" `
  --jq '.check_runs[] | [.name,.status,.conclusion,.started_at,.completed_at] | @tsv'

# required check
gh api repos/csuzngjh/principles/branches/main/protection

# 是否存在第二个 CodeQL 入口
gh api repos/csuzngjh/principles/code-scanning/default-setup
gh api "repos/csuzngjh/principles/code-scanning/analyses?per_page=30" `
  --jq '.[] | [.tool.name,.tool.version,.category,.created_at] | @tsv'
```

样本范围：最近 40 次运行（其中 30 次已完成，含 21 次成功 / 9 次取消）、15 个成功 PR 的关键路径、1 次完整 job 日志（499s）、近 7 天运行量、近 20 个 PR 的变更文件类型。

---

# 附录：Phase 1 实施记录（2026-11-11）

本附录记录获批后实际落地的改动与**改后真实数据**，供一周收尾验收对照。PR：[#2547](https://github.com/csuzngjh/principles/pull/2547)。

## A1. 落地内容

| 事项 | 文件 | 说明 |
| --- | --- | --- |
| PR 路径 suite 分层 | `.github/workflows/codeql.yml` + 新增 `.github/codeql/codeql-config-pr.yml` | PR = `security-extended` 并排除 9 条 AngularJS；main / 周扫 / dispatch = `security-extended,security-and-quality` 原样 |
| PR 触发白名单 | `codeql.yml` | `paths-ignore` → JS/TS/HTML/Vue/Svelte 扩展名白名单 + CodeQL 自身配置 |
| CodeQL concurrency | `codeql.yml` | PR 按 PR 号、非 PR 按 `ref+sha`；PR 新推送取消旧运行 |
| 全仓 concurrency 补齐 | `companion-release` / `deploy-website` / `e2e-nightly` / `issue-management` / `linear-sync` / `stale` / `telemetry-retention` | 按 workflow+ref（事件型按 issue/PR 号）分组；发版、清理、stale 保持 `cancel-in-progress: false` |
| Deploy Website 路径过滤 | `deploy-website.yml` | 仅 `packages/website/**`、根 manifests、自身 workflow 触发 |
| merge queue 预留 | `ci.yml` | 新增 `merge_group:`（惰性），required check 名称不变 |

未改动：matrix 扇出、缓存、build-mode、多入口、`Verify Merge Gate` 的 job 结构、任何语言扫描。

## A2. 改后查询构成（核心覆盖证据）

| 路径 | 唯一查询 | Security CWE | AngularJS | quality |
| --- | --- | --- | --- | --- |
| 改前（PR 与 main 相同） | 203 | 93 | 9 | 92 |
| 改后 PR（`security-extended` − AngularJS） | **102** | **93（一条未少）** | 0 | 9 |
| 改后 main 路径（dispatch `42994485230`） | **203** | **93** | **9** | **92** |

移除的 101 条 = 9 条 AngularJS + 92 条 quality，新增 0；`missing_in_after` 为空。

## A3. 改后单次耗时（job 时长，不含排队）

| 场景 | run | 时长 | 排队 |
| --- | --- | --- | --- |
| 改前 PR（n=21，7 天） | — | p50 **425s** / p90 562s | p50 52s / p90 456s |
| 改后 PR #1 | `42990684997` | **234s** | 3s |
| 改后 PR #2 | `42996588605` | **371s** | 193s |
| 改后 PR #3 | `43004169157` | **358s** | 66s |
| 改后 main 路径全量 | `42994485230` | **486s** | 219s |

改后 3 次 PR 样本 234 / 358 / 371s，中位 358s，比改前 p50 425s 少 ≈67s（−16%）。排队时间已与执行时间同量级，说明容量瓶颈在触发量与并发，而不只是单次分析。

## A4. 最近 24 小时触发量基线（收尾验收对照基准）

| 指标 | 基线（2026-11-10 → 11-11） |
| --- | --- |
| workflow run 总数 | ≥1000（API 分页上限） |
| PR / workflow_run / push / dispatch / schedule | 782 / 139 / 73 / 4 / 2 |
| 取消数 | 123（12%）：CI 43、CodeQL 25、pd-console E2E 19、Release Reproducibility 16、PR Checks 13、Repo Health 7 |
| job 排队（216 样本） | avg 101s / p90 405s / max 836s |
| 运行量 Top | Linear Sync 180、CI 148、CodeQL 145、PR Checks 132、Repo Health 129、Release Reproducibility 123、pd-console E2E 102、Deploy Website 18 |

预期每天少排 ≈43 次运行（CodeQL −26、Deploy Website −17），约 **220–250 runner 分钟/天**。

## A5. 一周收尾验收清单

1. `gh run list --created ">=$(date -d '7 days ago' ...)"` 对比 run 总数与按 workflow 分布，确认 CodeQL 与 Deploy Website 的下降幅度落在预期区间。
2. 重跑本报告 §排队抽样脚本，确认 job 排队 p90 从 405s 下降；若未下降，说明瓶颈在 CI/Release Reproducibility 等必需任务，需要另立议题。
3. 检查 main 上 CodeQL 运行仍为 203 条查询 / 93 条 Security CWE（不得因本次改动减少）。
4. 检查是否出现"应报未报"的安全告警：对照 `code-scanning/alerts` 在 main 上的新增/关闭记录，确认没有因 PR 路径分层而丢失的 CWE 类别。

## A6. 合并记录与一周跟踪基线

| 项 | 值 |
| --- | --- |
| PR | #2547 |
| 合并方式 | merge commit（Owner 授权，绿且 CLEAN 后合入） |
| 合并提交 | `f5ca14499bb818c968e9e3cccaf6a75d848f8558` |
| 合并时间 | 2026-11-11T12:37:53Z |
| 合并后 main head | `f5ca1449` |
| 合并时 PR head | `bc71805294a62c07066cc609f67754b9db20b5d9`（对齐 main `0776320` 后重跑 27 项检查全绿） |

**基线（改动生效前 24 小时，用于一周后对比）**

| 指标 | 基线值 |
| --- | --- |
| workflow run 总数 | ≥1000 |
| 取消数 | 123（12%） |
| job 排队 | avg 101s / p50 26s / p90 405s / max 836s |
| CodeQL 运行数 | 145 / 天 |
| Deploy Website 运行数 | 18 / 天 |
| 全仓 CI job p50（CodeQL） | 425s |

**可证伪的预测（一周后逐条核对）**

1. CodeQL 每天运行数下降 ≈20%（纯代码路径才触发）→ 预期 ≤120。
2. Deploy Website 除本次合并（改动了自身 workflow）外，只有 `packages/website/**` 或根 manifests 变更时才触发。
3. main 上每次 CodeQL push 运行仍为 **203 条查询 / 93 条 Security CWE / 9 条 AngularJS**；周计划同。
4. job 排队 p90 低于 405s；若未下降，瓶颈判定为必需任务（`Verify Merge Gate`、Release Reproducibility），另立议题而非继续在本改动上加减。
5. 不新增、不删除 job；`Verify Merge Gate` 仍是唯一 required check。

**跟踪截止**：2026-11-18。记录方式：复用 A5 的四个命令，结果追加在本节下方，不夹带任何代码改动。

