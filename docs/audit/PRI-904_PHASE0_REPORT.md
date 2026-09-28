# PRI-904 Phase 0 Report

> ⚠️ **修正横幅（2026-09-23）**：本报告 §Recommended Experiment 中「Phase B-nat（天然 FIFO 溢出窗）可立即执行」的判定**已被证伪**——ASC 装箱下截断只砍队尾（最新激活），目标原则结构性不可能被新增批准挤出；live 数据（09-22 全部 183 次注入目标原则在场，被饿死的是 5 条新批准原则）证实。Phase B 已在 `PRI-904_EXPERIMENT_DESIGN_V2.md` 中替换为 B-del（治理面临时退役，需 Owner 授权）与 B-starve（饿死原则机会性观察）。其余结论不受影响。
> 产出 5/5：Phase 0 汇总与最终判定。调查期间零修改（无代码/PR/schema/DB/runtime/配置变更）。
> 明细文档：`PRI-904_OPENCLAW_MEMORY_MAP.md` / `PRI-904_PRINCIPLE_ACTIVATION_BOUNDARY.md` / `PRI-904_PRI836_CONTAMINATION_ANALYSIS.md` / `PRI-904_EXPERIMENT_DESIGN_V2.md`。

---

## Executive Summary

Phase 0 回答了三件事：

1. **OpenClaw 的 Memory 不是一个东西，是七条通道**（六文件 bootstrap 每轮注入、启动日记前奏、memory_search 向量检索、AGENTS.md 驱动的主动读取、compaction 摘要、session 历史、dreaming 晋升回写 MEMORY.md）。全部机制已溯源到 file:line 并与 live 环境交叉验证。
2. **PD Principle 注入边界已完整实证**：每 turn 经 `before_prompt_build` 钩子进 `prependSystemContext`，宿主合并点（`attempt-thread-helpers.ts:20-39`）证实其位于最终 system prompt **最顶端**——在全部 Memory 内容之前。两者无覆盖/仲裁机制，语义可重复（已抓到实锤碰撞：USER.md 与 principle #8 完全同语义双注入）。
3. **PRI-836-001 的污染结构被修正**：WORK_AGREEMENTS A-007（与目标原则语义等价，激活前 109 分钟写入）对 A1 是 HIGH 污染；但对 A2（20/20 MATCH 所在窗口）**污染比原报告轻**——09-22 该文件零读取、MEMORY.md 正文零命中、日记前奏无规则，**精确规则在 A2 的全程在场载体几乎只有 PD 注入**；残留污染是会话内邻接纠正史（F3）与 13:02Z 后 MEMORY.md 尾部的邻接晋升（F2）。

**对核心问题的当前立场**（不是答案）：「PD 是否提供超越 Memory 的经验抽象与迁移能力」目前**既未被证明也未被证伪**。Phase 0 的价值在于：把它变成一个可判定的问题——污染通道已全部可测，对照条件已可搭建。

## Final Decision

```
READY（有条件）
```

条件与即时可执行性：

| 阶段 | 状态 | 依据 |
|---|---|---|
| **Phase B-nat（天然 FIFO 溢出窗）** | **READY，可立即执行**——零干预、零授权、纯观察 | 机制三重实证：SQL ASC 排序（sqlite-activation-state-store.ts:112）、FIFO 硬 break（contract:115-141）、live 预算 1864/2000 且目标原则排最后；事件逐 turn 载有 principleIds 可精确判定窗口 |
| **Phase C（新工作区 C1/C0/C10）** | **READY——以 3 个 pilot 门为放行条件**（G1 多工作区注入可用、G2 Memory Manifest 干净、G3 probe 产生机会） | 前置均为运维操作（openclaw.json 新 agent 条目 + 官方安装器装配 .pd + 既有审批流），无代码/schema 变更；G1 是唯一未验证的技术假设，故必须先跑 pilot |
| Phase A（迁移测试） | READY——嵌套在 C 臂内 | probe T3/T4/T5 已设计 |

不 READY 的部分（如实声明）：live 工作区内的「Memory OFF」受控臂（工单草案四象限的 C/D）**不可靠地成立**——F3 会话历史与 F4 AGENTS.md 惯性不可消除，且需对 Owner 生活数据做破坏性搬移。已从设计中移除，由新工作区臂替代。

## OpenClaw Memory Map

（详见产出 1。摘要：）

| 通道 | 进 context 方式 | 实测影响 |
|---|---|---|
| bootstrap 六文件（AGENTS→…→MEMORY.md） | system prompt，每轮；MEMORY.md 截断为头 7.5K+尾 2.5K chars | 高（AGENTS.md 全文在场且是 Memory 元通道） |
| 启动日记前奏（2 天/2.8K chars，untrusted 标注） | 用户消息侧，新会话 | 中 |
| memory_search/memory_get | 工具结果 | **≈0**（0-4 次/日） |
| AGENTS.md 驱动主动读取（日记 3 天+MEMORY.md） | read 工具 | 中-高（MEMORY.md 09-21 被 read 83 次） |
| compaction 摘要+后刷新 | transcript 前缀 | 高（长会话主承载） |
| dreaming 晋升（03:00 cron + 心跳维护） | 回写 MEMORY.md 尾部（= 可见窗口） | 中（A2 后半段实证在场） |
| session 历史 | transcript 连续在场 | 高 |

## Principle Boundary

（详见产出 2。摘要：）PD prepend 块 = 最终 system prompt 第一段；宿主合并公式 `join([prepend, baseSystemPrompt, append])` [DIRECT]；注入无 selector、ASC 全量、2000 chars FIFO 硬截断；compaction 后下一 turn 结构性重注入（PD 持久性优于 session 记忆——这是 PD 相对 Memory 的唯一结构性优势，应进入 H2 检验）；无覆盖仲裁，碰撞实锤一处（C1）+ 邻接两处（C2/C3）。

## PRI-836-001 Contamination Analysis

（详见产出 3。摘要：）六条混淆 F1-F6 全部定量。核心修正：A1 的探针会话**未读任何 Memory 文件**（原「归因不可得」的主通道对探针不成立）；A2 的精确规则载体几乎只有 PD 注入；但 Agent 会在纠正后 2 分钟内自发把规则写入 WORK_AGREEMENTS（PD 对此零感知、无去重）——**「Memory 含等价原则」是 PD 学习环的结构性常态而非本次偶发**，任何行为实验必须把 Memory Manifest 列为一级控制项。

## Recommended Experiment V2

（详见产出 4。摘要：）弃四象限。三阶段：**B-nat**（FIFO 天然窗，零干预，立即可跑）→ **C**（新工作区 C1/C0[/C10]，主归因实验，3 pilot 门放行）→ **A**（迁移 probe 嵌套在 C 内）。双假设预注册：H1 注入独立贡献；H2（若 H1 被拒）PD=行为保持器而非行为开关——两个方向都是有效认知产出。

## Risks

1. **G1（多工作区注入）未验证**——插件按 hookCtx.workspaceDir 解析 .pd，理论上支持，但未实测；失败则 Phase C 挂起并产出能力缺口发现（FC5）。
2. **先验饱和**（FC1）：GLM 级模型可能天然执行证据绑定汇报，C0 全 MATCH——此时 H1 不可证，实验转向 H2 衰减曲线设计。
3. **天然窗不可控**：FIFO 窗口出现时机/时长不由实验控制（FC4 有 30 天降级规则；不人为制造静默降级）。
4. **单宿主单模型**：结论外部效度限于本机 OpenClaw+GLM；换模型/换宿主需重跑（FC6 作废规则）。
5. **probe 的生态效度**：合成任务的行为≠真实 Owner 任务的行为；缓解：B-nat 窗与 PRI-836-001 延续观察提供真实工况对照。
6. **治理时序**：Phase C 需要 Owner 配置变更（openclaw.json）+ 新工作区审批——授权边界外的操作一律不做。

## Unknowns

1. compaction 摘要逐会话内容未审计（机制实证、内容未读）；
2. 启动日记前奏的时区选择细节（影响微小）；
3. 模型先验强度（正是 C0 臂要测的量）；
4. sessions corpus 的向量索引范围（实测使用≈0，影响微小）；
5. heartbeat lightContext 下 bootstrap 清空对 Memory 参与度的精确影响（与 PD 注入无关）。

## Final Decision Rules

实验执行期采用以下判定纪律（预注册，防事后挪门）：

- **注入在场**以逐 turn 事件 `principleIds` 为唯一权威；「激活着但没注入」= 不在场。
- **行为命中**以 behavior-signature.json 的 eligibleOpportunity + MATCH/VIOLATION/INCONCLUSIVE 三值裁定；显式降级单列计数。
- **归因句式**：只允许「在 Memory Manifest = X、注入 = Y 的条件下，观察到 MATCH 率 Z」；禁止「因为 Principle 所以改善」。
- **Memory Manifest 不干净的窗口**（出现等价规则或邻接晋升）不进主对照，只作描述性记录。
- 每阶段收窗后先跑 **Owner Simulator 独立裁定**（盲态：只给 Pain/Principle/证据），再出实验判定。
- 负结果（FC1/FC2）与正结果同等交付：PD 获得的是「注入的边际价值边界」，不是宣传材料。
