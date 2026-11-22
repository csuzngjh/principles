# 多 PR 争抢主干：业界方案对比与决策备忘

- 日期：2026-11-11
- 仓库：`csuzngjh/principles`（个人账号 User-owned，public）
- 性质：只读调研 + 建议，**未修改任何工作流或分支保护**
- 数据采集：`gh api` 实时查询（2026-11-11）+ GitHub Actions 运行记录抽样 + 官方文档核对

---

## 0. 结论（只读这一段也能做决定）

1. **这个仓库的瓶颈不是"检查太慢"，而是"每条 PR 都要在最新主干上重新证明一次"。** 实测 required check 只有 `Verify Merge Gate` 一个，单次中位 **3.5 分钟**；但 `strict=true` 让任何一次合入都使其余 PR 的绿失效，必须 update-branch 后重跑整套（单 PR 26–39 个 check-run）。
2. **原生 merge queue 用不了**——官方文档明确限定"组织拥有的 public 仓库"或"组织拥有 + Enterprise Cloud 的 private 仓库"。这不是配置问题，无法绕过。
3. **业界真正在解决"各自绿、合起来红"的只有一类机制：在合并态上跑 CI。** 三种实现形态：单临时分支（GitHub MQ）、累积批次（Zuul / bors / Tide / Mergify Parallel）、整栈入队（GitHub Stacks）。分片、缓存、impact 分析都只缩短单轮时间，**对这个失败模式零帮助**。
4. **建议按三步走，总投入约 1–3 天：**
   - **T0（今天，0 代码）**：把"串行合入"交给现成机器人（Kodiak 免费覆盖 personal/public），消掉人力协调与空档。
   - **T1（半天，最高性价比）**：把 `Verify Merge Gate` 的影响面收窄（复用仓库已有的 `scripts/ci/impact.mjs` + 缓存），让"重新证明"从 3.5 分钟降到 1.5–2 分钟。**这一步的收益比上任何队列都直接。**
   - **T2（2–3 天，可选）**：自建 bors 式 merge train（共享分支 + rollup + 失败二分），批量吞吐约等于 batch 大小倍。**只有在"同时就绪 ≥3 条"成为常态时才值得做。**
5. **不要做的事**：部署 Prow Tide / Zuul / 自托管 bors-ng（已归档）；用 CI 分片或 stacked PR 当作吞吐方案；把 29 个 check 全部设为 required（那只会放大 strict 的代价）。

---

## 1. 先校正三个事实（P1 证据优先）

写方案前先量了现状，有三处与常见假设不同，直接影响结论：

| 事实 | 实测值 | 证据 |
| --- | --- | --- |
| required contexts | **只有 1 个**：`Verify Merge Gate` | `gh api .../branches/main/protection` → `contexts:["Verify Merge Gate"], strict:true, enforce_admins:true, required_approving_review_count:0`；`/rulesets` 为空 |
| 每个 PR 的 check-run 数 | 26 / 33 / 31 / 39 / 39（最近 5 个已合并 PR） | `gh api .../commits/<sha>/check-runs` |
| `Verify Merge Gate` 耗时 | 中位 **3.5 min**，样本区间 2.3–4.2 min（14 次成功运行） | `gh api .../actions/runs/.../jobs` 抽样 |

含义：

- 所谓"29 项 required checks"在**分支保护层面并不成立**——29 是"会跑的检查数量"，不是"必须绿才能合的数量"。真正阻塞合并的只有 1 个聚合门。
- 因此"任何一条合进去，其它 PR 的绿就作废"的传导链条是：**`strict=true` → PR 落后于 main → 必须 update-branch → 全部 26–39 个 check 重跑**，而不是"29 个 required context 失效"。
- 这也意味着：**降低"重新证明"的成本（T1）比增加"并行证明"的能力（T2）更便宜、更快见效。**

另一个容易忽略的技术事实：GitHub 的 `pull_request` 事件默认检出的就是 **`refs/pull/N/merge`（base + PR 的合并态）**。所以"单个 PR 与当前 main 的组合"其实一直在被测试；缺的只是"**多个 PR 一起**"这一层。

---

## 2. 问题拆解：四段，别混在一起谈

任何方案只解决其中一段或几段。混谈是选型失败的主因。

| 段 | 表现 | 本质 |
| --- | --- | --- |
| **A. 排队等待** | 一条合完，下一条才能开始验证 | 串行资源（单槽） |
| **B. 重复跑** | base 一动，已绿的 PR 全部重跑 | strict 的放大效应 |
| **C. 组合失败** | 各自绿，合起来红 | 从未测试"多 PR + main"的合并态 |
| **D. 人力协调** | 谁先合、谁 rebase、谁重跑 | 缺少自动化仲裁 |

**关键判断：C 只能靠"在合并态上跑 CI"解决，A/B/D 可以用更便宜的手段解决。** 很多团队上了 merge queue 却仍然慢，是因为 B 没解决（门本身太重）。

---

## 3. 方案一览

评分口径：**拦住 = 能在合并前发现"多 PR 组合失败"；放过 = 依赖事后发现。**
"单人 + 多 agent"列：是否在这个规模下划算（不是"是否先进"）。

| 方案 | 主要解决 | 额外基础设施 | 组合失败 | 单人+多 agent 是否划算 | 证据等级 |
| --- | --- | --- | --- | --- | --- |
| **GitHub 原生 merge queue** | A B C D | 无（但账号类型不支持） | **拦住**（临时分支含队列前序 PR） | 本仓库**不可用** | A |
| **Kodiak**（托管 App） | A B D | 装 App + `.kodiak.toml` | 放过（逐条验证，不批量） | **划算**（public + personal 免费） | A |
| **Mergify**（OSS 免费档） | A B C D | 第三方 App + 配置 | **拦住**（Parallel Checks / Batch） | 划算，但引入供应商依赖 | A |
| **自建 merge train（bors 式）** | A B C | 一条共享分支 + ~300 行脚本 + PAT | **拦住**（批量测合并态） | 就绪 ≥3 条/批时划算 | A（机制）/ B（落地） |
| **bors-ng / Homu 自托管** | A B C | 服务器 + DB | 拦住（batch + bisect） | **不划算**（均已停止演进） | A |
| **Prow Tide** | A B C D | 整套 Prow 控制面 + 集群 | 拦住（batch） | 不划算（远超收益） | A |
| **Zuul** | A B C | scheduler/executor/ZooKeeper/DB | **拦住**（speculative execution） | 不划算（重型） | A |
| **Chromium CQ + try bots** | B C | LUCI/自定义 CQ 服务 | 部分（依赖 `Cq-Depend` 声明） | 不可复制（自研基础设施） | A |
| **Stacked PR（GitHub Stacks / Graphite）** | D（评审拆分） | 无 / 付费 | 不解决（整栈入队仍依赖 MQ） | 不是吞吐方案 | A |
| **测试影响分析（Nx/Turborepo/Bazel 式）** | B | 依赖图（本仓库已有） | 放过 | **最划算**（本仓库已具备） | A |
| **CI 分片 / 缓存** | A（单轮时长） | matrix + cache | **放过**（完全不解决） | 次要收益 | A |
| **flaky quarantine** | C 的噪声源 | 流程 + 看板 | 不解决（但防止误判） | 必要，但不是吞吐方案 | A |

---

## 4. 各方案细说

### 4.1 bors → Homu → GitHub merge queue：真实演进并非"一条直线"

**机制。** bors 的核心不是"队列"，而是**"只让一个提交被验证，验证通过后主干快进到它"**：把 N 条 PR 合成一个 batch，在 staging 分支上渲出"合并后"的提交，跑完整测试，绿则 fast-forward；红则**二分**（拆一半重测），直到定位到具体肇事 PR。复杂度从逐条 O(N) 降到 O(E log N)（E 为失败批次数）。

**必须纠正的一个流传说法。** "Rust 从 bors 迁移到了 GitHub merge queue，放弃 rollup"——**不成立**。可核查的事实是：

- `rust-lang/homu` 已 **archived**（bors 的前身实现）。
- `rust-lang/bors` 是用 Rust 重写的新 bot，**仍在生产运行**（`bors-prod.rust-lang.net`），其 README 明确保留 `automation/bors/*` 分支体系，并包含 **rollup 与 unroll**（`try-perf` 用于 rollup 成员的性能构建）。
- 该 bot 的 merge queue 与 rollups 由一个 GSoC 2025 项目实现。

结论：Rust 的路径是"**换实现，保留 batch/rollup 语义**"，不是"放弃 rollup 改用逐条队列"。

**已被放弃的部分。** `bors-ng`（Elixir 实现）README 首行即 **Deprecation notice**，只接受 bug fix、不再接受新功能，并直接建议改用 GitHub 内置 merge queue；仓库已归档。自托管 bors-ng 对新项目**不是可选项**。

**对本仓库。** 机制值得抄（merge train + 二分），实现不值得装（没有活跃维护的自托管版本）。

### 4.2 GitHub 原生 merge queue：唯一"官方且完整"的形态，但账号类型不支持

**官方机制（可逐条核对）：**

- 可用性：**"any public repository owned by an organization"**，或"organization-owned private + GitHub Enterprise Cloud"。
- 临时分支：`gh-readonly-queue/{base_branch}`（Actions 里是 `merge_group` 事件，分支形如 `main/pr-1`），内容 = **最新 base + 队列中排在前面的所有 PR**。
- 与 strict 的关系（官方原话）：merge queue "提供与 *Require branches to be up to date before merging* 相同的好处，但不需要作者更新分支并等待检查"。**它是 strict 的替代品，不是补充品。**
- 批量化能力：`Merge limits`（一次合入 base 的 PR 数 1–100）+ `Build concurrency`（1–100）+ "Only merge non-failing pull requests"（决定是否要求组内每条都绿）。
- 失败处理：把该 PR 移出队列并**重建**其后的临时分支，不是 bisect。

**风险实证（支持"批量也有代价"）。** 2026-04-23 GitHub 的 merge queue 事故：当 merge group 含多个 PR 且使用 **squash** 合并时，产生了错误的 merge commit，导致后续合并**回退了**先前已合并的改动，影响 **658 个仓库 / 2,092 个 PR**。GitHub 官方状态页与官方博客均有记录。

**对本仓库。** 不可用（个人账号）。但它定义了"正确形态"的基准：**验证对象必须是"base + 前序 PR + 本 PR"的合并态**。自建方案应当照此设计。

### 4.3 Kubernetes Tide（Prow）：池 + 批次 + 自动 retest

- Tide 从 PR 池里挑候选，**任何一次合入都会把池内其余 PR 打回 "Queued for retest"**——这与本仓库当前感受完全一致，它是"正确性优先"的必然结果，不是实现缺陷。
- 批处理由 `batch_size_limit` 控制（代码位于 `pkg/config/tide.go`；`0` = 不限，`-1` = 关闭），并有 `prioritize_existing_batches`（默认 true，避免一有新 PR 就重建批次）。
- 官方建议**不要**同时开 GitHub 的 "Require branches to be up to date"，因为 Tide 自己已保证"基于最新 base 验证"。
- 关于"失败后拆批二分"：社区文章常这么描述，但**官方文档未明写拆分算法**，此处标为博客级证据，不可当作事实引用。

**对本仓库。** 不可复制（整套 Prow 控制面 + 集群），但提供了两条可迁移的设计原则：**批次优先于逐条**、**strict 与队列二选一**。

### 4.4 Chromium Commit Queue + try bots：不是"队列"，更像"集合"

- 模式：Dry-Run（`Commit-Queue +1`，只报结果）、Full-Run（`CQ+2`，通过即提交）、Mega-CQ（更大测试集，慢，高风险改动才用）。
- ChromeOS 侧官方文档明确写自 2020 年起使用 **parallel CQ**；LUCI CQ 的自述是"**不是 queue，而是 set**——每个 CL 独立验证，通过后按任意顺序提交"。这与 bors 的"批次"是两条不同路线。
- 组合关系的处理靠**显式声明**：`Cq-Depend` / `Cq-Include-Trybots`，把有依赖的 CL 一起应用到 ToT 上测。
- 失败处理：先重跑失败分片，再"不带 patch 重编译重跑"，只有"带 patch 失败 + 不带 patch 通过"才判定为改动引入的回归。**注意：这是 flaky 判定逻辑，不是合批 bisect。**

**对本仓库。** 不可复制（自研 CI 基础设施）。可借用的是"**带 patch 失败 / 不带 patch 通过**"这个判定口径——它比"重跑一次绿了就算 flaky"严谨得多。

### 4.5 OpenStack Zuul：唯一把"未来状态"讲透的实现

- 核心：dependent pipeline 的 **speculative execution**。A 在队首，B 的 job 实际测的是 A+B；C 测 A+B+C。**并行执行，语义等价于串行逐个合入。**
- 失败重排：C 失败 → C 出队并报失败，D/E 保留但在"去掉 C 的新 tip"上重测（队列重建）。最坏退化为逐条。
- 并发窗口 `pipeline.window` 采用类 TCP 拥塞控制：成功 +1、失败减半，默认起点约 20。
- 基础设施：ZooKeeper（≥3.5.1）+ 数据库 + scheduler/executor/merger/web/fingergw。官方说明新版不再需要 Nodepool，最小可用是 scheduler+executor 同机。
- 采用者：OpenStack 自身（起因是无法突破 **24 merges/day**）、Ansible、BMW、Volvo 等。
- 是否被放弃：**未发现正式的弃用公告**（此项标记为未核实，不做推断）。

**对本仓库。** 部署不现实；但"**测未来状态**"这一条应作为自建 train 的设计准则。

### 4.6 托管 merge queue：Kodiak / Mergify / Aviator / Graphite / Trunk

| 工具 | 机制 | 个人账号 | 价格 | 组合失败 |
| --- | --- | --- | --- | --- |
| **Kodiak** | 内部 FIFO + 按需 update-branch + optimistic updates（不等 pending 就更新） | **官方明示免费覆盖 public + personal repos** | $0 | 放过 |
| **Mergify** | Merge Queue + **Parallel Checks** + **Batch** + 自动 bisect | Open Source 计划 $0（含以上能力）；是否明确支持个人账号**未核实** | $0 / Max $21/seat | **拦住** |
| **Aviator** | default / parallel / no-queue；parallel 用累积 draft PR 并行验证 | **未核实** | Team $20/dev | 拦住 |
| **Graphite** | Merge Queue（Basic 起） | Hobby 免费但**不含 MQ**；MQ 需 Team $40/seat | $40/seat | 拦住 |
| **Trunk** | predictive testing + batching + 并行 lane | **未核实** | 未核实 | 拦住 |

**Kodiak 的价值不在"队列"，在"消掉 D 段"**：它明确"works with branch protection"，不改变你的 CI，负责"该更新时更新、绿了就合"。对单人维护来说，这是**成本最低的第一步**。代价：文档最后更新于 2023-01-26，项目活跃度需自行确认（**风险项**）。

**Mergify 的 OSS 计划是唯一"$0 就能拿到 batch + parallel + bisect"的现成方案**，但引入第三方 App 对个人仓库的写权限，且需要把 merge 决策交给外部配置——对以"治理与可审计"为产品调性的仓库，这是一个需要 Owner 明确接受的外部依赖。

### 4.7 Stacked PR：它是评审工具，不是吞吐工具

- 官方定位：把大改动拆成可独立评审的小 PR。GitHub Stacks 于 2026-07-30 public preview、**2026-10-06 GA**，`gh stack` 扩展，且"**整栈作为一个 merge group 入队**"——注意后半句：**它依赖 merge queue 才能获得批量收益**，而本仓库没有 MQ。
- Graphite 自己的 CI 文档承认 stacking 会**增加 CI 运行次数**（多出 PR 与后台 rebase），并称"少于 10 个 stacker 基本看不到差别"。
- 因此：stacked PR 解决的是 **D 段（评审协调）**，在本仓库当前问题里排不进前二。

### 4.8 测试影响分析 / 分片 / 缓存 / flaky 隔离

- **影响分析**（B 段）：本仓库**已经有** `scripts/ci/impact.mjs`，从真实 workspace manifest 构图，未知/根级改动保守放大到全量，各 job 通过 `needs.impact` 消费 scopes，且**fail-open**（脚本或 job 失败则全部执行）。这是现有资产，不需要新建。
- **分片**（A 段）：Vitest `--shard` + `blob` reporter、Jest `--shard`、Actions `strategy.matrix` 都是官方能力。但分片只压缩单轮墙钟，**对 C 段零帮助**，还会略微提高 flaky 暴露率。
- **缓存**：`actions/cache` 有仓库总量 10GB / 7 天未访问淘汰的限制；npm 依赖缓存已在用。
- **flaky 隔离**：GitLab 的制度化做法值得抄——首次失败即 quarantine、必须开 issue、fast-quarantine **7 天自动清除**，避免"永久隔离 = 静默删覆盖"。Chromium 官方文档则明确："重试成功 = **hidden flake**"，即重试会隐藏信号。

### 4.9 被回退/被放弃的实践（不只挑成功案例）

| 实践 | 结局 | 证据 |
| --- | --- | --- |
| bors-ng 自托管 | **Deprecated + archived**，官方建议转 GitHub MQ | A |
| Homu | **archived**，被 `rust-lang/bors` 重写取代 | A |
| Uber SubmitQueue 的纯推测执行 | 官方博客承认**单个大 diff 会阻塞整条队列**，需要"旁路"机制 | A/B |
| 多 PR batch + squash | 2026-04-23 GitHub 事故，658 仓库 / 2,092 PR 被回退 | A/B |
| "重跑一次绿了就算 flaky" | Chromium 官方明确称之为 hidden flake，属反模式 | A |

---

## 5. 对本仓库的具体建议

### 5.1 目标与验收口径

不是"更快合入"，而是：**在 main 始终可构建的前提下，让 N 条同时就绪的 PR 的总合入时间接近 1 条的验证时间。**
可观测验收：连续 10 次多 PR 合入中，`main` 的红灯次数为 0；每次合入的人工介入次数为 0；N=3 时的总墙钟 ≤ 单条验证时间 × 1.5。

### 5.2 T0 — 消掉人力协调（今天，0 代码）

- 做法：接入现成机器人（首选 Kodiak；若其活跃度不可接受，则用 40 行 Actions + `gh pr update-branch` + `gh pr merge --auto` 自建单槽）。
- 解决：**D 段**，顺带缓解 A（不再有人为空档）。
- 组合失败：**放过**（不变，与今天一致，不引入新风险）。
- 代价：一个第三方 App 的写权限，或一个 PAT。
- 回滚：卸载 App / 删除 workflow，分支保护不变。

### 5.3 T1 — 让"重新证明"变便宜（半天，最高性价比）

这是本备忘**最推荐**的一步，因为它直接作用于 strict 的成本结构。

- 做法：
  1. `Verify Merge Gate` 内部按 `scripts/ci/impact.mjs` 的 scopes **条件化**执行子检查（窄改动只跑对应 scope + 全量静态门）；
  2. 文档/单包改动走快路径；
  3. `concurrency` 保持 `cancel-in-progress`（已有），避免旧 commit 继续消耗 runner。
- 解决：**B 段**（重复跑）。
- 组合失败：放过（不变）。
- 预期收益：窄改动单次复验 3.5 min → 1.5–2 min；N 条串行合入的总时长近似线性下降 40–55%。
- 代价与风险：影响面判断错误的代价是"漏检"。必须保留现有的 **fail-open + 未知即全量** 语义，不允许"未知 → 跳过"。
- 验证：对最近 20 个已合并 PR 回放 impact 预测，与人工判断的"实际受影响包"比对；不一致的样本必须能解释。
- 回滚：把条件判断改为恒真即可（一行）。

### 5.4 T2 — 自建 merge train（2–3 天，可选，触发条件明确）

**只有在"同时就绪 ≥3 条"成为常态时才做。** 否则 T0+T1 已经够用。

- 机制（照抄 Zuul/bors 的语义，不照抄其基础设施）：
  1. 维护 `train/next`，**始终从当前 main tip 建立**；把带 `merge-ready` 标签的 PR 以 merge commit 依次并入，批次上限 3–5；
  2. 在 `train/next` 上跑与主干**完全相同**的 required gate；
  3. 绿 → `git push origin train/next:main`（**fast-forward**，head SHA 已有绿检查，不触发 bypass，也不需要绕过 `enforce_admins`）；
  4. 红 → 二分拆批重测，定位肇事 PR 后移出并重排剩余批次；
  5. 全程 `concurrency: merge-train`，同一时刻只允许一列。
- 解决：**A + B + C**（一次验证覆盖 N 条，且测的是合并态）。
- 预期收益：N=5 时，5 次 3.5 min（17.5 min）压到 1 次 3.5 min + 失败时的 O(log N) 次二分；吞吐近似 ×N。
- 代价：
  - ~300 行脚本 + 一个可推送的凭证（**优先 GitHub App，不用长期 PAT**）；
  - 新增一条会写 `main` 的自动化路径，必须做"只在 ff 且绿时推送"的硬约束；
  - 失败时二分带来的额外 CI 消耗。
- 风险与已知坑：batch 合并本身存在真实事故先例（见 4.2），因此：**用 merge commit，不用 squash**；批次上限 ≤5；保留人工 abort 开关。
- 复杂度增量（按仓库 Constitution §13）：新增持久状态 = 否（`train/next` 是可重建的临时分支）；新增子系统 = 是（一条 CI 自动化路径）；新增公共抽象 = 否；新增跨包依赖 = 否。
- 回滚：停止 workflow、删除 `train/next`；分支保护与 PR 流程完全不受影响，回到 T0/T1 状态。

### 5.5 T3 — 托管 merge queue（性价比分水岭）

- Mergify OSS 免费档 ≈ T2 的全部能力，$0，但要把 merge 决策交给外部 App；Kodiak ≈ T0。
- 判断规则：**如果 T2 的维护成本（脚本 + 凭证 + 偶发故障排查）超过你每月愿意投入的时间，就换 Mergify**；否则自建更可控、且不引入第三方对 `main` 的写权限。

---

## 6. 看起来诱人但不该做

| 想法 | 为什么不该做 |
| --- | --- |
| 部署 Prow Tide / Zuul | 需要集群级控制面（ZooKeeper、scheduler、executor、DB）。单仓库的 merge 吞吐收益是分钟级，运维成本是小时级。 |
| 自托管 bors-ng | 已 Deprecated + archived，新功能不再接受；等于把主干交给一个停止演进的组件。 |
| 把 29 个 check 全部设为 required | 现在只有 1 个 required context。全部 required 只会让 strict 的"重跑成本"从 3.5 min 变成 12–26 min，吞吐更差，且不提升安全性。 |
| 用 CI 分片解决合入排队 | 分片缩短单轮时间，但组合失败发生在合并态；不测合并态，分片再多也发现不了。 |
| 用 stacked PR 当吞吐方案 | Graphite 官方承认它会**增加** CI 次数；GitHub Stacks 的批量收益依赖 merge queue，本仓库没有 MQ。 |
| 直接关掉 `strict` | 等于把"组合失败"从合并前转移到合并后。除非同时有 T2 的合并态验证，否则 main 会变红。 |
| 追求"零 flaky"再谈吞吐 | 先 quarantine + 记账（参考 GitLab 的 7 天自动清除），否则永远等不到那一天。 |
| 追更"并行合并"（同时 push 多条） | 并行合并等于让 CI 结论与 main 状态脱钩，是本问题的**成因**，不是解法。 |

---

## 7. 证据分级与来源

分级：**A** = 官方文档 / 官方仓库代码 / 官方状态页；**B** = 官方博客、changelog、事故报告；**C** = 厂商博客或个人经验（有立场）；**D** = 未核实。

### A — 官方文档 / 仓库代码

- GitHub：Managing a merge queue（可用性、临时分支、merge_group、build concurrency、merge limits、strict 关系） — https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
- GitHub：About protected branches（strict / loose） — https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- GitHub：Automatically merging a pull request — https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request
- GitHub REST：Update a pull request branch — https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request-branch
- GitHub REST：Branch protection（本仓库实测数据来源） — https://docs.github.com/en/rest/branches/branch-protection
- bors-ng（README 顶部 Deprecation notice；仓库已归档） — https://github.com/bors-ng/bors-ng
- rust-lang/homu（archived） — https://github.com/rust-lang/homu
- rust-lang/bors（Rust 重写实现；`automation/bors/*` 分支；rollup / unroll） — https://github.com/rust-lang/bors
- Prow Tide 文档 — https://docs.prow.k8s.io/docs/components/core/tide/
- Prow Tide 配置（`batch_size_limit`、`prioritize_existing_batches`） — https://docs.prow.k8s.io/docs/components/core/tide/config/
- Prow Tide 代码（`pkg/config/tide.go`、`pkg/tide/tide.go`） — https://github.com/kubernetes-sigs/prow/tree/main/pkg/tide
- Chromium：Commit Queue 文档 — https://chromium.googlesource.com/chromium/src/+/main/docs/infra/cq.md
- Chromium：bisect-builds — https://www.chromium.org/developers/bisect-builds-py/
- Chromium：Fixing flaky unit tests（"retry success = hidden flake"） — https://www.chromium.org/developers/testing/fixing-flaky-tests/fixing_flaky_unittests/
- ChromeOS：commit pipeline（parallel CQ） — https://www.chromium.org/chromium-os/developer-library/reference/development/cros-commit-pipeline/
- Zuul：Project Gating（speculative execution） — https://zuul-ci.org/docs/zuul/latest/gating.html
- Zuul：Components（ZooKeeper 等依赖） — https://zuul-ci.org/docs/zuul/latest/components.html
- Zuul：Users — https://zuul-ci.org/users
- Kodiak：Prior Art（"free for public and personal repositories"、机制对照表） — https://kodiakhq.com/docs/prior-art-and-alternatives
- Kodiak：Features（内部队列、optimistic updates） — https://kodiakhq.com/docs/features
- Mergify：Pricing（Open Source $0 含 Merge Queue / Parallel Checks / Batch） — https://mergify.com/pricing/
- Mergify：Merge Queue 文档 — https://docs.mergify.com/merge-queue/
- Graphite：Billing plans（Hobby 不含 MQ；Team 起） — https://graphite.com/docs/billing-plans
- Graphite：Stacking and CI（承认增加 CI 次数） — https://graphite.com/docs/stacking-and-ci
- Nx：`affected` — https://nx.dev/ci/features/affected
- Turborepo：Remote caching — https://turborepo.dev/docs/core-concepts/remote-caching
- Vitest：Improving performance（`--shard` / `blob` / `merge-reports`） — https://vitest.dev/guide/improving-performance
- GitLab：Unhealthy tests（quarantine + 7 天自动清除） — https://docs.gitlab.com/ee/development/testing_guide/unhealthy_tests.html
- GitHub Status：2026-04-23 Pull Requests incident — https://www.githubstatus.com/incidents/zsg1lk7w13cf

### B — 官方博客 / changelog / 事故复盘

- GitHub Blog：Merge queue GA — https://github.blog/2023-07-12-github-merge-queue-is-generally-available/
- GitHub Changelog：merge_group webhook / workflow trigger — https://github.blog/changelog/2022-08-18-merge-group-webhook-event-and-github-actions-workflow-trigger/
- GitHub Blog：April 23 merge queue incident（658 repos / 2,092 PRs） — https://github.blog/news-insights/company-news/an-update-on-github-availability/
- GitHub Changelog：Stacked pull requests GA（2026-10-06） — https://github.blog/changelog/2026-10-06-stacked-pull-requests-generally-available
- GitHub Changelog：Stacked pull requests public preview（2026-07-30） — https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/
- Inside Rust：Infrastructure team Q3 2025 recap（bors 迁移进程） — https://blog.rust-lang.org/inside-rust/2025/10/16/infrastructure-team-q3-recap-and-q4-plan/
- Rust Blog：GSoC 2025 results（bors merge queue / rollups） — https://blog.rust-lang.org/2025/11/18/gsoc-2025-results/

### C — 博客 / 厂商材料（有立场，仅作旁证）

- Prow 生产实践 — https://perun.au/insights/prow-production
- Uber：Bypassing large diffs in SubmitQueue — https://www.uber.com/en-GB/blog/bypassing-large-diffs-in-submitqueue/
- Uber SubmitQueue 论文（EuroSys'19） — https://www.masoud.io/docs/eurosys19.pdf
- Martin Fowler：Eradicating Non-Determinism — https://martinfowler.com/articles/nonDeterminism.html
- Graphite 指南：Merge queue vs direct merging（厂商视角） — https://graphite.com/guides/merge-queue-vs-direct-merging-benefits

### D — 未核实（不得当作事实引用）

- Mergify / Aviator / Trunk 是否**明确支持个人账号（User-owned）public 仓库**：官方页面只写 "open source" 或未提账号类型，需实测。
- Prow Tide "失败 batch 自动二分拆批"：社区文章普遍这么描述，**官方文档未明写**。
- Zuul 是否有项目正式弃用：未检索到一手公告。
- "TIA 漏检"的官方风险声明：各家只给保守兜底（如 lockfile 变更即全量），无专门风险章节。
- "因 quarantine 导致线上漏检"的一手复盘：未找到可信材料。

---

## 8. 一句话决策

**先做 T1（收窄复验成本），再做 T0（自动化串行合入）；只有当"同时就绪 ≥3 条"成为日常时，才用 T2 的 merge train 换吞吐。原生 merge queue 这条路在本仓库被账号类型封死，不必再试。**
