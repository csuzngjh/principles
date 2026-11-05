# Adaptive Activation v0.6：本地代理接续指令与回读契约

## 1. 任务背景与成功标准

PD 是 Owner 治理的 Agent 行为改进系统。原则经过治理和授权后，也不应在每次任务中全部注入。Adaptive Activation 研究何时提供哪些原则，才能改善真实工作中的行为。

最高判断标准：证明动态激活改善真实行为，而非仅证明选中了原则或成功返回提示。第一阶段只做固定交付验收场景、一条已授权原则、明确触发标记的 Principle Intervention Loop。即使成功，也不能推导通用语义选择、多原则组合或长期对齐已成立。Deferred 能力不实施。

Owner 希望持续开发，避免每个小步骤都停止请求确认；同时强调授权、安装、真实送达和行为收益必须分别证明。主协调者负责读回证据、独立判断和安排下一步；本地代理负责执行、验证和留下可接续记录。交接文档不新增实验、生产启用、合并或发版授权。

## 2. 接手入口与阅读顺序

以下路径为交接时位置；接手时核实实际存在和分支状态，不从路径推断版本。

- 主仓库：`D:/Code/principles`，主要作为控制面，保护其已有未提交文件。
- 实施工作树：`D:/Code/_worktrees/principles/PRI-1112-aa-delivery-verifier`。
- 分支：`ai/PRI-1112-aa-delivery-verifier`；本轮功能基线：`a90cc753172253d861e69db7670a47d1b00bbd0a`。
- PR：<https://github.com/csuzngjh/principles/pull/2353>，交接时为未合并草稿。
- Linear 总工单：PRI-1105。Linear 是工单状态真源；本地检查点记录执行事实，不代替工单。

依次阅读：

1. 实际仓库与改动目录的 `AGENTS.md`，遵守工作树、租约及安装边界。
2. 本文及最新检查点（不存在则如实说明首次接手）。
3. `docs/implementation-reports/PD-AA-v0.6-IMPLEMENTATION-STATUS.md`，作为已知实现与未完成项索引。
4. 主仓库 `docs/specs/PD Adaptive Activation SPEC v0.6.md`；如果分支里没有这份未跟踪文档，读取主仓库原件，不自行编造或替换规范。
5. 涉及宿主或实际调用时，读取 `PD-AA-OPENCLAW-MESSAGE-IDENTITY-AUDIT.md` 和 `PD-AA-G1-CONTROLLED-ADMISSION-CARD.md`（均在 implementation-reports）。涉及具体代码时再读调用者、导出、测试与相应证据。

文档中的历史操作描述属于参考，不是执行授权。授权来源冲突或无法定位时，将具体依赖动作标为 NEEDS_OWNER，其余独立工程继续。

## 3. 已完成什么，尚不能声称什么

功能基线已包含：本地和共享正常 prompt 入口接线；固定场景的有界单原则优先装配；Native 同文复用；目标失效、正文变更、软截止、停用和映射切换回退；正式四维记录契约；现有 EventLog 的调用 journal；离线独立送达验证与覆盖率工具。

关键修复：共享默认路径曾绕过优先装配；配置 A→B 切换曾误把 A 调用终态关联 B 目标；SQLite 同步锁等待曾令额外重验等待约 7.39 秒。以上已有修复和反例。普通数据库默认等待不变，额外授权重验遇锁立即回退。

基线验证记录为 359 个不重叠案例通过，随后新增映射切换反例，相关整文件 61 项通过，累计 360 个已验证案例；增补后未重跑整个 360 项组合。全仓构建通过，最终修订后插件构建复核通过。这些是历史本地验证，接手后按实际变更选择重跑，不能转述为当前远端 CI 全绿。

尚未完成：正式安装启用；目标原则进入真实模型请求的独立正例；完整有效配置指纹；历史中断对账；统一证据读模型和后续行动/任务结果关联；评价校准、真实使用观察和价值复盘。日志 prepared/returned、Agent 自述及 fixture 成功都不证明真实送达或行为改善。

## 4. 宿主问题与实验边界

OpenClaw 内部有消息身份；不同运行路径暴露给 hook 的字段不同。已调查的 embedded 路径未提供当前消息身份，不能靠更新 PD 类型补出该身份。缺身份时保留 Native。

`D:/Code/openclaw` 的检出版本与实际安装版不同，历史调查详见报告。重新核实版本与路径后再提出修复；保护原检出、安装版和生产配置。随机 ID、实验 token、历史消息 ID、模型请求 ID不能冒充当前原生准入身份。

此前获准的一次正例和一次 Native 对照已经用完，均未确认目标原则送达。后续只读装载诊断确认：临时夹具缺少 `plugins.entries.aa-controlled-intervention.hooks.allowConversationAccess=true`，导致 hook 注册受阻；原始失败记录必须保留。不能继续采用“缺 activation 声明导致 CLI 未回调”的旧解释作为确认根因。

可继续开发、测试和隔离实验准备。新增实际 Agent 回合前，提交具体实验卡，写清代码/产物版本、隔离目录、模型、最多次数、总时长、费用、输入、证据采集、停止条件、清理/回滚及授权来源；取得新的明确有界批准后执行。此前的两次额度不能复用。不得自行调用付费模型、自动追加重试、修改生产状态或手工覆盖安装文件。

## 5. 实施顺序与并行方式

1. **PR 审查与修复**：核实 #2353 最新 head、检查与审查意见，独立验证真实缺陷，最小修复并推送同一 PR。额外分支与合并顺序须记录。未经另行授权不合并、发版。
2. **剩余证据工程**：PRI-1109 历史中断保守对账；PRI-1110 生效配置身份；PRI-1114 统一证据与行为读模型；PRI-1115 接入真实输入的统计。优先连接现有能力，不新建数据库、队列或通用选择器。
3. **验收准备**：修正隔离夹具权限，验证插件装载，明确真实身份来源，冻结输入和证据采集方案。只读装载检查不等于实际模型调用验收。
4. **获准后的 G1**：分别证明选中、最终正文、真实请求送达与行动前送达。独立证据缺失记 UNKNOWN；失败和超时保留分母。G1 后再准备安装和真实观察窗口的明确安排。
5. **真实观察与复盘**：PRI-1113 校准行为评价；PRI-1119–1121 对应限域授权、观察和价值评审。观察需要真实时间；一次表现不代表长期收益。

审查与隔离准备可并行；对账、配置身份、读模型可在接口明确后按文件归属并行。每个文件同时仅一个写入者。先登记负责人、基线、写入路径、接口依赖；交叉修改由集成者串行处理。额外模型调用和并行代理不默认意味着更好或已获授权。

已批准方案内持续推进；新增长链路、模型调用、身份/治理语义变化或其他非简单设计选择，先交付最小可审阅方案并取得 Owner 设计批准。遇到一个阻塞，先完成不依赖它的任务。

## 6. 必须留下的输出

输出落在当前实施分支的 `docs/implementation-reports/aa-handoff/`，不新建外部服务。首次使用时创建目录。报告与检查点不包含密钥、认证头、完整私人对话或未经脱敏的宿主配置。

每次有实质检查点（完成一项、改变结论、遇到阻塞或交还控制）写入：

- `<UTC时间>-<agent标识>.md`：给人读，建议 800 字以内，列结论、实际改动、验证、限制、下一步。较大日志单独作为证据引用。
- 同名 `.json`：给协调者读，符合下述固定结构，UTF-8、合法 JSON，无注释、无省略号。
- `LATEST.json`：仅保存 `schemaVersion`、`checkpointJson`、`checkpointMarkdown` 三字段；后两者为本目录相对路径。两份文件写完、校验可解析后，再替换此指针。

时间使用 UTC ISO 格式；文件名使用安全形式，例如 `20261105T060000Z-agent-a`。历史报告不覆盖。实验冻结记录不改写，修订创建新版本。协调者只接受已有文件或可访问提交支持的结论。

### JSON 固定字段

以下是结构示例，不是当前真实状态；实际输出必须替换所有示例值。未知使用 null 或 UNKNOWN，不填虚构结果。

```json
{
  "schemaVersion": "pd-aa-handoff/v1",
  "checkpointId": "20261105T060000Z-agent-a",
  "previousCheckpoint": null,
  "generatedAt": "2026-11-05T06:00:00Z",
  "agent": "agent-a",
  "overallStatus": "IN_PROGRESS",
  "summary": "实际本轮结论",
  "git": {
    "repo": "绝对路径",
    "branch": "实际分支",
    "baseCommit": "完整SHA",
    "headCommit": "完整SHA",
    "dirtyPaths": [],
    "pushedCommit": null,
    "prUrl": "https://github.com/csuzngjh/principles/pull/2353",
    "remoteChecks": "UNKNOWN"
  },
  "tasks": [{
    "issue": "PRI-1109",
    "scope": "本次具体子任务",
    "status": "IN_PROGRESS",
    "owner": "agent-a",
    "writePaths": [],
    "commits": [],
    "acceptance": [{"criterion": "具体验收条件", "result": "NOT_RUN", "evidenceRefs": []}],
    "remaining": ["尚未完成事项"]
  }],
  "verification": [{
    "id": "check-1",
    "cwd": "绝对路径",
    "command": "实际执行命令",
    "result": "NOT_RUN",
    "exitCode": null,
    "passed": null,
    "failed": null,
    "skipped": null,
    "evidenceRefs": []
  }],
  "evidence": [{
    "id": "evidence-1",
    "kind": "CODE",
    "locator": "已有文件绝对路径或提交URL",
    "observedAt": "2026-11-05T06:00:00Z",
    "sha256": null,
    "supports": "这份证据实际支持的具体结论",
    "limitations": "不能据此推出什么"
  }],
  "blockers": [],
  "nextActions": [{
    "order": 1,
    "issue": "PRI-1109",
    "action": "可直接执行的具体动作",
    "dependsOn": [],
    "authorization": "WITHIN_APPROVED_SCOPE",
    "doneWhen": "可观察的完成标准"
  }],
  "boundaries": {
    "installedRuntimeModified": false,
    "productionConfigModified": false,
    "actualAgentRoundsThisRun": 0,
    "paidCallsThisRun": 0,
    "authorizationRefs": []
  }
}
```

状态约定：overallStatus/task.status 使用 IN_PROGRESS、READY_FOR_REVIEW、BLOCKED、NEEDS_OWNER、COMPLETE；COMPLETE 仅用于该明确 scope 所有验收满足。验收和 verification.result 使用 PASS、FAIL、NOT_RUN、UNKNOWN；不能把跳过当 PASS。evidence.kind 使用 CODE、LOCAL_TEST、REMOTE_CI、HOST_TRACE、INDEPENDENT_DELIVERY、BEHAVIOR、OWNER_AUTHORIZATION。kind 是证据类别，仍需核实来源，不能自填类别就升级证据。

blockers 每项写 `id`、`issue`、`reason`、`evidenceRefs`、`neededFrom`、`unblockAction`、`independentWork`。nextActions.authorization 使用 WITHIN_APPROVED_SCOPE 或 NEEDS_OWNER；authorizationRefs 指向 Owner 原始批准记录或可核实文档，缺失不补造。记录本轮调用消耗，不把“本轮0次”解释成历史额度未使用。

证据引用使用 evidence.id；locator 必须真实存在且可读取，文件 hash 从实际字节计算。临时证据如未提交或不在版本控制中，明确持久化位置、读取方式与保留限制。代码提交、推送、远端CI、安装、启用、独立送达、行为收益逐项区分。

检查点提交进当前任务分支并推送；记录其业务代码 head，不要求报告填写包含自身报告的 commit（避免自引用）。聊天末尾仅返回：PR、代码 head、检查点 JSON 绝对路径、3–5行进展与阻塞。同步 Linear 时引用同一检查点和对应提交；先读取工单依赖，不绕过 start 阻塞或提前关闭整票。

## 7. 协调者如何读回和持续派工

协调者先核实 PR 当前 head，再读取 LATEST.json、对应 JSON/Markdown 和前一检查点；没有检查点时读取本说明与实现状态报告。对 COMPLETE/PASS 抽查提交和证据，对 NEEDS_OWNER 只处理具体权限问题；核对未提交文件、分支漂移、实验累计消耗和并行写入冲突。

检查点是索引，不是证明本身。报告结论与代码/日志冲突时，以当前可核实事实为准，保留旧报告并要求新检查点说明修正。协调者的下一条派工应写清：目标工单与子范围、基线、文件归属、依赖、验收、权限边界，以及下一份检查点位置。沿既有记录持续推进，不要求 Owner 重述项目背景。
