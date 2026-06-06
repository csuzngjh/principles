# Unified Observation Pipeline — 概念探索笔记

> **Status**: Concept Exploration (NOT a design proposal)
> **Date**: 2026-06-06
> **Origin**: 从论文讨论 → 轨迹死循环检测 → Empathy Observer 升级 → 概念探索

> [!CAUTION]
> **本文档不是可执行的设计方案。** 它记录了一次概念探索的过程和结论。
>
> **前置依赖全部未实现：**
> - ADR-0015 (Pain Evidence Ingestion) 仍为 Proposed 状态
> - 代码中不存在 `RawObservation`、`ObservationNormalizer`、`EvidenceValidator`、`AdmissionController`、`TriggerController`
> - `PainToPrincipleService.recordObservation()` 不存在（现有的是 `recordPain()`）
>
> **UOP 在 [post-mvp-conditional-roadmap.md](../plans/post-mvp-conditional-roadmap.md) 中没有对应条目。** 按项目治理规则，没有重启条件 = 没有启动资格。如需正式立项，必须先在路线图中新增条目并定义由外部用户信号驱动的重启条件。

---

## 1. 核心想法

将 PD 现有的 `EmpathyObserver`（纯文本情绪匹配器）升级为一个能够观测多种行为偏差信号的框架，扩大 PD 的"感知带宽"。

**当前 PD 的感知瓶颈**（来自 [PD_Pain_Signal_Audit.md](PD_Pain_Signal_Audit.md) 的事实）：
- 痛苦信号约 60% 来自 WRITE_TOOLS 工具失败
- 轨迹死循环、目标偏移、隐性日志异常等行为偏差完全不可见
- 导致 PD 学到的原则永远围着"如何更安全地调用文件工具"打转

**探索方向**：在 `EmpathyObserver` 旁边增加几个观测维度：

| 观测维度 | 输入 | 判断方式 | 核心假设（未验证） |
|----------|------|----------|-------------------|
| 轨迹停滞 | 最近 N 步的 [工具名 + 报错骨架] | LLM 推断 | 廉价 LLM 能从脱敏骨架中区分"有效探索"和"A-B-A 震荡" |
| 目标偏移 | Initial Prompt + 最近动作摘要 | LLM 推断 | 插件能拿到宿主 Agent 的 initial prompt |
| 隐性日志异常 | Exit Code 0 但含 Warning 的日志 | 规则 + LLM | hook 能拿到完整的工具原始输出 |
| 文本共情 | 用户消息文本 | 关键字 + LLM | 已有实现（`EmpathyObserver`） |

## 2. 冷热通道分离（值得保留的思路）

不是所有观测都需要 LLM。分两层处理：

- **热通道（同步）**：文本关键字匹配，毫秒级返回。现有 `EmpathyObserver` 的关键字部分。
- **冷通道（异步）**：收集脱敏上下文，异步提交给 LLM 判断。不阻塞主 Agent。

> [!WARNING]
> **"廉价/本地 LLM" 是一个未满足的基础设施假设。** 现有 `EmpathyObserver`（[empathy-observer.ts](../../packages/principles-core/src/runtime-v2/observer/empathy-observer.ts)）通过 `PDRuntimeAdapter` 调用的是宿主 Agent 配置的同一个 LLM，不是独立的廉价模型。调用独立模型需要多 backend 支持（[post-mvp-conditional-roadmap.md §7 BALM](../plans/post-mvp-conditional-roadmap.md)，Hold 状态）。
>
> 可行的起步方式是复用宿主 Agent 的 `PDRuntimeAdapter`（和 `EmpathyObserver` 一样），但成本不低。"廉价模型"是进一步优化，不是前提。

## 3. 数据脱敏规则（值得保留）

轨迹死循环检测的成败在于**去噪**。直接丢原始日志会造成大量误判。

- **Action 脱敏**：`run_command("npm run test")` → `CMD:npm run test`
- **Observation 脱敏**：
  - 正则剔除时间戳 `[14:23:01]` 和内存地址 `0x7f8...`
  - 超长日志只截取 `Error:` / `Exception:` 所在行及后续 Top-3 调用栈
- **安全边界**：脱敏必须在提交给 LLM 之前完成。使用段边界 key 匹配（`keyLower === p || keyLower.endsWith('_' + p)`），避免 `includes()` 造成的过度脱敏（参见 ERR-003）

## 4. 与 ADR-0015 的关系

如果 ADR-0015 将来被接受并实现，观测者应作为 `RawObservation` 的生产者融入其准入管线：

```
Observer → RawObservation → EvidenceValidator → AdmissionController → TriggerController
```

关键对齐点：
- 观测者不直接触发 Diagnostician，走标准准入流程
- 所有经过 LLM 推断的观测，provenance 应为 `'llm_inferred'`（不是 `'hook_observed'`）——因为判断来自模型推断，影响 TriggerPolicy 配置
- GFI 从准入结果中派生（single source of truth），不做双写

如果 ADR-0015 不被接受，观测者仍可通过现有的 `trackFriction()` → GFI → `PainDetectedEvent` 路径工作，但会丢失结构化的准入决策和证据存储。

## 5. Console `PainEvidence.source` 字段

当前 Console 的 `PainEvidence.source` 限定为 `'tool_call' | 'prompt'`。新观测类型将来需要新值（如 trajectory、goal_drift 等），但**具体值等 Observer 实际落地时再定义**。

MVP 前端 `default` 分支已有诚实降级（显示"未知来源"），为扩展预留了空间。

## 6. 下一步：先做什么

在规划任何框架之前，需要先验证核心假设：

> **Spike 任务**：用现有的 `EmpathyObserver` 的 `PDRuntimeAdapter`，写一个实验性的 TrajectoryStall 检测 prompt，用 10 个真实的死循环案例和 10 个正常探索案例跑一遍，看准确率。
>
> - 如果准确率 > 80%：值得继续设计
> - 如果准确率 < 60%：整个方向需要重新评估
> - 如果 adapter 调用成本太高（每次 > $0.01）：需要先解决廉价模型问题

在 spike 验证通过之前，不做框架设计，不引入 Registry 抽象，不扩展 Schema 枚举。

---

## 设计决策记录

| 日期 | 决策 | 理由 |
|------|------|------|
| 2026-06-06 | 命名从 `Friction Observer` 归入 ADR-0015 的 `Observation` 命名空间 | 避免系统中存在 Friction 和 Observation 两套平行概念 |
| 2026-06-06 | Post-MVP 阶段扩展 `PainEvidence.source` 字段（具体值待定） | 当前 `'tool_call' \| 'prompt'` 无法覆盖新观测类型 |
| 2026-06-06 | 设计评审后降级为概念探索笔记 | 前置依赖全部未实现；核心假设（LLM 轨迹判断准确率）未验证；无 post-mvp 重启条件 |

## 相关文档

| 文档 | 关系 |
|------|------|
| [ADR-0015](../adr/0015-pain-signal-model-unification.md) | 如实施，UOP 观测者应融入此管线（Proposed 状态） |
| [PD_Pain_Signal_Audit.md](PD_Pain_Signal_Audit.md) | 感知带宽分析驱动了本探索 |
| [01-shared-constraints.md](../plans/2026-06-console-rebuild/01-shared-constraints.md) | Console G.2 数据契约（source 字段） |
| [post-mvp-conditional-roadmap.md](../plans/post-mvp-conditional-roadmap.md) | UOP 尚未在此注册条目 |
| [empathy-observer.ts](../../packages/principles-core/src/runtime-v2/observer/empathy-observer.ts) | 现有实现，spike 的起点 |
