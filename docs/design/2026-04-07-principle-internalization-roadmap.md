# 原则内化系统实现路线图

> **日期**: 2026-04-07  
> **状态**: Proposed  
> **GSD 对齐**: 本文档是 `v1.9.0 Principle Internalization System` 的技术路线图，细粒度里程碑需映射到 `.planning/ROADMAP.md` 的 Phase 11-15  
> **主文档**:
> - `docs/design/2026-04-07-principle-internalization-system.md`
> - `docs/design/2026-04-07-principle-internalization-system-technical-appendix.md`
> - `docs/design/2026-04-06-dynamic-harness-evolution-engine.md`

---

## 1. 文档目的

本文档不是再次定义系统概念，而是把“原则内化系统”拆解成可以逐步落地的实现路线图。

目标：

1. 明确先后依赖
2. 避免把架构重写、安全边界迁移、自动演化三件事绑在一起
3. 给每个阶段定义清晰的交付物和验收标准
4. 保证系统始终处于“可运行、可回退、可验证”状态

---

## 2. 与 GSD 的映射关系

本文档中的 `M0-M9` 是技术落地级里程碑，用于表达更细的依赖关系；`.planning/ROADMAP.md` 中的 `Phase 11-15` 是项目管理级 phase。两者不是冲突关系，而是粗细不同的同一套计划。

### 2.1 映射表

| 技术里程碑 | GSD Phase | 说明 |
|---|---|---|
| `M0` 文档与架构对齐 | 已完成的里程碑初始化前置工作 | 属于 `v1.9.0` 启动动作，不单列 phase |
| `M1` Principle Tree 主账本实体化 | Phase 11 | 对应 ledger entities 落地 |
| `M2` 宿主瘦身与硬边界收口 | Phase 11 / 12 过渡项 | 先瘦身，再进入运行时接入 |
| `M3` Rule Host MVP | Phase 12 | 对应 runtime host 能力 |
| `M4` Code Implementation 实体存储 | Phase 12 | 与 Rule Host 一起构成 code branch 基础设施 |
| `M5` 离线回放与评估报告 | Phase 13 | 对应 replay evaluation |
| `M6` Manual Promotion 闭环 | Phase 13 | 对应 manual promotion / rollback |
| `M7` Nocturnal code artifact 工厂 | Phase 14 | 对应 RuleImplementationArtifact factory |
| `M8` Coverage / Adherence / Deprecated 闭环 | Phase 15 | 对应 coverage 与 lifecycle |
| `M9` Principle Internalization Strategy 初版路由 | Phase 15 | 对应 internalization routing |

### 2.2 解释原则

1. `M0-M9` 用来指导实现顺序和技术依赖。
2. `Phase 11-15` 用来指导 GSD 中的计划、执行、验证和归档。
3. 任何后续设计调整都必须同时检查：
   - 是否仍满足 `M0-M9` 的技术依赖
   - 是否仍与 `Phase 11-15` 的 milestone 边界一致

---

## 3. 实施原则

### 2.1 先对齐主账本，再做运行时

原则树里的 `Principle -> Rule -> Implementation` 如果没有真实落地，后面的 Rule Host、coverage、deprecated 都会失去依托。

### 2.2 先保留宿主硬边界，再迁移可演化边界

当前阶段必须保留：

- `Thinking Checkpoint`
- `GFI Gate`
- `Progressive Gate`
- `Edit Verification`

不要在新实现支线尚未成熟时，先拆掉现有保险丝。

### 2.3 先支持手工候选，再接自动候选

新系统第一阶段应先支持：

- 手工添加 code implementation candidate
- 手工触发回放评估
- 手工晋升

而不是一上来就接到 nocturnal 自动生成并自动上线。

### 2.4 先支持 code implementation，再做多实现调度

虽然总框架支持：

- skill
- code
- LoRA
- fine-tune

但第一阶段落地时，应该聚焦 `Implementation(type=code)` 支线。  
多实现类型的统筹逻辑可后置。

### 2.5 先建立闭环，再追求自动化

第一目标不是“自动”，而是：

- 能产出候选
- 能验证候选
- 能上线候选
- 能统计覆盖率
- 能回退

---

## 4. 里程碑总览

```text
M0  文档与架构对齐
M1  Principle Tree 主账本实体化
M2  宿主瘦身与硬边界收口
M3  Rule Host MVP
M4  Code Implementation 实体存储
M5  离线回放与评估报告
M6  Manual Promotion 闭环
M7  Nocturnal 扩展为 code artifact 工厂
M8  Coverage / Adherence / Deprecated 闭环
M9  Principle Internalization Strategy 初版路由
```

每个里程碑都应独立可验收，且尽量不跨越多个风险层。

---

## 5. M0 文档与架构对齐

### 目标

把系统 framing 从“单一 DHSE”升级为：

- 总框架：Principle Internalization System
- code 实现支线：DHSE
- 夜间系统：候选研究与验证上游

### 已完成交付

- `2026-04-07-principle-internalization-system.md`
- `2026-04-07-principle-internalization-system-technical-appendix.md`
- 重写 `2026-04-06-dynamic-harness-evolution-engine.md`

### 验收标准

- 文档之间概念不冲突
- Principle / Rule / Implementation 三层关系明确
- DHSE 不再和总框架抢定义权

### 风险

- 若文档继续并行演化、术语不统一，后续实现将反复返工

---

## 6. M1 Principle Tree 主账本实体化

### 目标

让 `Principle -> Rule -> Implementation` 不再只存在于 schema 与文档中，而进入可操作的真实存储结构。

### 必做项

1. Principle Tree store 落地读写
2. Rule CRUD
3. Implementation CRUD
4. Principle / Rule / Implementation 关系维护

### 建议输出

- principle tree store manager
- rule repository
- implementation repository
- 基础查询接口

### 依赖

- M0

### 验收标准

- 可新增一条 Rule
- 可为 Rule 绑定一个 `Implementation(type=code)`
- 可查询某 Principle 下的 Rule 与其 Implementations
- 数据结构与 `principle-tree-schema.ts` 保持一致

### 不做什么

- 不在这一阶段引入 Rule Host
- 不在这一阶段计算复杂 coverage

### 风险

- 若这里偷懒只靠 JSON 拼装，后面 coverage 与 promotion 会混乱

---

## 7. M2 宿主瘦身与硬边界收口

### 目标

在不破坏现有系统稳定性的前提下，做一轮最小瘦身，并明确哪些模块属于宿主宪法层。

### 必做项

1. 删除 `message-sanitize.ts`
2. 清理其在 `before_message_write` 的接线
3. 确认 `TrajectoryCollector` 不再受其阻塞
4. 明确宿主硬边界保留项：
   - Thinking Checkpoint
   - GFI Gate
   - Progressive Gate
   - Edit Verification

### 依赖

- M0

### 验收标准

- `message-sanitize.ts` 不再参与运行路径
- 现有测试通过
- `before_message_write` 无冲突挂钩残留

### 不做什么

- 不动 Progressive Gate
- 不动 Thinking Checkpoint

### 风险

- 若此阶段顺手大改 gate 链，会把后续问题混在一起

---

## 8. M3 Rule Host MVP

### 目标

建立在线执行 `Implementation(type=code)` 的最小宿主。

### 必做项

1. `RuleHostInput` 协议
2. `RuleHostDecision` 协议
3. helper 白名单
4. active implementation 加载器
5. 多实现结果合并逻辑
6. 在 gate 链中接入：
   `Thinking -> GFI -> Rule Host -> Progressive -> Edit Verification`

### 建议输出

- `rule-host.ts`
- `rule-host-types.ts`
- `rule-loader.ts`
- `rule-registry.ts`
- `rule-host-helpers.ts`

### 依赖

- M1
- M2

### 验收标准

- 可手工注册一条 code implementation
- 在线态可执行该实现
- 返回 `allow / block / requireApproval`
- 异常情况下宿主能保守降级

### 不做什么

- 不允许任意脚本运行
- 不支持自动候选上线

### 风险

- 若 helper 白名单失控，会变成插件越权系统

---

## 9. M4 Code Implementation 实体存储

### 目标

为 `Implementation(type=code)` 建立稳定文件实体结构，脱离“内存对象 + 随机脚本”状态。

### 建议目录

```text
.principles/
  implementations/
    code/
      <implementation-id>/
        manifest.json
        entry.ts
        tests.jsonl
        last-eval.json
```

### 必做项

1. manifest 结构定义
2. 代码 entry 路径规范
3. implementation 状态管理：
   - `candidate`
   - `active`
   - `disabled`
   - `archived`

### 依赖

- M1

### 验收标准

- 实体目录与 principle tree store 一一对应
- implementation 删除/禁用/归档语义明确

### 风险

- 若这里继续把实现文件做成孤立散文件，后面无法稳定 promotion

---

## 10. M5 离线回放与评估报告

### 目标

建立 code implementation 的最小评估闭环。

### 必做项

1. 三类样本结构定义：
   - `pain-negative`
   - `success-positive`
   - `principle-anchor`
2. 回放执行器
3. `RuleImplementationEvaluationReport`
4. promotion 最低门槛实现

### 依赖

- M3
- M4

### 验收标准

- 可对某个 candidate implementation 运行回放
- 生成 structured evaluation report
- 能输出通过 / 失败结论

### 最低门槛

- 新 pain-negative 命中
- 不新增 success-positive 误杀
- principle-anchor 达到阈值

### 不做什么

- 不做复杂 UI
- 不做自动采样优化

### 风险

- 若没有 principle-anchor，系统会退化为事后记忆系统

---

## 11. M6 Manual Promotion 闭环

### 目标

在不依赖 nocturnal 自动候选的情况下，打通手工候选 -> 回放 -> promotion -> 在线生效的闭环。

### 必做项

1. candidate 选择机制
2. 手工触发评估
3. 手工 promotion
4. active implementation 替换或新增
5. rollback / disable

### 依赖

- M5

### 验收标准

- 一条 candidate implementation 可被手工晋升为 active
- 在线态可立即生效
- 可被手工禁用 / 回退

### 为什么这一步重要

只有先跑通手工闭环，后面的 nocturnal 自动候选才有安全挂载点。

---

## 12. M7 Nocturnal 扩展为 code artifact 工厂

### 目标

把现有 nocturnal 从“行为训练样本工厂”扩展为“多工件研究工厂”，新增 code implementation 候选生产能力。

### 必做项

1. 新增 `RuleImplementationArtifact`
2. 保持现有 `behavioral-sample artifact` 不受破坏
3. 复用：
   - target selection
   - snapshot extraction
   - principle context threading
   - validation / persistence 骨架

### 依赖

- M5
- M6

### 验收标准

- nocturnal 可产出 code artifact candidate
- 但默认不自动 promotion
- code artifact 与 ORPO 样本协议不冲突

### 不做什么

- 不让 nocturnal 直接自动上线代码实现

### 风险

- 若强行复用旧 `NocturnalArtifact` 协议，会把训练样本和规则候选混成一类

---

## 13. M8 Coverage / Adherence / Deprecated 闭环

### 目标

让 Principle Tree 的 lifecycle 指标真正工作，而不是停留在文档口号层。

### 必做项

1. `Rule.coverageRate`
2. `Rule.falsePositiveRate`
3. `Implementation.coveragePercentage`
4. `Principle.adherenceRate`
5. `Principle.deprecated` 候选判断

### 依赖

- M6
- M7

### 第一版建议计算口径

`Rule.coverageRate` 综合：

- related negative hit rate
- principle anchor pass rate
- implementation stability

`Rule.falsePositiveRate` 综合：

- success-positive 误杀率

`Principle.adherenceRate` 综合：

- 相关 Rule coverage
- repeated pain 是否下降
- 线上遵守情况

### 验收标准

- 可看到某 Rule 的 coverageRate
- 可看到某 Principle 的 adherenceRate
- 可识别某 Principle 是否满足 deprecated 候选条件

### 风险

- 若 coverage 只基于 negative 命中，系统会被动、局部、短视

---

## 14. M9 Principle Internalization Strategy 初版路由

### 目标

把“最便宜内化方式优先”的哲学正式编码成系统策略。

### 必做项

1. 定义失效类型
2. 建立实现形态路由规则
3. 允许从 skill 升级到 code，再升级到 LoRA
4. 明确“已足够内化则不再升级”

### 依赖

- M7
- M8

### 初版策略建议

- 行为习惯问题 -> skill / prompt
- 高风险硬边界 -> code
- 长程风格与规划倾向 -> LoRA
- 插件层解决不了 -> full fine-tune 候选

### 验收标准

- 系统能对某个 Principle 给出建议内化路径
- 不默认一切问题 code 化
- 支持“停在当前实现，不继续升级”

### 风险

- 若此阶段缺失，系统会重新滑回“所有问题都写规则代码”的错误轨道

---

## 15. 里程碑依赖关系

```text
M0
 ├─ M1
 ├─ M2
 └─ M3 (依赖 M1 + M2)

M4 依赖 M1
M5 依赖 M3 + M4
M6 依赖 M5
M7 依赖 M5 + M6
M8 依赖 M6 + M7
M9 依赖 M7 + M8
```

核心顺序可以压缩成一句话：

> 先做主账本，再做宿主，再做评估闭环，再接 nocturnal，再做策略路由。

---

## 16. 推荐实施批次

如果要按现实开发节奏拆批，建议这样分：

### 批次 1

- M1 Principle Tree 主账本实体化
- M2 删除 `message-sanitize.ts`

### 批次 2

- M3 Rule Host MVP
- M4 Code Implementation 实体存储

### 批次 3

- M5 离线回放
- M6 Manual Promotion 闭环

### 批次 4

- M7 Nocturnal code artifact 扩展
- M8 coverage / adherence / deprecated 闭环

### 批次 5

- M9 Principle Internalization Strategy 初版路由

---

## 17. 每阶段都必须守住的边界

### 边界 1

在 M6 前，不允许自动上线 code implementation。

### 边界 2

在 M8 前，不以“已写实现”冒充“已内化原则”。

### 边界 3

在 M9 前，不让系统默认一切问题走 code 路线。

### 边界 4

在新系统成熟前，保留 `Progressive Gate`。

---

## 18. 最终目标图景

当 M0-M9 全部完成后，系统应达到以下状态：

1. Principles 不再只是 prompt 文本
2. Rule / Implementation 成为真实可追踪结构
3. code implementation 成为合法、受限、可回滚的树叶层
4. nocturnal 能研究并生成多种实现候选
5. 系统能先选最便宜的内化方式
6. 线上能快速止血，休眠态能消除误杀与重复犯错
7. coverage 与 deprecated 成为真实生命周期机制

---

## 19. 总结

这份路线图的核心思想是：

> 不把“原则内化系统”一次性做成一个大爆炸项目，而是按主账本、宿主、评估、候选工厂、策略路由五层逐步搭建。

这样可以确保：

- 每一步都可验证
- 每一步都可回退
- 每一步都不要求先删除当前安全边界
- 系统始终朝“原则真正内化”演进，而不是堆更多概念和脚本
