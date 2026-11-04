# SPEC-PD-PAIN-RECALL-CLI-001

## Pain Recall CLI MVP：按需找回原则关联的历史痛苦信号

-   **版本**：v1.0
-   **状态**：Implementation Ready ---
    开发前须按执行指令核对最新主干与实际接口
-   **目标仓库**：`csuzngjh/principles`
-   **基线参考**：此前源码核查记录所用提交
    `0e421b1095f7196c7ea8d05be52892321b6d47c6`。它是参考基线，不代表执行时的最新
    `origin/main`。
-   **优先级**：功能交付优先；不要求重新开展行为收益实验。

------------------------------------------------------------------------

## 1. 背景与目标

原则是对历史经验的抽象。抽象有助于复用，但也可能丢失当时问题的具体上下文。当
Agent
知道原则，却不确定它为何存在、适用边界是什么或当前情况是否相似时，它可以主动调用
PD CLI，检索与该原则有真实来源关联的历史 Pain。

本功能是一个**按需查询工具**，不是自动记忆注入系统，也不负责证明 PD
理论成立。

### 1.1 产品目标

提供一个稳定、快速、可解释的 CLI 查询入口，使宿主 Agent 能够：

1.  通过规范原则身份查询关联的历史 Pain；
2.  查看已有的 Pain 描述、已保存的诊断与纠错证据；
3.  知道每条结果为何与原则相关；
4.  清楚区分"没有记录""记录为空""来源不可读"和"没有诊断"；
5.  只在需要时调用，不自动注入、不强制每次任务调用。

### 1.2 非目标

首版不做以下事项：

-   不证明原则或历史检索带来多少行为收益；
-   不因实验结果 `UNPROVEN` 阻止此只读工具开发；
-   不新增数据库、表、后台服务、MCP server 或外部模型调用；
-   不自动把 Pain 历史追加到每次模型提示词；
-   不修改原则生成、激活、撤回、生命周期或治理审批逻辑；
-   不把完整 transcript、工具调用参数或整个 workspace 作为默认搜索源；
-   不推断、补写或合成未持久化的原始文本；
-   不把候选 ID 当作 Pain ID；
-   不声称可恢复实际上未被保存的数据。

------------------------------------------------------------------------

## 2. 源码事实与实施前核对

以下设计基于已检查的仓库源码结构。实现者必须先检查执行时的
`origin/main`，并核对真实导出、CLI
注册方式和调用签名；若主干已有后续改动，以最新代码为准，不得机械套用旧行号。

### 2.1 已知数据面

已核查到的相关数据和模块包括：

-   `.state/trajectory.db` 中的 `pain_events`：持久化 Pain 事件。
-   `.pd/state.db` 中的
    `pain_diagnoses`、`tasks`、`principle_candidates`、`pi_artifacts`
    等：已有诊断、任务、候选和工件关联。
-   `.state/principle_training_state.json`：原则训练状态和原则数据。
-   `resolveLedgerActivationId`：原则规范身份解析相关权威。
-   `readLedgerFileState`：保留 Ledger 可用性状态的读取入口。
-   `openTrajectoryDbReadonly`：trajectory 数据库只读打开入口。
-   `PainDiagnosisStore`：已有诊断读取能力。
-   `PainChainReadModel`：已有 Pain 链路读模型。
-   `readPromptActivationCandidates`：读取提示词激活候选的相关能力。

参考文件（以执行时主干为准）：

-   `packages/principles-core/src/runtime-v2/trajectory-schema.ts`
-   `packages/principles-core/src/runtime-v2/store/pain-diagnosis/pain-diagnosis-store.ts`
-   `packages/principles-core/src/runtime-v2/pain-chain-read-model.ts`
-   `packages/principles-core/src/runtime-v2/activation/ledger-identity.ts`
-   `packages/principles-core/src/principle-tree-ledger.ts`
-   `packages/host-runtime/src/active-principle-prompt.ts`
-   `packages/host-runtime/src/governance-observation-store.ts`
-   `packages/host-runtime/src/workspace-behavior-evidence.ts`

### 2.2 关键关联约束

`derivedFromPainIds` 的名字容易误导：在当前数据流中它可能承载的是候选
ID，而不是 Pain ID。实现必须追踪真实数据契约，不能直接执行
`pain_events.id = derivedFromPainIds[]`。

`reuseEvidence[]` 等显式复用证据可能包含 `painId`、`candidateId`
和复用决策。必须先核对 schema 与生产写入路径，再决定可接受的关联边。

候选到原则可能存在一对多关系。不得只用会覆盖旧值的
`Map<candidateId, principleId>`
作为唯一关联索引。结果应保留所有经验证的关联路径，并按来源证据去重。

原则在提示词中显示的标识不保证永远是规范 Ledger
ID；部分工件可能回退到草稿标题。查询入口必须先解析规范原则身份，不得仅靠显示标题、相似文本或未经验证的提示词
ID 关联历史。

### 2.3 信息语义约束

以下信息不能混为一谈：

-   **Pain 原始陈述**：仅在持久化记录中确实存在且可被可信关联时返回。
-   **Pain `reason` /
    `text`**：按数据库中实际字段语义分别返回，不得合并伪装成原话。
-   **诊断解释**：模型或诊断流程生成的根因、说明与支持证据，须标明是诊断信息，不是
    Owner 原话。
-   **纠错证据**：如果存在
    `correctionEvidence`，保留其来源分类和原有语义。
-   **缺失状态**：没有诊断，不等于没有
    Pain；数据库不可读，也不等于空记录。

------------------------------------------------------------------------

## 3. 用户体验与 CLI 命令

### 3.1 基础命令

建议命令：

``` bash
pd pain recall --principle-id <principle-id>
```

默认返回最多 3 条关联历史。命令应遵循现有 CLI 参数和 `--json`
约定，不引入 `--format json` 等与现有风格冲突的新接口。

建议参数：

  ---------------------------------------------------------------------------------------------------------
  参数                                            必需 语义
  ----------------------- ---------------------------- ----------------------------------------------------
  `--principle-id <id>`                             是 原则引用；必须解析为规范身份

  `--pain-id <id>`                                  否 在该原则的有效关联结果内筛选指定
                                                       Pain；不能绕过原则关联校验

  `--context <text>`                                否 当前困惑或问题，用作本地排序提示；不得据此伪造血缘

  `--limit <n>`                                     否 返回上限，默认 3；限制为 1--10

  `--json`                                          否 输出稳定 JSON 合同

  `--help`                                          否 显示命令帮助
  ---------------------------------------------------------------------------------------------------------

如果当前 CLI 已有一致的 workspace
选择参数，应复用其约定；不要在未核对之前另造一套 workspace 参数。默认
workspace 的解析必须复用既有 CLI 逻辑。

### 3.2 调用示例

列出关联历史：

``` bash
pd pain recall --principle-id p-123 --json
```

围绕当前疑惑排序：

``` bash
pd pain recall --principle-id p-123 --context "什么时候应该先查证据" --limit 3 --json
```

获取指定关联 Pain：

``` bash
pd pain recall --principle-id p-123 --pain-id pain-456 --json
```

`--context`
只影响已关联结果的排序，不能成为建立关联的依据。首版可采用确定性的词项重合排序；不调用模型、不联网。没有足够信号时保持原有权威排序。

### 3.3 列表与详情

-   未提供 `--pain-id`：返回有界列表。
-   提供 `--pain-id`：只返回该
    Pain，并确认它确实属于此原则的有效关联集合。
-   指定 Pain 不存在、不可读或不属于该原则：返回明确状态，不得以其他
    Pain 静默替代。
-   结果超过 `limit`：明确报告总的可用候选数（若可计算）及是否截断。
-   `limit` 非整数、越界或空值：参数错误，非零退出码。

------------------------------------------------------------------------

## 4. JSON 输出合同

字段名称可根据仓库现有 CLI envelope
适配，但语义必须保持一致。不要为了照抄示例而破坏项目既有 JSON 风格。

### 4.1 成功响应示例

``` json
{
  "schemaVersion": "pd.pain-recall.v1",
  "status": "ok",
  "principle": {
    "requestedId": "p-123",
    "canonicalId": "p-123",
    "identityStatus": "resolved",
    "title": "先核对证据再行动"
  },
  "query": {
    "limit": 3,
    "contextUsedForRanking": true,
    "truncated": false
  },
  "results": [
    {
      "painId": "pain-456",
      "association": {
        "type": "derived_from",
        "confidence": "explicit",
        "evidenceRefs": [
          {
            "kind": "candidate_lineage",
            "candidateId": "candidate-789"
          }
        ]
      },
      "pain": {
        "occurredAt": "2026-10-20T10:00:00.000Z",
        "source": "tool_failure",
        "reason": "工具执行失败，返回权限错误",
        "text": "数据库中持久化的证据说明",
        "rawStatement": null
      },
      "diagnoses": [
        {
          "diagnosisId": "diagnosis-111",
          "rootCause": "permission_mismatch",
          "explanation": "已有诊断保存的解释",
          "supportingEvidence": [],
          "isOriginalOwnerStatement": false
        }
      ],
      "correctionEvidence": [],
      "availability": {
        "painEvent": "available",
        "diagnoses": "available",
        "correctionEvidence": "not_recorded"
      },
      "lineage": [
        {
          "from": "principle",
          "to": "candidate-789",
          "relation": "explicit_candidate_relation"
        },
        {
          "from": "candidate-789",
          "to": "pain-456",
          "relation": "explicit_pain_relation"
        }
      ]
    }
  ],
  "summary": {
    "returned": 1,
    "availableCandidates": 1,
    "truncated": false
  }
}
```

上述 ID、文本和时间均为示意，不是对真实数据库内容的声明。实现应按实际
schema 适配字段；若某字段不存在，返回 `null` 或明确的 availability
状态，不能臆造值。

### 4.2 状态值

顶层 `status` 至少区分：

-   `ok`：成功找到结果。
-   `no_matches`：读取成功、原则身份有效，但没有可验证的关联 Pain。
-   `principle_not_found`：无法解析原则引用。
-   `ambiguous_principle`：引用无法唯一解析。
-   `pain_not_found`：指定 Pain
    不存在或不属于该原则的有效关联集合；可用细分原因字段区分。
-   `source_missing`：必需数据源不存在。
-   `source_unreadable`：必需数据源存在但不可读取。
-   `partial`：Pain 事件可读取，但部分可选信息源不可用。

不能将 `source_missing` 或 `source_unreadable` 伪装成 `no_matches`。

### 4.3 单条结果可用性

每条结果应分别标记：

-   `painEvent`：`available` / `not_found` / `unreadable`
-   `diagnoses`：`available` / `not_recorded` / `unreadable`
-   `correctionEvidence`：`available` / `not_recorded` / `unreadable`

具体 enum 可与仓库既有状态名对齐。重点是区分"确实没记录"与"无法读取"。

### 4.4 稳定性

-   `schemaVersion` 必须显式输出。
-   结果顺序必须确定性。
-   机器可读模式中，诊断信息和原始陈述不得混淆。
-   不输出 API key、环境变量值、完整数据库路径或无关 workspace 内容。
-   错误响应采用仓库既有错误 envelope；不得在 JSON 模式混入非 JSON
    日志。

------------------------------------------------------------------------

## 5. 关联解析规则

按以下优先级构建原则到 Pain 的关联图。每条边必须有可审计的来源证据。

1.  **规范原则身份**：使用既有原则身份解析器确认请求原则对应的规范
    Ledger 身份。
2.  **显式复用证据**：解析与该规范原则匹配的 `reuseEvidence`
    等权威记录，读取真实 `painId`、`candidateId`、决策和版本字段。
3.  **候选血缘**：如果原则与候选之间存在经过验证的关联，沿候选已有血缘追溯到
    Pain。
4.  **其他既有权威关联**：仅在源码核实确认它确实表达原则到候选或 Pain
    的关系后使用。
5.  **去重**：同一 Pain 可能通过多条有效路径到达；按真实 Pain ID
    合并为一个结果，同时保留所有证据引用。

### 5.1 禁止的关联推断

不得：

-   将 `derivedFromPainIds` 中的字符串直接当作 Pain ID；
-   只因标题、正文相似就创建原则---Pain 关系；
-   将 candidateId、taskId、artifactId 与 painId 互换；
-   从缺失诊断中推断 Pain 不存在；
-   从一个候选只保留最后一个原则映射，丢弃其他有效关联；
-   把提示词渲染 ID 当作未经解析的规范 Ledger ID。

### 5.2 关联类型

推荐关联类型：

-   `explicit_reuse`：有显式复用证据指向 Pain。
-   `derived_from`：通过可验证的候选/来源血缘关联。
-   `multiple_paths`：同一 Pain 通过多条有效路径关联。
-   `unknown` 不应作为成功关联类型；证据不足时不返回该
    Pain，或返回可解释的不可用状态。

`confidence` 不是模型置信度。它只能表达来源证据的确定性，例如 `explicit`
/ `lineage_verified`。

------------------------------------------------------------------------

## 6. 数据访问与只读合同

### 6.1 只读原则

-   所有数据库连接必须通过已核实的只读入口或等价的严格只读连接打开。
-   对 `.pd/state.db`
    使用仓库已有只读连接配置：`readonly: true`、`bootstrapIfMissing: false`，具体签名须按执行时主干确认。
-   对 `.state/trajectory.db` 使用已有 `openTrajectoryDbReadonly`
    或其当前等价权威。
-   缺库时不得创建文件、目录、表、schema 或空数据库。
-   禁止迁移、schema bootstrap、WAL 初始化、修复性写入或隐式状态变更。
-   不使用会自动确保 schema 或切换 journal mode 的通用写入入口。
-   不写入原则、候选、任务、诊断或观察记录。
-   不读取完整 transcript 或 `tool_calls.params_json` 作为默认 Recall
    源。
-   不发起模型请求、HTTP 请求或其他外部调用。

### 6.2 失败语义

  ------------------------------------------------------------------------
  情况                                处理
  ----------------------------------- ------------------------------------
  Ledger 文件缺失                     按既有 availability 合同返回
                                      missing；不得把缺失转换为空 Ledger

  Ledger 不可读或身份解析失败         明确 unreadable/identity failure

  trajectory DB 缺失                  不创建数据库；报告来源缺失

  state DB 缺失                       不 bootstrap；报告来源缺失

  Pain 事件存在、诊断不存在           返回 Pain，诊断状态 `not_recorded`

  诊断读取失败                        保留 Pain 结果，诊断状态
                                      `unreadable`；顶层可为 `partial`

  多来源部分成功                      返回可验证的已读数据并逐源披露状态

  关联证据不充分                      不返回为有效关联
                                      Pain，不以相似度补造血缘
  ------------------------------------------------------------------------

------------------------------------------------------------------------

## 7. 代码落点与模块边界

执行前先检查当前 CLI command tree 和 package
exports，再决定精确文件路径。建议遵循以下边界：

1.  **CLI command**：在现有 `pd pain` 命令树注册 `recall`
    子命令，复用既有 workspace 解析、输出和错误处理。
2.  **共享 Recall service/read model**：放在与现有 CLI
    数据读取职责相符的共享模块，负责规范身份解析、关联图解析、去重、排序与
    availability 聚合。
3.  **数据读取
    adapter**：只调用既有严格只读入口及已存在的查询方法；若缺少必要的只读查询，添加最小只读查询，不扩展成通用数据访问框架。
4.  **JSON renderer**：使用仓库既有 CLI JSON envelope 习惯，固定
    schemaVersion。
5.  **技能说明**：更新 Codex、OpenClaw、WorkBuddy 的现有
    `pd-cli-operator`，不新建重复技能。

不要仅因本 SPEC 建议了模块职责，就复制已有 resolver、ledger reader 或
store。先找真实导出与调用方，复用优先。

------------------------------------------------------------------------

## 8. 宿主 Agent 如何发现与使用命令

三个宿主都应扩展现有 `pd-cli-operator` 技能：

-   Codex：`plugins/principles-disciple/skills/`
-   OpenClaw：`packages/openclaw-plugin/templates/langs/en/skills/` 与
    `.../zh/skills/`
-   WorkBuddy：`packages/workbuddy-adapter/plugin/skills/`

执行时确认这些路径在最新主干仍然存在；若布局已调整，以插件清单的真实分发路径为准。

### 8.1 技能中必须说明

**什么时候用：**

-   原则已激活，但 Agent 不清楚它来自哪次失败；
-   不确定原则的触发条件或适用边界；
-   当前情况看似与原则相关，但需要比较原始历史；
-   原则文本不足以解释当时的证据或纠错。

**什么时候不用：**

-   原则本身已足够清楚；
-   当前任务与历史来源无关；
-   调用只会增加延迟而不能改变决策；
-   命令返回 `no_matches` 或不可用状态时，不得反复无休止重试。

**推荐工作流：**

1.  先读当前原则的 ID、trigger 和 action。
2.  出现具体疑惑时调用
    `pd pain recall --principle-id <id> --context "<疑惑>" --limit 3 --json`。
3.  先检查顶层状态和关联证据，再阅读 Pain 描述与诊断。
4.  区分 Owner 原始陈述与诊断解释。
5.  只在历史确实改变当前判断时使用它；历史不能覆盖当前任务的直接证据。
6.  如果结果缺失或不可读，明确承认信息不足，不编造历史。

### 8.2 技能同步要求

-   英文与中文模板语义一致。
-   三个宿主都使用同一个命令和参数。
-   WorkBuddy
    是否默认启用技能必须沿用现有产品策略，不在本任务中偷偷打开全局开关。
-   更新后运行已有 skill manifest、安装包和 CLI-command contract 测试。
-   不能只更新一个宿主后声称三宿主交付完成。

------------------------------------------------------------------------

## 9. 验收标准

### 9.1 功能

-   [ ] `pd pain recall --help` 正常。
-   [ ] `--principle-id` 缺失或非法时给出明确参数错误。
-   [ ] 使用规范原则身份解析器。
-   [ ] 能返回有明确血缘证据的 Pain。
-   [ ] `--pain-id` 只筛选当前原则的有效关联 Pain。
-   [ ] `--context` 只改变已关联结果的确定性排序。
-   [ ] 默认 `limit=3`，并拒绝非法或超范围值。
-   [ ] 多个关联路径去重但保留证据。
-   [ ] 多个原则共享候选时不发生覆盖丢失。
-   [ ] 诊断、纠错证据、原始陈述分别标识。
-   [ ] 返回缺失、空、不可读、部分可用等明确状态。

### 9.2 只读与安全

-   [ ] 缺失数据库时不会创建文件或目录。
-   [ ] 查询前后数据库字节哈希、文件大小、schema、journal mode
    保持不变（测试可在临时夹具中验证）。
-   [ ] 没有 WAL/SHM 或迁移副作用。
-   [ ] 无网络调用、无模型调用、无凭据读取。
-   [ ] 不读取完整 transcript 或工具参数作为默认检索源。
-   [ ] 不改变原则、候选、任务、诊断或治理状态。

### 9.3 技能和兼容性

-   [ ] Codex、OpenClaw、WorkBuddy 现有 `pd-cli-operator` 技能都已更新。
-   [ ] OpenClaw en/zh 版本语义一致。
-   [ ] 所有技能中引用的命令均真实存在。
-   [ ] 相关测试在 CI 可执行，不依赖本机 `.tmp` 残留或真实 workspace。

### 9.4 测试

-   [ ] 参数和 CLI 集成测试。
-   [ ] JSON schema/contract 测试。
-   [ ] 关联图测试：显式复用、候选血缘、多路径去重、多对多关联。
-   [ ] 缺失与不可读状态测试。
-   [ ] 严格只读副作用测试。
-   [ ] 三宿主技能合同测试。
-   [ ] 相关 package 测试、全仓既有门禁通过。

------------------------------------------------------------------------

## 10. 建议实施顺序

1.  核对最新主干、命令树、真实 schema 和 exports。
2.  写失败测试，固定关联语义和只读失败状态。
3.  实现共享 Recall read model/service。
4.  注册 `pd pain recall` CLI 和 JSON 输出。
5.  更新三宿主技能及合同测试。
6.  运行定向测试与仓库规定的完整门禁。
7.  自审变更范围，提交实现报告。
8.  开 PR；除非 Owner 明确授权，不擅自合并。

------------------------------------------------------------------------

## 11. 完成定义

当 CLI
可用、结果关联可解释、失败语义明确、只读合同有自动化测试、三宿主技能都能发现并正确调用命令，且
CI 通过时，MVP 即完成。

**不要求**先证明行为收益，不要求重新执行 A/C 实验，不要求 M1--M5
全量测量，也不要求建设自动上下文注入。

功能上线后可以通过用户真实使用反馈决定是否改进召回排序或增加后续能力，但这些都不属于首版阻塞条件。
