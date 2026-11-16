# UPSTREAM_REDUNDANCY_ROOT_CAUSE_REPORT.md — Phase 4 RootCause→Distiller→Router 联合分析（2026-11-15）

目标：把三个阶段的输入输出放进同一条真实 Pain 链路，定位**第一个引入冗余的 Agent（First Redundancy Introduction Point）**与**第一个丢失独立机制的 Agent（First Mechanism Loss Point）**。全部证据来自冻结实验的真实产物（`upstream-diagnosis-dump.json`）与最新源码。

## 一、链路全景（实测形状，14 admitted Pain）

```
Pain (14)
  → RootCause  Stage A：每 Pain 恰 1 条 rootCause（schema 单字段）＋证据数组      [0 重复]
  → Distiller  Stage B：每 Pain 恰 1 条 abstractedPrinciple（≤200字符，schema 单字段）[Pain 内 0 重复；Pain 间语义家族]
  → Router     Stage C：每 Pain 1-3 条 recs（S01/S11=1，S02=3，其余=2）
               全部 recs 同属蒸馏原则这一个机制；12/12 rule 条目声明 implements→principle-1
  → Candidates 每 rec 1 候选（diagnostician-committer）——S02=3、其余 1-2
  → Bridge     每候选恰 1 条 Dreamer 链（intake-to-internalization-bridge.ts:129-188）
  → Dreamer    每链 2-4 候选（V2.1 规则）——同一诊断被 2-3 条链独立探索
  → Philosopher 每链各自合成（philosopher-runner.ts:141-196 只读本链工件）——跨链不可见
  → Scribe/Ledger 每 Pain 2-3 份近义原则稿；rule 链止步人审门（40/40）
```

冗余的算术：**1 个机制 × 2-3 载体 × 1 链/载体 × 2-4 候选/链 ≈ 每 Pain 4-8 候选，其中跨链 Duplicate 率 42.5%-50%（上轮实测）**。

## 二、逐重复案例归因（上轮审计认定的跨链 Duplicate 案例）

| 案例 | 重复内容 | 最早出现点 | 归因 |
|---|---|---|---|
| S03 双链 thesis 近义（"等待须以实际状态为终止依据"） | 链稿层 | **Router**：principle-1 与 rule-1 是同一决策点（等待前状态核查）的两个载体，桥接后成两条链，两链 Dreamer 各自围绕同一诊断产出趋同机制，Philosopher 各自合成近义 thesis | 结构必然（证据：两链输入=同一 predecessorOutput；关联声明 linked 在产物层已存在） |
| S07 双链（"技术验证≠授权确认"） | 链稿层 | 同上（principle+rule 双载体） | 同上 |
| S12 双链（"失败信号≠状态证据"） | 链稿层 | 同上 | 同上 |
| S02 三链 #0 三重 Duplicate（"断言前先调查"） | 链稿层 | **Router**：本 Pain 唯一三载体 Pain（principle+rule+prompt），三载体同述一机制 | 同上，且多载体内部还有二级重叠（rule 与 prompt 在"阈值止损"上再次同义） |
| 生产 Ledger 946754bf/26858b6f 近逐字重复（2026-11-11 注册） | Ledger 层 | **Distiller（跨 Pain 视野缺失）**：不同 Pain 各自蒸馏出同族原则（授权族），词法检测盲（同族对互分<0.15 除个别）——与 S03↔S12、S02↔S08 家族同构 | 见 LEDGER 报告 §3.1/§3.2 |

## 三、First Redundancy Introduction Point

**分两个冗余形态回答（不能笼统归给一个 Agent）：**

### 3.1 Pain 内跨链冗余（上轮主导冗余，42.5%-50%）

**First Redundancy Introduction Point = Router（Stage C）的多载体拆分。**

- 时间点：Router 对同一蒸馏原则发出第 2 个载体条目（rule）的那一刻——管道随后保证两条链各自独立探索同一诊断。
- 但必须如实说明两点（不因 Router 最靠近候选就默认它是"问题来源"）：
  1. **这是提示词明文设计的行为**（ROUTING RULES 要求按载体路由；rule 载体有独立治理价值：确定性拦截+人审门）。Router 没有违反任何指令；它只是没有"判断载体间是否值得各成一条链"的指令与权力。
  2. **放大器在桥接设计**：`每候选恰 1 链`（bridge）+ `Philosopher 链间不可见`（philosopher-runner.ts:141-196）+ `12/12 linked 关联信息无下游消费者`。三者把"合理的载体拆分"放大为"重复探索与重复原则稿"。**Router 是引入点，桥接+链间隔离是放大器，三者缺一冗余不成立。**
- RootCause/Distiller 的清白证明：14/14 单根因、14/14 单原则；Distiller→Router 保真：13 个 principle 条目中 9 条逐字=蒸馏原则、4 条微改写（0 条语义改写）。

### 3.2 Pain 间冗余（语义家族，生产 Ledger 重复的来源）

**First Redundancy Introduction Point = Distiller（Stage B）的跨 Pain 盲区。**

- 每个 Pain 独立蒸馏，无既有原则库视野（输入只有 Stage A 工件；trustedContext 只注入 Router 且只作关联目标用）。
- 实测家族：调查先行族（S02/S08）、状态核实族（S03/S12）、意图对齐族（S04/S06）、授权族（S07↔生产已注册条目）——词法矩阵 91 对仅 1 对可见（S08↔S14@0.213），**下游词法检测（Ledger 复用门）对这类冗余结构性失明**。

## 四、First Mechanism Loss Point

**First Mechanism Loss Point = Distiller（Stage B）的单原则压缩预算（≤200 字符 × 1 条）。**

实测机制（附证据）：

1. **次要机制的降级**：S12 根因明确含 Design 次要因素"关键中间状态未持久化"——蒸馏原则只保留"先核实再行动"；持久化机制被挤出原则文本（残留在根因字段，Dreamer 经 predecessorOutput 可部分恢复——S12 实验链确实探索了持久化候选，说明"降级"不等于"消失"）。S14 同型（"持久化约定缺乏自动召回机制的设计缺口"未进原则）。
2. **复合压缩**：S02（调查+止损两机制一句）、S13（归因+状态废弃两行为一句）——机制粒度在抽象时合并；这不是"丢失"而是"合并表述"，但对下游"逐机制多样性"的计量口径有影响。
3. **超出根因主决策点的机会**：依赖 Dreamer 从证据自行扩展（S02 的交付前核验候选即 Dreamer 层新增，philosopher 判定"由 T-07 已覆盖"）。
4. **诚实标注**：**逐机制级的"证据可见但全链未保留"清单 = BLOCKED-数据不足**——需要逐证据人工对照全链产物（上轮已声明逐候选淘汰账本不存在，本结论沿用同一限制）。
5. 排除项：V2.1 相对 V2 的机制空间收窄（31 vs 42）发生在 **Dreamer 层**（链内候选数规则收紧），与本轮三 Agent 无关（两臂共享同一上游提示词）。

## 五、阶段能力矩阵（谁能在哪一层做什么）

| 阶段 | 现有防重复能力 | 现有防丢失能力 | 本轮实证缺口 |
|---|---|---|---|
| RootCause | 单根因（结构） | 证据纪律强（14/14 引用证据） | 无实质缺口 |
| Distiller | Pain 内单原则（结构） | ≤200 字符×1 条预算；次要机制降级为根因注记 | 跨 Pain 无视野 → 语义家族冗余 |
| Router | principle kind 防灌水（AT MOST ONE）；关联声明（12/12 linked） | rule 载体把抽象具体化（补偿 Distiller 抽象损失） | 无载体间协调指令；关联信息无消费者 |
| Bridge | 每候选 1 链（防双种 PRI-720 C6） | — | **放大器**：不区分"同一机制的关联载体" |
| Dreamer | 链内 2-4 候选规则 | — | 链间不可见（结构性） |
| Ledger intake | 复用门（词法 0.15+LLM 评估+Owner 裁决） | Rule 4 降级放行 | 词法盲区（<0.15）+降级放行（LEDGER 报告） |

## 六、结论

1. **冗余有两个独立来源、两个引入点**：Pain 内跨链冗余=Router 多载体拆分（设计行为）×桥接放大（每候选一链+链间隔离+关联信息无消费者）；Pain 间冗余=Distiller 跨 Pain 盲区（无原则库视野）。两者都不能单独归咎于"Router 忠实转发上游重复"或"Distiller 拆分"——**上游两个阶段本身零重复**。
2. **机制丢失的第一点在 Distiller 的单原则预算**，形态是"次要机制降级为根因注记"而非消失（Dreamer 可部分恢复）；逐机制损失清单 BLOCKED-数据不足。
3. 系统已经生产了修复所需的全部数据：12/12 的 rule→principle 关联声明、根因字段中的次要机制、Ledger 语料库——**缺的是消费者与跨链视野，不是信息**。
4. 对"是否值得改提示词"的启示（详见 Owner Review Card）：Router 增加独立性指令只能减少载体数（治标，且触及 rule 载体的独立治理价值）；Distiller 增加既有原则对照需要给它 trustedContext 式的输入（改输入通道，不止提示词）；两者都属于提示词+契约的联合改动——本轮不改，交 ChatGPT 设计。
