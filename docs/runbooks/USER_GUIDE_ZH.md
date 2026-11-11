# Principles Disciple 用户操作手册

这份手册只写当前版本里真正需要用到的操作，不讲过时设计。版本号以安装包的 `package.json` 为准，本文不再标注固定版本。

## 这个系统现在负责什么

当前系统主要做两件事：

1. 在智能体执行任务时保护工作区。
2. 把反复出现的错误沉淀成原则、实现和回放评估结果，逐步内化成更稳定的行为。

你不需要理解全部架构，日常只要掌握下面这些命令。

### 原则生命周期

原则有四种状态：

| 状态 | 含义 |
|------|------|
| `candidate` | 新提案，尚未审核 |
| `probation` | 试用期 / 影子模式——已激活但仍在监控副作用 |
| `active` | 正式生效 |
| `archived` | 已归档，不再生效 |

## 开始之前：先给 PD 一个 LLM

PD 的内部智能体——diagnostician、dreamer、scribe、artificer、signal collector——用**您自己的** provider 账号发起 LLM 调用。PD 不带密钥，也不保存密钥值。

能不能跑起来，取决于 `<workspace>/.pd/config.yaml` 里 `pd.default` 这三个字段：

```yaml
runtimeProfiles:
  pd.default:
    type: pi-ai
    provider: anthropic            # 安装器接受 openai | anthropic | deepseek
    model: claude-3-5-haiku-latest
    apiKeyEnv: ANTHROPIC_API_KEY   # 存放密钥的环境变量“名字”，不是密钥
```

也可以在安装时就指定：

```bash
npx create-principles-disciple --yes --provider anthropic --api-key-env ANTHROPIC_API_KEY
```

或者之后在控制台里设置：`pd console open --workspace "<路径>"` → 控制中心 → 运行时配置。

**跳过这一步会怎样**：痛苦信号照样捕捉、照样留存，但诊断不会运行，也不会提出任何原则。`pd config doctor --workspace "<路径>"` 会报 `needs_setup` 并点名将缺的字段；控制中心会把这一节标成「需配置」。

## 日常命令

### `/pd-status`

当 AI 明显卡住、误解你、或者一直重复同样错误时，用这个命令先看状态。

- `/pd-status`：查看当前疲劳/摩擦状态
- `/pd-status reset`：清空当前会话摩擦值，让 AI 重新判断
- `/pd-status empathy`：查看情绪事件统计
- `/pd-status empathy --week`：查看周趋势
- `/pd-status empathy --session`：只看当前会话

如果 AI 在同一个错误上打转，优先用 `reset`。

### `/pd-rollback last`

当情绪系统误判了你的语气或意图时，用它撤销最近一次惩罚。

- `/pd-rollback last`：回滚当前会话最近一次情绪惩罚
- `/pd-rollback <eventId>`：回滚指定事件

它只撤销指定的情绪惩罚事件，不会把整段会话状态全部清空。

## 代码实现运维流程

这部分是给需要操作 code implementation 的人看的，不是每次都要用。

### 什么时候需要用

在下面这些场景里使用：

- 系统产生了新的 candidate implementation
- 你想先跑 replay，再决定要不要 promote
- 当前 active implementation 出现回归，要禁用或回滚
- 老实现已经废弃，需要归档

### 第一步：列出候选实现

```text
/pd-promote-impl list
```

它会列出当前 candidate implementation，并标记哪些已经有通过的 replay report。

> ⚠️ **注意**：Legacy replay 生成路径已在 PRI-230 退役，当前没有 CLI 入口可以生成新的 replay 报告。只有已经存在通过 replay 报告的实现才能被 promote。旧文档中提到的 `eval` 子命令已不存在。

### 第二步：查看 replay 报告

```text
/pd-promote-impl show <implId>
```

重点看：

- 样本总数
- pass / fail 结论
- 覆盖了哪些 classification
- 是否因为没有 replay 样本导致报告为空

### 第三步：正式 promote

```text
/pd-promote-impl <implId>
```

promote 的前提：

- implementation 当前必须是 `candidate` 或 `disabled`
- 必须已经有通过的 replay report
- 如果同一个 rule 已经有 active implementation，旧的 active 会自动变成 disabled

这是 candidate 进入 active 的标准路径。

### 第四步：禁用异常实现

```text
/pd-disable-impl list
/pd-disable-impl <implId> --reason "原因"
```

当某个实现在线上表现不好、需要立刻停用时，用这个命令。

disable 会保留账本记录，但停止它继续参与运行。

### 第五步：回滚到上一个 active 实现

```text
/pd-rollback-impl list
/pd-rollback-impl <implId> --reason "原因"
```

当当前 active implementation 需要撤回，并恢复到上一个 active 版本时，用这个命令。

如果没有 previous active implementation，系统会退回到仍然存在的宿主硬约束继续保护：

- RuleHost 原则拦截
- Edit verification
- 其他已有硬约束

> 注：GFI 与 Progressive Gate 已退役，不再作为回退边界。

### 第六步：归档实现

```text
/pd-archive-impl list
/pd-archive-impl <implId>
```

当某个 implementation 已经过时、不应该再参与后续 promote 时，用归档。

archive 比 disable 更彻底，适合做永久清理。

## 推荐操作顺序

当系统出现新的 code candidate 时，推荐按这个顺序操作：

1. `/pd-promote-impl list`
2. `/pd-promote-impl show <implId>`
3. `/pd-promote-impl <implId>`

如果 promote 后发现它有回归：

1. `/pd-disable-impl <implId> --reason "原因"`
2. 如果要恢复旧版本，再执行 `/pd-rollback-impl <implId> --reason "原因"`
3. 如果这个实现已经彻底废弃，再执行 `/pd-archive-impl <implId>`

## 如何理解内化路线建议

内化路线建议长这样：

- `prompt`
- `code_tool_hook` (RuleHost)
- `defer_archive`

它们的含义是：

- `prompt`：这个原则更适合先通过提示词 / SOP / 工作流来内化
- `code_tool_hook` (RuleHost)：这个原则更确定、风险更高，适合变成 code implementation
- `defer_archive`：当前证据还不够，先不要强行内化

这些只是建议，不会自动执行。

## 常见问题

### "Promotion rejected: no passing replay report"

Legacy replay 生成路径已在 PRI-230 退役，当前没有 CLI 入口可以生成新的 replay 报告。只有已经存在通过 replay 报告的实现才能被 promote。

可以查看已有报告：

```text
/pd-promote-impl show <implId>
```

如果没有报告，在 replay 生成路径恢复之前，该实现无法通过 CLI 进行 promote。

### “Replay report 是空的”

说明当前没有找到已分类的 replay 样本。

检查：

- 工作区里是否已经产生 nocturnal / replay 数据
- implementation 是否挂到了正确的 rule 上
- 最近会话里是否产出了可用样本

### “明明 disable 了，实现为什么还像被限制住？”

这是正常现象。disable code implementation 以后，系统的宿主硬约束仍然存在，例如：

- RuleHost 原则拦截
- Edit verification
- 其他已有硬约束

> 注：Thinking checkpoint、GFI 与 Progressive Gate 已退役，不再属于当前硬边界。

### “我只是想知道系统健不健康”

直接用：

```text
/pd-status
```

这对大多数日常使用已经够了。

### "有些功能看起来被禁用了或者缺失"

部分子系统（如 `correction_observer`）**默认关闭**，这是 MVP-Quiet 设计（ADR-0014），不是故障。在种子客户证据支持更大范围激活之前，它们会保持关闭。你可以在工作区的 `.pd/config.yaml` 中查看哪些子系统已启用。

### 「痛苦信号一直在收，却从不提出原则」

这基本都是 LLM 运行时配置的问题，不是链路坏了。诊断和提出原则是用您自己的 provider 账号发起的 LLM 调用；`provider`、`model` 或 `apiKeyEnv` 缺任何一个，智能体就会停在 `needs_setup` 不再往下走。先跑 `pd config doctor --workspace "<路径>"`，它会点名将缺的字段；补齐办法见本手册开头的「开始之前：先给 PD 一个 LLM」一节。

## 使用 Examiner 评估一个原则

### Examiner 是做什么的

Examiner 是控制台里评估「某一条原则到底有没有产生行为效果」的地方。它把一条原则放进一组固定的对照用例里，跑一遍研究流程，再给出一份报告。

它评估的对象始终是**一条具体的 Principle**（通过 principle id 选定），不是整个原则库、也不是某次任务。

### 它和「查看原则详情」的区别

| | 原则详情 | Examiner |
|---|---|---|
| 回答的问题 | 这条原则写了什么、现在是什么状态 | 这条原则被注入后，行为是否真的改变 |
| 数据来源 | 账本与激活记录 | 冻结的实验输入 + 对照执行 + 统计 |
| 输出 | 事实与状态 | 结论、证据边界与下一步建议 |

Examiner 不做自动裁决，也不会修改任何原则状态。

### 什么时候需要用

- 新原则准备正式启用，想先看效果。
- 某条 active 原则上线后，没有看到预期效果。
- 怀疑这条原则带来了副作用。
- 修改过原则文本或规则后，需要重新评估。

### 第一次使用：从原则详情进入

1. 打开 Controls → Principles。
2. 选择一条 `active` 原则。
3. 点击「评估此原则的行为效果」。
4. 页面会跳到 Examiner，并自动选中这条原则。

非 `active` 状态的原则不会显示可执行入口，因为当前研究契约只接受 active 原则；先完成原则治理决策，再回来评估。

### 如何阅读生产证据

Examiner 首页会展示所选原则的生产证据：账本状态、运行时激活、生产提示注入投影、RuleCode 归属。

如果证据读取失败，页面会明确显示「读取失败」和重试按钮，而**不会**显示成「没有证据」。这两件事含义完全不同：前者是数据不可用，后者是确认没有数据。

### 如何判断一条原则能不能评估（Eligibility）

选好原则后，配置页会自动做一次**资格预检**，结果只有三种：

| 状态 | 含义 | 你能做什么 |
|---|---|---|
| `ELIGIBLE` | 可以创建评估 | 直接创建 Study |
| `DEGRADED` | 可以创建，但部分生产数据不可用 | 创建，同时记住哪些结论会受影响 |
| `BLOCKED` | 当前不能评估 | 按面板给出的原因和下一步处理 |

常见的阻塞原因：

- **原则状态不支持**：只有 active 原则可以评估。
- **干预不可识别**：工作区把某个 RuleCode 绑到了这条原则，但无法证明两者可以独立控制，因此不能把混合干预的效果归因给单一原则。
- **研究套件不可用**：所选套件无法编译。
- **研究目录不可写**：工作区的研究输出目录未通过隔离检查。

预检是只读的。它给出「能创建」时，真正创建时仍会在服务端重跑同一套检查；预检说不能创建时，创建接口也会拒绝。

### 如何创建 Study

1. 选择原则。
2. 选择实验模式：`isolated_principle`（只对比单条原则）或 `full_library_incremental`（保留原则库基线）。
3. 选择一个服务端固定的 Challenge Suite（`didactic-pair` 或 `calibration-core`）。
4. 点击创建。

创建成功后页面会显示 Study ID、生产快照差异标记和输入冻结信息。创建时的输入一旦冻结，后续运行不会重新读取生产数据。

### 如何运行 Preflight

Preflight 是执行前的完整性检查。它会列出所有 blocker 和 warning：

- blocker：必须先修，修不好不能执行。
- warning：可以执行，但结果需要带着这个限制去读。

### 如何运行 Offline Study

离线执行使用确定性的离线模拟器，**零模型调用**。它验证的是研究流程本身：输入冻结、对照分组、执行、统计、报告生成是否按契约完成。

它**不能**证明真实 Agent 的行为改善，也不能证明原则在生产环境产生了因果效果。

### 如何查看 Report V2

打开 Study 的报告页，第一屏是 Owner Summary：

- **评估结论**：一句话结论 + 状态标签。
- **本次确认了什么**：最多 3～5 条真正重要的事实。
- **尚不能证明什么**：当前证据边界。
- **证据完整性**：覆盖率、截止时间、未解析项、治疗保真度、运行时加载、对照污染、限制。
- **建议下一步**：补充证据、修复可识别性、完成人工 Gold 审核、继续 Host Readiness 检查、等待 F2 授权，或回到原则治理。

报告会明确标注本次是哪种执行方式：离线契约验证（offline-stub）、宿主准备检查（host-dry-run），还是真实宿主执行（f2-real-host）。

### 如何做 Owner Decision Handoff

报告页底部有回到原则治理的入口。它只做跳转：目标原则不变、报告 ID 与 Study ID 对应、不会修改原则状态，也不会创建第二套决策系统。

### 当前能力限制和安全边界

- 本轮所有离线评估都是**离线契约验证**，不是真实行为实验。
- **Host Dry-run** 检查的是宿主运行条件（CLI、隔离、授权文件），零模型调用，通过也不等于行为验证通过。
- **F2 真实宿主执行在控制台尚未开放**。按钮是禁用状态并会说明原因；即使绕过界面直接调用接口，服务端仍会执行 Stage R 与 Owner 授权检查。
- **独立人工 Gold 审核（Gate 1）尚未完成**。自动化测试通过不等于研究套件已获得人工 Gold 审核，因此在 Gate 1 解除前不会给出正式研究可信度的效果裁定。
- 评估结论只用于支撑 Owner 的下一步治理判断，不会自动晋升、归档或修改任何原则。

## 可视化控制台

如果你的部署暴露了插件 UI，可以打开：

```text
http://127.0.0.1:3100
```

或直接通过 CLI 启动：

```bash
pd console open --workspace "<path>"
```

控制台适合做：

- 看趋势和队列
- 看修正样本
- 看 principle / implementation 的整体活动情况

## 最后只记住这三件事

1. AI 卡住了，用 `/pd-status`
2. empathy 误判了，用 `/pd-rollback last`
3. 只有在你要操作 code implementation 时，才去用 `/pd-promote-impl`、`/pd-disable-impl`、`/pd-rollback-impl`、`/pd-archive-impl`
