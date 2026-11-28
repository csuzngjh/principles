# PD Constrained Action Environment v1.1
## 行为轨迹治理的最小可落地架构 SPEC

> **状态**：Proposed / 待 Owner 架构评审；**不是实施授权**  
> **日期**：2026-11-28  
> **基线**：`csuzngjh/principles` `main`，`e30202366f53df60ccaf7589f7988cf445a52fba`  
> **取代**：对话中的《PD Constrained Action Environment v1.0》（本次仅修订架构约束，未修改仓库）  
> **约束**：不另建数据管道、不新增后台消费者、不新增 Agent / DSL / 数据库、不自动生产激活。

---

## 0. 决策摘要

**目标不变**：将 PD 从以单次工具调用为中心的 RuleHost，发展为利用真实、可信、可验证的行为轨迹来执行 Owner 原则的治理环境；**不把 Agent 约束成固定流程，也不让 LLM 用自身声明替代授权或事实**。

**实现策略调整**：v1.1 不把 `occurredAt`、时间窗口和多种通用 Temporal Helper 作为第一阶段前提。先证明现有 `tool_calls → RuleContextV2 → RuleCode → Host Gate` 的历史证据质量、顺序可信度和跨宿主覆盖，再用**一个 Shadow 轨迹原则**做真实负控。只有数据和评估证明存在最小能力缺口，才允许扩展现有 ABI。

**必须守住的边界**：

1. **治理权威**：`state.db` 的批准、激活、Owner 决策权威不迁移到 trajectory 数据；`tool_calls` 只提供有界、可能不完整的宿主行为证据。
2. **后台所有权**：PR #2810 后 `PD Service Host` 是唯一后台消费者调度者；同步 `before_tool_call` 仍属于宿主 Hook。两者不能互相篡位。
3. **输出能力**：只承诺当前宿主确实能执行的硬拦截。`requireApproval` 作为规则结果不等于当前工具已暂停；Codex、WorkBuddy 不支持 OpenClaw 的参数改写。
4. **时间语义**：`tool_calls.id` 是入库顺序，`created_at` 在部分路径是写入时间。未经证实，不能作为跨异步补记的真实因果时间。
5. **证据完整性**：`history.status=available` 与 `truncated=false` 不足以证明完整会话；还须处理保留、缺失行、宿主盲区、未知结果和事后补记。
6. **改动规模**：只允许扩展现有 `RuleContextV2`/读取投影/测试契约，不建设第二个 Event Store、Policy Engine、Action Broker 或状态机。

## 1. 生产事实基线与相关模块

| 模块/数据 | 当前事实 | v1.1 决策 |
|---|---|---|
| `host-runtime/src/production-rulehost-gate.ts` | 三宿主共享生产门；仅处理可评估类型，缺少规范化目标路径时提前 Allow；V2 历史不可用时一般跳过依赖该历史的规则 | **保留**；先覆盖率审计，禁止偷偷扩大可评估行动集 |
| `principles-core/src/runtime/internalization/rule-context-v2.ts` | `history.calls`、`facts`、`status`、`truncated`；`computeBehaviorFacts()` 当前基于可见窗口计算 | **保留 V2**；先核对“无读记录 ≠ 已证明未读” |
| `host-runtime/src/behavior-history.ts` | 构造历史要求 outcome 为 `success/failure/blocked` | 与生产 `unknown` 记录存在契约不齐；先做负控 |
| `host-runtime/src/production-pain-evidence.ts` | 生产 PostToolUse 可记录 `unknown`；存在可信工具结果事后补记/回填 | 不用推断将 `unknown` 偷换为成功或失败；不把入库时间直接当动作时间 |
| `host-runtime/src/workspace-behavior-evidence.ts` | 读取 `tool_calls`，依据同 Session/Project、时间 cutoff、调用 ID 和可选 host_kind 过滤 | 复用；核实不完整标志与跨宿主证据来源 |
| `host-runtime/src/codex-rule-context-provider.ts` | 使用真实历史；Shell / other 和截断可降级事实到 unknown；有 Codex 特定 designGate | 不宣称三宿主完全一致 |
| `host-runtime/src/workbuddy-rule-context-provider.ts` | 严格检查 host_kind，未知归属和窗口污染会降级；无 Codex 设计审批事实 | 不借用别的宿主的审批事实 |
| `openclaw-plugin/src/core/rule-context-assembler.ts` | 默认读取较小历史窗口（20）；历史不完整与窗口派生事实仍需检查 | 重点测试截断时 `priorReadOfTarget` 的可信语义 |
| `principles-core/src/runtime/trajectory-retention.ts` | `tool_calls` 等数据存在保留策略，默认 90 天 | 不能以“不存在记录”证明历史未发生 |
| `host-runtime/src/governance-observation-store.ts` | `governance_observations` 用于会话治理观察，文本的保留与来源授权有独立契约（默认最多 32 条可见 turn 和 7 天） | **不能**默认并入实时 RuleContext 或绕过同意/撤回规则 |
| `Service Host`（PR #2810） | 唯一后台运行时，OS 调度驱动有界 `--once` Worker，Companion 仅 UI/Control Plane | 禁止再加旁路后台 RuleHost 消费者 |

**事实可信范围说明**：`trajectory-types.ts` 的注释将相关数据表述为分析/支持证据而非控制权威。v1.1 据此明确：行为观测可以辅助 `RuleCode` 判断，但不得成为授予权限、推定 Owner 同意或替代 `state.db` 决策的权威。历史记录的使用仍必须服从现有 Gate 的验证与降级约定。

## 2. 问题与范围

### 2.1 要解决

- 使规则识别**同作用域、同资源的相关行为序列**，而不只是匹配当次工具名。
- 让规则知道它所使用的历史事实究竟可信到什么程度。
- 保留 Agent 自主寻找解决路径的能力；规则表达**必须满足的约束**，不是固定工作流。
- 可通过现有 Golden Trace、Shadow 和 Examiner 区分误拦、漏拦、正常任务受损。

### 2.2 不解决

- 完整时序策略语言（Dogwood DSL）、跨 Session 永久状态机、跨宿主自动轨迹聚合。
- 任务规划、Agent 自我反思和策略生成；不引入工具调用时的额外 LLM。
- 新的 OS Sandbox、通用 Capability Broker、通用审批暂停/恢复机制。
- 新的事件数据库、写入通路、后台 Service、管理控制台、全局政策引擎。
- 因本项目顺手修复所有旧历史数据问题或改变既有 Owner/激活决策。

## 3. 权威、观测、授权三层边界

### 3.1 事实分层

| 层次 | 正本 | 可用于 | 不能声称 |
|---|---|---|---|
| **治理权威** | 现有 `state.db` / Approval / Activation | 有无正式批准、规则是否 Live | 从工具参数或 transcript 文字中推导 Owner 授权 |
| **工具行为证据** | `trajectory.db` 的 `tool_calls`，经既有 host provider 验证 | 已经观察到的工具行为、资源、结果及有限窗口中的关联 | 完整因果链、业务目标已完成、所有动作都被捕获 |
| **会话观察材料** | `governance_observations` 等受同意与保留约束的数据 | 既有管线的授权诊断/上下文 | 不经显式契约直接注入 RuleCode 或变成工具执行权威 |

在本版本中，**绝不新增三者之间的隐式写入或读取通道**。

### 3.2 同步与异步边界

```text
Host PreToolUse ──> HostAdapter ──> Shared RuleHost Gate ──> Host Allow/Deny
Host PostToolUse ──> 现有 Tool Evidence Writer ──> trajectory.db
OS Scheduler ──> PD Service Host ──> 有界 Worker ──> 原有内部化/诊断管线
```

RuleHost **不得**启动、调度、抢占 Service Host Worker；Service Host **不得**成为工具调用批准的隐式同步前置条件。

## 4. 行为轨迹定义：保留原有数据结构

复用 `RuleContextV2.history.calls`，当前 `RuleToolCallRecord` 不直接新增字段：

```ts
interface RuleToolCallRecord {
  sequenceId: number;        // 当前实际是持久化记录 ID，不声明为真实因果序号
  toolName: string;
  canonicalKind: CanonicalKind;
  normalizedPath: string | null;
  paramsSummary: Record<string, unknown>;
  outcome: 'success' | 'failure' | 'blocked'; // 生产 unknown 必须单独处理
}
```

**约束**：

- 一个窗口内观察到“存在 E”，可以作为正向证据；观察不到 E，不一定能推出“E 从未发生”。
- 历史数据可读不代表历史完整；`truncated=false` 不能覆盖保留清理或采集盲区。
- `normalizedPath=null` 是无法归属资源，不是对所有资源有效的通配符。
- `canonicalKind=execute` 不保证 Shell 的所有文件读写都已被解析成可追踪资源。
- `outcome=success` 仅是宿主级工具成功；不能证明业务成功、测试断言全绿或 Owner 已批准。
- 无可信宿主结果、补记身份不完整、跨宿主冲突均应为 **UNKNOWN**，不允许捏造。

## 5. 最小轨迹判断语义：三值而不是布尔偷换

**不引入通用 DSL。** 第一阶段只在离线测试样例中定义以下三个关系：

1. **已观察到某个行为（Exists Witness）**：匹配同会话、同项目、同宿主、同资源的已记录行为；只要有可信正例，即使前段窗口不完整，也可以证明“至少出现过一次”。
2. **同目标关联（Same Target）**：使用现有规范化资源标识；目标缺失、Shell 资源不透明或工具映射为 other 时，必须返回 unknown。
3. **可证明的先后（Ordering）**：仅在可信宿主原生调用标识/序号能够证明真实发生顺序时得到 yes/no；否则 unknown。`row.id` 只能证明 DB 入库顺序。

约定结果：`yes / no / unknown`（此处是评估语义，不要求立刻新增公共 enum）。

**三值判断细则**：

| 查询 | 可证 Yes | 可证 No | Unknown |
|---|---|---|---|
| 历史中存在 E | 具有可信匹配事件 | 能证明目标范围内历史被完整覆盖且没有 E | 截断、保留、采集盲区、跨宿主归属不明 |
| 同一目标 | 两个可信规范化资源相同 | 两个可信资源不同 | 资源无法解析 |
| A 先于 B | 可信宿主事件顺序能证明 | 可信宿主事件顺序能证明反向 | 只有 DB 入库顺序、异步补记或冲突 |
| 某窗口次数 ≥ N | 仅观察到的可信匹配事件已经 ≥ N | 可证明窗口完整且计数不足 | 窗口不完整且尚不足 N |
| 某窗口次数 < N | 可证明窗口完整且计数不足 N | 已观察到 N 条可信事件 | 窗口不完整 |

**时间窗口能力暂不进入 v1.1 工程目标**：先证明宿主发生时间的可信来源、时钟和补记排序，然后才能考虑 `occurredAt` 投影；不应先加字段再补语义。

## 6. `RuleContextV2` 的兼容规则

### 6.1 不改版本与公共 ABI（第一阶段）

现有 `history.status`、`truncated`、`calls`、`facts` 原样保持；不直接新增 `RuleContextV3`、`BehaviorTrajectoryV1` 等平行公共契约。

先用真实 Replay 检查以下冲突：

- `tool_calls.outcome='unknown'` 经 `assembleBehaviorHistory()` 会不会让整个窗口 unavailable；
- OpenClaw 的截断窗口中，`computeBehaviorFacts()` 是否可能输出不可靠的 `priorReadOfTarget='no'`；
- Codex/WorkBuddy 中 execute/other 引发的 facts 降级与 OpenClaw 是否不同；
- 事后 `recordVerifiedToolOutcomes()` 插入或升级记录是否改变窗口顺序；
- `history.status='available' && truncated=false` 是否被错误用作全历史覆盖证明；
- 同名会话、未归属 legacy 行、错 project_dir 是否进入历史。

### 6.2 如果确需改 ABI

必须先提供：真实负控、唯一受影响的读写者清单、旧规则语义差分、生成/评估/回放与运行时输入一致性、迁移/发布兼容方案。只允许在既有 `RuleContextV2` 及其 Validator/Provider 体系内增量改动。不得静默过滤 unknown 行、把缺失字段填成 false、把未实现的契约输出成成功。

## 7. RuleHost 与宿主能力：分层处置

### 7.1 保留现有 RuleCode 与 Gate

- 继续使用 `evaluate(input, helpers)`、现有生成/校验/对抗回放、Shadow/Live 激活、安全熔断。
- 继续按现有 `isRuleHostEvaluableKind` 路由与 `normalizedPath` 约定执行；**本 SPEC 不偷偷扩大 Gate 覆盖范围**。
- `affectedTools` 仍按 PRI-1187 为声明与观测范围，**不是**运行时硬过滤；不擅自恢复过滤。
- 轨迹关系首先在规则端使用已经可信且验证过的 `RuleContextV2` 信息；若存在重复语义且必须统一，才考虑在 `computeBehaviorFacts` 所在纯函数层提供最小可复用投影。

### 7.2 不把 `requireApproval` 伪装成强拦截

当前 RuleCode 类型保留 `allow/block/requireApproval/auto_correct`，但不等于三宿主均可实施四种宿主动作：

| 能力 | OpenClaw | Codex | WorkBuddy |
|---|---|---|---|
| Live 的有效 `block → deny` | 已有执行路径，需实际回归 | PreToolUse deny | PreToolUse deny |
| `requireApproval` | 当前适配器记录事件，不能直接推定暂停 | 无通用待审暂停输出 | 无通用待审暂停输出 |
| `auto_correct` 改写参数 | 仅既有受验证的特定路径 | Encoder 拒绝 modifiedInput | Encoder 拒绝 modifiedInput |

**v1.1 Shadow / 受控 Live 实验只允许以 `allow`、`block` 作为可验证干预行为。** 遇到未知历史，只有在**明确存在受保护的宿主 deny 能力、Owner 批准的规则表达了此风险**时，才允许作为违规条件触发 block；不能依靠“记录了 requireApproval”实现保护。

### 7.3 覆盖限制与恢复路径

- 必须输出能接入 Gate 的工具家族、能关联资源的调用比例、缺路径和 unknown 类型的调用比例。
- 对没有目标路径的 `agent/execute`，当前可能在 RuleHost 之前放行，**不得声称已被治理**。
- 不更改宿主的 OS Sandbox、网络/文件权限边界。
- 所有拒绝必须有可观察原因并可回到 Agent；不能据日志记录推断模型确实见到原因。

## 8. 一个最小验证场景，而不是先做通用 Temporal Engine

选择 **“同目标操作失败后，未经新观察的重复尝试”** 作为 Shadow 研究场景，不直接作为生产硬拦截规则。

### 8.1 假设

在宿主能够证明同目标失败、之后的观察及真实事件顺序时，RuleCode 可以检测到“重复失败后未获取新证据即再次行动”的风险，而不依赖工具原始名称。

### 8.2 必须区分

- **风险信号**：可证明反复失败，但未见有效的新观察。
- **真正违规**：还需要 Owner 原则的触发范围和反例支持。
- **合理行为**：幂等重试、瞬时故障重试、只读补偿检查、目标变化、变更已回滚、结果迟到。

该例**不能**以“一次失败后必须读文件”之类机械流程作为通用规则。

### 8.3 Golden Trace 及负控

1. 同一目标：失败→无新观察→重试（候选匹配）。
2. 同一目标：失败→可信观察→重试（反例）。
3. 目标 A 失败→操作目标 B（反例）。
4. Host 原生先后与 DB 入库先后相反（必须 unknown）。
5. 失败结果为 unknown 或事后补记（不得假定失败）。
6. 历史截断、数据保留、无法证明会话起点（否定命题不得随意成立）。
7. Shell/agent 无可解析目标、跨宿主同名 Session（不得命中同目标证据）。
8. 合法幂等/瞬时故障恢复，不得被规则过度阻断。
9. 当前操作本身不提前计入历史成功。
10. 不可用上下文时，健康旧规则、故障遥测和宿主可用性语义保持原样。

必须在同一组样例上验证离线 replay、真实生产 Gate 的 Shadow 决策一致。旧规则的差分结果必须零意外变化。

## 9. 分阶段实施与门禁

### Stage 0 — Read-only Reality Audit（唯一无条件许可的下一步）

**不修改代码/数据/配置**，输出：

- 当前 `main` HEAD，实际模块调用图，Service Host / Hook 所有权；
- 真实 `tool_calls` 字段、行的来源、unknown 和事后补记行为；
- 三宿主上下文覆盖及权限/会话边界；
- 顺序可信度和历史完整性的可证明范围；
- 数据保留、缺失/截断与已过期事实；
- 旧规则受影响的公共 API、测试、文档和发布路径；
- 最小 pilot 的可行性结论：**READY / LIMITED / BLOCKED**，每个 NOT READY 有具体 blocker。

**Stage 0 不得直接跟进 Stage 1。** 审计交付后需按证据决定最小工程范围。

### Stage 1 — Offline Trajectory Replay（条件启动）

- 仅选一个宿主与一个已核实的调用形状；优先用已存在的纯函数和 Golden Trace 入口。
- 初次测试不改真实 RuleCode ABI、不变更数据库 Schema、不生成新生产激活。
- 首轮失败必须被归因到 `data / host / semantic / rule / test` 之一，不得把一切归因于模型。
- 如果无法证明顺序与目标，结论是 **LIMITED / BLOCKED**，不能降低验收标准。

### Stage 2 — Minimal Compatibility Closure（只有失败用例确实需要才做）

- 优先修正已有数据投影或 Validator 的真实不一致。
- 最多一条狭窄的兼容修复 PR；对 ABI 变化需先单独提交契约差分和 Owner 审批。
- 不许通过“删除不认识的历史行”让测试转绿。
- 不引入 `occurredAt`，除非有可信动作发生时间、补记处理和三个宿主的真实验证方案。

### Stage 3 — Shadow Trial

- 复用已有审批、Shadow 激活及 `rulehost_evaluated` 证据；不创建新的评估存储。
- 只在已验证的宿主/工具覆盖范围内执行。
- 测量会话级有效机会数量、真实匹配、误判、unknown、执行延迟与正常任务影响。
- 不能用 Shadow “会拦截数”冒充实际任务成功改进。

### Stage 4 — Owner Decision / Optional Live

- 无自动晋阶。Owner 根据可核实 Shadow 证据明确审批。
- 只针对可证明的硬约束场景使用 `block`，并验证宿主真实拒绝、Agent 可见反馈、受保护的停用/恢复命令以及回滚路径。
- 若真实环境的证据不足或误判风险不可接受，**保持 Shadow**，不扩展范围。

## 10. 验收标准

**A. 架构**

- 无新 DB、新表、新后台消费者、新 Agent、新通用 DSL、新 Action Broker。
- 现有 `state.db` / `trajectory.db` / `governance_observations` 权威与用途不漂移。
- Service Host 的后台消费所有权不变；宿主 Hook 仍同步实施现有 Gate。
- 旧 RuleCode、旧回放与三宿主适配器没有未经授权的语义变化。

**B. 事实与安全**

- `unknown`、异步补记、截断、保留清理、跨宿主污染、错 project、无目标路径均有负控。
- 无可信宿主因果顺序时，不把 DB ID 或 created_at 宣称为真实时序。
- `requireApproval` 记录不被误报为工具拦截；`auto_correct` 不被误报为跨宿主通用能力。
- 不增加 LLM 实时调用；沿用现有运行时 3 秒总预算与子进程 2.5 秒预算。

**C. 效果**

- 至少一个场景在**真实可观察的工具序列上**相较单次工具关键词匹配有增量判别力。
- 必须有不同工具别名、目标变化、合法恢复、边界证据的反例。
- 误拦截、漏拦截与正常任务完成影响透明；无明确有效机会样本时不能宣称成功。
- Examiner 长期行为改进是后续独立验证，不因 Shadow/Live 成功自动宣称完成。

## 11. 复杂度增量上限

| 项目 | Stage 0-1 允许 | Stage 2+ |
|---|---|---|
| 新 durable truth / DB / 表 | **0** | **0**，除非单独 Owner 改变架构决定 |
| 新后台服务 / Agent | **0** | **0** |
| 新 Policy / Temporal DSL | **0** | **0** |
| 新公共 Runtime Contract | **0** | 只有带完整 ABI 差分的最小扩展可提案 |
| 已有纯逻辑函数修改 | 仅离线测试，不生产改动 | 由失败用例和 Owner 审批决定 |
| Host Adapter 修改 | **0** | 仅经证明必要的狭窄契约修复 |
| 生产激活和自动晋阶 | **0** | 自动晋阶始终 **0** |

## 12. 停工条件

任一出现，必须停止进入下一阶段并报告：

1. 需要第二个行为事件数据库或第二个 RuleHost；
2. 需要改写已经合并的 Service Host 所有权；
3. 需要将未经同意的会话原文并入 RuleCode；
4. 无法证明历史的顺序、来源和作用域却要得出硬拦截结论；
5. 为通过测试而把 unknown 当 success/failure 或把缺失当 no；
6. 无法证明 Host 的真正执行输出，却宣称审批已经阻止操作；
7. 需要修改老规则的语义而没有单独的负控、审批和回滚。

## 13. 研究参考（不添加直接依赖）

- Dogwood：行为轨迹和时间逻辑；https://github.com/dogwood-policy/dogwood
- Cedar：主体、操作、资源与上下文授权；https://github.com/cedar-policy/cedar
- AgentSpec：动态干预；https://github.com/haoyuwang99/AgentSpec

**不将上述项目作为本轮 NPM 依赖。**

## 14. 与 v1.0 的主要变更

1. **取消**“Stage 1 直接加 `occurredAt`”；改为确认真实因果时间后再考虑。
2. **增加**真实 `unknown` 结果 vs RuleContext 校验不一致的前置调查。
3. **增加**异步补记与 DB 入库顺序不能等同于实际事件顺序的规则。
4. **增加**90 天 trajectory 保留期与 7 天 governance 文本保留期的边界。
5. **增加**PR #2810 后 Service Host 独占后台消费的架构约束。
6. **增加**`requireApproval` 不等于宿主级暂停、Codex/WorkBuddy 不支持参数改写的能力矩阵。
7. **增加**`normalizedPath=null` 导致 RuleHost 跳过的覆盖盲区说明。
8. **收缩**初期验证范围：先一个 Shadow 轨迹场景，后按证据推进。
9. **强化**存在性与不存在性证据的区别、三值和上下文完整性的负控。
10. **保留**全部现有数据管道、RuleContextV2、RuleCode、RuleHost、Approval、Shadow/Live、Examiner；不再提前建议新的通用 Temporal 层。

---

## 15. 源码依据（固定 SHA，避免 main 后续漂移）

- [共享生产 Gate](https://github.com/csuzngjh/principles/blob/e30202366f53df60ccaf7589f7988cf445a52fba/packages/host-runtime/src/production-rulehost-gate.ts)
- [RuleContextV2 与 computeBehaviorFacts](https://github.com/csuzngjh/principles/blob/e30202366f53df60ccaf7589f7988cf445a52fba/packages/principles-core/src/runtime/internalization/rule-context-v2.ts)
- [共享历史装配](https://github.com/csuzngjh/principles/blob/e30202366f53df60ccaf7589f7988cf445a52fba/packages/host-runtime/src/behavior-history.ts)
- [Workspace 行为历史读取](https://github.com/csuzngjh/principles/blob/e30202366f53df60ccaf7589f7988cf445a52fba/packages/host-runtime/src/workspace-behavior-evidence.ts)
- [生产工具事实与补记](https://github.com/csuzngjh/principles/blob/e30202366f53df60ccaf7589f7988cf445a52fba/packages/host-runtime/src/production-pain-evidence.ts)
- [Canonical 轨迹 Schema](https://github.com/csuzngjh/principles/blob/e30202366f53df60ccaf7589f7988cf445a52fba/packages/principles-core/src/runtime/trajectory-schema.ts)
- [Retention 策略](https://github.com/csuzngjh/principles/blob/e30202366f53df60ccaf7589f7988cf445a52fba/packages/principles-core/src/runtime/trajectory-retention.ts)
- [governance_observations 存储和保留](https://github.com/csuzngjh/principles/blob/e30202366f53df60ccaf7589f7988cf445a52fba/packages/host-runtime/src/governance-observation-store.ts)
- [OpenClaw 规则决策适配](https://github.com/csuzngjh/principles/blob/e30202366f53df60ccaf7589f7988cf445a52fba/packages/openclaw-plugin/src/hooks/gate.ts)
- [Codex 输出契约](https://github.com/csuzngjh/principles/blob/e30202366f53df60ccaf7589f7988cf445a52fba/packages/codex-adapter/src/codec/output-encoder.ts)
- [WorkBuddy 输出契约](https://github.com/csuzngjh/principles/blob/e30202366f53df60ccaf7589f7988cf445a52fba/packages/workbuddy-adapter/src/codec/output-encoder.ts)
- [Service-Host-only 合并提交](https://github.com/csuzngjh/principles/commit/2a5d707704e310cdda88a5ac188312a27687a86d)
- [最近修复任务权威收敛提交](https://github.com/csuzngjh/principles/commit/e30202366f53df60ccaf7589f7988cf445a52fba)

> **验证口径**：本版本是对当前远端源码、提交记录、既有测试源码与报告的静态复核；没有在本会话运行测试，也没有访问用户生产 Workspace 数据。真实宿主事件顺序与完备性仍是 Stage 0 需要证明的事实，不能由源码存在推断其生产证明已成立。
