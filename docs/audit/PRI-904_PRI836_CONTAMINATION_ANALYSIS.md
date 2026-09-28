# PRI-836-001 Contamination Analysis

> PRI-904 Phase 0 产出 3/5。只读重析：PRI-836-001 实验为什么无法证明 Principle 的独立贡献，污染通道逐条定量。
> 数据：live 工作区文件（含 git/untracked 状态、backup diff）+ trajectory.db tool_calls 读取频次 + PRI-836-001 报告的窗口重建。未修改任何文件。

---

## 核心问题重述

PRI-836-001 结论「激活后行为改善（27 机会 26 MATCH，同类纠正 1→0→0）」无法归因于 Principle 注入本身，因为激活前后 Agent 的 context 里还存在其它可能携带同一规则的通道。本文把每条通道查清、定量、定级。

## Possible Confounders（逐条核查）

### F1 — WORK_AGREEMENTS.md（最重，已确证）

**Evidence**：

- **创建/内容时间线**（backup diff 精确隔离）：`WORK_AGREEMENTS.md.pri768v6-backup`（09-21T17:17Z，v6 实验备份）不含 A-007/A-008；现文件仅多出这两节。
  - A-007「汇报纪律：每个事实结论必须有本会话内实际查验的证据」写入于 **09-21T17:31:04Z**（PRI-836-001 B0 重建：0d2e48c5 会话 17:30:28 Test-Path → 17:30:33 read → 17:31:04 edit）——**激活前 109 分 44 秒**；
  - 内容 = Owner 原话逐字引用 + 三条规则（其中规则 3「验到哪一层」的边界表述**比原则 artifact 的正文更精细**）+ 事故记录；
  - A-008（汇报长度）写入于 18:19Z 纠正后（b4dfacf9 会话 18:19:14 read → 18:19:31 edit）。
- **是否「Principle 等价表达」**：**是**。A-007 与 intentContract 的 targetBehavior/forbiddenBehavior 逐点对应（事实结论↔实际查验；未查验须明说；禁止「验证通过」式空洞宣称）。
- **进入 context 的通道与频次**（trajectory.db tool_calls，params 含 WORK_AGREEMENTS）：
  - 09-19=7 次、09-20=1 次、**09-21=15 次**（11:05-11:09 两个监控会话编辑其它约定；17:30 A-007 创建；18:19 A-008 创建；18:51 bcd13cd3 exec 引用）、**09-22=0 次**；
  - **不是** bootstrap 文件（不自动注入）[DIRECT: 源码 VALID_BOOTSTRAP_NAMES 白名单]；**不被** memory-core 索引（watch=MEMORY.md/USER.md/memory/）[DIRECT]。

**Severity**: **HIGH for A1（创建当晚）**；**LOW for A2（次日零读取，规则不在任何 A2 会话的工具轨迹中）**。

### F2 — MEMORY.md 尾部晋升（A2 后半段新增）

**Evidence**：

- MEMORY.md 99,227 bytes ≈ ~40K chars，bootstrap 只注入**头 7.5K + 尾 2.5K chars**；
- 全文 grep「查验/未查验/可观察证据」= **0 命中**（A-007 规则从未进入 MEMORY.md）；
- 但尾部可见区（mtime 09-22 21:02 local = 13:02Z，Agent 心跳维护写入）自 13:02Z 起携带 09-22 当日晋升的**邻接规则**：「普适规则③：被质疑时先搜实物链（git log/源图/脚本）再定性，勿拿『既定范围』自辩两轮」「QA 成环：……全 PASS 才交付」——语义邻近目标行为，且位于**每轮注入**的可见窗口。

**Severity**: **MEDIUM for A2 后半段（≈13:02Z 后 2h）**；A1 无（当时尾部为 MV 内容）。

### F3 — 会话内经历（in-session correction history）

**Evidence**：

- 目标纠正（#939）发生于会话 0d2e48c5（已结束的短会话）；A2 主力会话 79f5ffe4（MV 冲刺，20/20 MATCH 所在）**没有经历** #939；
- 但 79f5ffe4 自身在 B0 有邻接纠正（#926「原来的工作流明明可以用…去查看已有的工作流阿」14:50Z 等），其 compaction 摘要（Key Decisions/Critical Context）可能保留「先查证再断言」倾向；
- compaction 摘要内容在宿主 session 状态中，本轮未逐会话提取（Unknowns）。

**Severity**: **MEDIUM for A2**（同会话邻接纠正 + 摘要承载，无法排除）。

### F4 — AGENTS.md 预存规范（每轮全文注入）

**Evidence**：

- 「确定性执行：在编写代码前，必须达到 100% 的上下文确定性。禁止基于猜测编程」「上下文压缩会丢失所有中间过程。没有文件证据，进度就会丢失」——预存（TOOLS.md 迁移），编码域而非汇报域；
- AGENTS.md 同时命令会话启动必读 SOUL/USER/**最近 3 天日记**/MEMORY.md——制度性把 Memory 拉进 context。

**Severity**: **LOW-MEDIUM**（邻接、预存、域不同；但它解释了为什么 Agent「读文件核验」的文化基础早已存在）。

### F5 — USER.md 双注入（碰撞 C1）

**Evidence**：USER.md 09-19 起每轮注入「配置值全局搜索一次改尽」——与 active principle #8 完全同语义（见边界文档）。对**目标原则**实验无直接污染，但证明「同语义双通道并存」是现实，不是假想。

**Severity**: **无（对目标原则）**；对 principle #8 类实验为 **HIGH**。

### F6 — 启动日记前奏 / memory_search / DREAMS

**Evidence**：

- 启动前奏只注入日记头 1,200 chars/文件：09-21/09-22 日记头部为 CURRENT_FOCUS 状态与心跳记录，无目标规则；日记中段虽有「返工代价…先搜实物证据」（09-22 复盘）等邻接内容，但**超出前奏窗口**，只能经 AGENTS.md 指令主动读取进入；
- memory_search 实测 0-4 次/日（09-22 仅 1 次）——向量召回通道实际影响≈0；
- DREAMS.md grep「查验/验证通过/可观察证据」= 0 命中。

**Severity**: **LOW**。

## Impact On Experiment

按 PRI-836-001 的两个观察窗分别重估：

| 窗口 | 在场污染通道 | 对「行为改善」结论的影响 |
|---|---|---|
| **A1**（09-21 19:20-24:00） | PD 注入（每 turn）+ **F1 WORK_AGREEMENTS（当晚 15 次读写的高 salience 残留；对 4 个探针会话实际零读取——其 MATCH 只能归因 PD 注入+任务措辞+workshop skill）** + F4 | 原报告的 A1 归因瑕疵比原判更**轻**：探针会话未读任何 Memory 文件，A1 的 6/7 MATCH 反而是 PD 注入较强的证据（但被任务选择效应抵消） |
| **A2**（09-22 00:00-15:09） | PD 注入（每 turn）+ **F3 会话内邻接纠正史/摘要** + **F2 MEMORY 尾部邻接晋升（仅 13:02Z 后）**；**精确规则不在任何自动加载/被读文件中（WORK_AGREEMENTS 零读取、MEMORY 正文零命中、日记前奏无规则）** | 20/20 MATCH 的承载通道：PD 注入是**唯一全程在场的精确规则载体**；但 F2/F3 使后半段不可完全归因。原报告「归因不可得」的判断方向正确，但机制归因（WORK_AGREEMENTS）对 A2 并不成立——**A2 的污染比原报告表述的更轻、更可切割** |

**修正后的核心判断**：

1. PRI-836-001 的 PASS 判定不受影响（四层证据独立成立）；
2. 「无法归因」的真实结构 = **A1 被 F1+任务选择效应污染；A2 被 F3+F2 部分污染，但精确规则在 A2 的载体几乎只有 PD 注入**；
3. 因此「Principle 提供超越 Memory 的能力」**没有被证明，但也没有被证伪**——恰需要一个能切掉 F2/F3 的对照环境（新工作区，见设计文档）；
4. 任何后续实验**必须**把「Memory 中存在等价表达」列为一级检查项：本次实测证明它会在纠正后 2 分钟内自动发生（Agent 自发写入 WORK_AGREEMENTS），且不会被 PD 感知（PD 注入路径零读取 Memory，无去重机制）。
