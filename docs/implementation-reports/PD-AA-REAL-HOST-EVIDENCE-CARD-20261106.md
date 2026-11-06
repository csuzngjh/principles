# 真实宿主证据链：最小验证卡与证据包结构

日期：2026-11-06（UTC）。状态：**DRAFT / NEEDS_OWNER**（真实宿主回合、安装与工具行动均未执行）。

基线：分支 `ai/PRI-1114-coverage-propagation`，修复 PR <https://github.com/csuzngjh/principles/pull/2380>。
本文件只回答“要证明什么、当前缺什么、获批后怎么跑、证据怎么读”。它不是验收通过声明。

> 语义红线：**关联成功 ≠ 原则被遵循 ≠ 行为改善。**
> 本文件中的 run 级关联永远不是请求级关联；`ordering` 恒为 `unknown`。

---

## 0. 一句话结论

**当前已安装宿主上，无法通过既有正常入口触发一次 PD 干预。** 直接原因：

1. 已安装 OpenClaw 2026.11.1 的 embedded `before_prompt_build` 仍只构造 `prompt` 与 `messages`，不传 `currentUserMessageId`；
2. `controlledAdmission` 只在 `principles-core` 实现，OpenClaw 插件 hook 没有接线，也没有既有可执行控制器；
3. 已批准的 G1 范围明确“无工具”，即使跑成一次正例也不会产生可观察的工具行动。

因此本卡 Q3 的结论是 `BLOCKED_NEEDS_OWNER`，不是“已准备好执行”。本轮已完成的是版本区分、读链核实、证据包结构、以及一次**本地无模型**的读链实跑。

---

## 1. 最小验证卡（七问）

### Q1. 实际运行的是哪个宿主、哪个安装版本、哪个插件版本？

必须分层回答，不能把仓库源码当成已安装产物：

| 层 | 产物 | 版本 / 身份 | 核实方式 |
|---|---|---|---|
| 仓库源码（本 worktree） | `@principles/principles-core` | 4.1.0 | 本地 `package.json` |
| 仓库源码（本 worktree） | `@principles/host-runtime` | 2.2.0 | 本地 `package.json` |
| 仓库源码（本 worktree） | `@principles/pd-cli` | 1.167.0 | 本地 `package.json` |
| 仓库源码（本 worktree） | `principles-disciple` | 2.6.4 | 本地 `package.json` |
| 已安装运行时 | `~/.pd/runtime/core` | 4.1.0 | 已安装 `package.json` |
| 已安装运行时 | `~/.pd/runtime/host-runtime` | 2.1.0 | 已安装 `package.json` |
| 已安装运行时 | `~/.pd/runtime/pd-cli` | 1.166.0；`pd activation --help` **不含** `link` | 已安装 `package.json` + CLI help |
| 已安装插件 | `~/.openclaw/extensions/principles-disciple` | 2.6.2；目录内**没有** `core` 符号链接 | 已安装 `package.json` + 目录检查 |
| 已安装宿主 | OpenClaw | **2026.11.1**（`%APPDATA%\npm\node_modules\openclaw`） | 已安装 `package.json` |
| 本地 OpenClaw 检出 | `D:/Code/openclaw` | 2026.9.2 @ `63fbea0c`，不是安装版 | 历史审计记录 |
| npm 已发布包 | — | **UNKNOWN**（本轮未联网核实） | 未执行 |

关键更正：`PD-AA-OPENCLAW-MESSAGE-IDENTITY-AUDIT.md` 记录的是 **2026.10.10**；当前安装已变为 **2026.11.1**。本轮只读复核该安装版的 embedded 生产者：

- `dist/attempt-system-prompt-prepare-F34qAuO4.mjs` 第 3943–3946 行：`promptEvent = { prompt: effectivePrompt, messages: promptBuildMessages }`，仍无 `currentUserMessageId`。
- `dist/agent-harness-runtime-D36YOAmh.mjs` 第 323–330 行：harness 路径**可以**提供 `currentUserMessageId`（来自显式参数或 `idempotencyKey`），但它不是本次 embedded `before_prompt_build` 的 producer。

结论：**宿主版本升级没有修复本卡依赖的 embedded 身份缺口。** 该结论只针对静态安装产物，未运行宿主。

### Q2. 是否已具备一次受控验证所需的授权原则与隔离工作区？

已有书面授权（`PD-AA-G1-CONTROLLED-ADMISSION-CARD.md`）：

- 最多一次正例 + 一次 Native 对照；
- 每次配置预检 25 秒、宿主外层 120 秒、Agent 45 秒；
- 仅 `127.0.0.1` 固定假 provider；无工具、无并发、无 fallback、无自动重试；
- 不授权生产安装、真实工作区启用、外部 provider、G2 观察；
- `challenge-openclaw-host.mjs` 的 `workspace-agents-md` 通道必须显式标注，不能冒称 prompt-hook。

授权冲突（按保守解释处理）：

- G1 卡原文写“最多两次本地假模型调用的额度尚未使用”；
- 但 `PD-AA-v0.6-IMPLEMENTATION-STATUS.md` 的“两次获准受控调用（预算已使用）”记录了两次运行（`run-_j5v1576`、`run-4yl3aqvl`）；
- `PD-AA-LOCAL-AGENT-HANDOFF.md` 第 47、49 行明确“已经用完”“此前的两次额度不能复用”。

结论：**历史两次额度视为已消耗，不再复用。** 任何新的实际 Agent 回合都按 handoff 第 49 行要求新的有界批准。

隔离工作区：本轮只有本 worktree 的 `.tmp/`（gitignored）。`~/.pd/runtime`、`~/.openclaw/extensions/principles-disciple` 归安装器所有，代理不得创建、修改或删除。

### Q3. 如何通过既有正常入口触发一次干预，并产生一条可观察的工具行动？

既有正常入口的完整链路：

```text
OpenClaw before_prompt_build
  → packages/openclaw-plugin/src/hooks/prompt.ts
  → prepareAdaptiveIntervention(...)
  → 返回边界 revalidateAdaptivePrinciple(...)
  → EventLog adaptive_delivery journal
```

触发需要同时满足：

1. 插件配置存在显式、限定工作区、未过期的一条映射 `adaptiveActivation`：
   `enabled / workspaceDir / artifactId / activationId / expiresAt / softTimeoutMs`；
2. 当前准入文本首行恰为 `[PD-AA:delivery-review:v1]`；
3. 宿主提供非空 `currentUserMessageId` 与 `sessionId`；
4. 非 agent-to-agent、非 minimal mode；
5. 目标 artifact/activation 在当次候选中唯一。

当前阻塞（三者相互独立）：

| 编号 | 阻塞 | 证据 | 影响 |
|---|---|---|---|
| B1 | embedded 不提供 `currentUserMessageId` | 已安装 2026.11.1 静态代码（第 3943–3946 行） | hook 走 Native preserved，干预不执行 |
| B2 | `controlledAdmission` 未接入 hook，且无既有控制器 | `adaptive-principle-intervention.ts` 支持该输入；`prompt.ts` 调用点未传；`scripts/` 无控制器 | 无法用已批准的受控准入替代宿主身份 |
| B3 | G1 范围“无工具” | `PD-AA-G1-CONTROLLED-ADMISSION-CARD.md` 第 11 行 | 即使干预执行，也没有可观察工具行动可关联 |

现有替代物为什么不够：

- `challenge-openclaw-host.mjs`：`systemPromptChannel: 'workspace-agents-md'`，只能证明宿主系统指令通道与运输，不能证明 PD prompt-hook 干预；
- `probe-local-transport.mjs`：只证明本地假 provider 的请求/响应/退出，不接 PD 原则；
- `runtime-v2-chain-uat.mjs`：需要真实 provider key，且不是本轮批准的本地假模型隔离方案。

结论：**Q3 = BLOCKED_NEEDS_OWNER。** 需要在“受控准入接线”与“允许一次工具行动”两者上做有界决策（见 §4 决策卡）。本轮不自行实现该接线，因为它改变身份语义，按 handoff §5 需先取得设计批准。

### Q4. 如何读取 journal、EventLog 与只读关联输出？

物理位置（工作区为 `<ws>`）：

| 来源 | 路径 | 说明 |
|---|---|---|
| journal / EventLog | `<ws>/.pd/logs/events_YYYY-MM-DD.jsonl`；回退 `<ws>/.state/logs` | 按日分文件；`type: "adaptive_delivery"` 是干预 journal，`type: "tool_call"` 是工具事件 |
| 轨迹库 | `<ws>/.state/trajectory.db` | 只读打开；`user_turns`（纠正）、`task_outcomes`（模型完成记录）、`tool_calls`（弱候选） |

读取命令（只读，不建库、不迁移）：

```powershell
pd activation link --workspace <ws> --since <ISO> --until <ISO> --json
```

约束与默认值：

- `--until` 必须不晚于当前时间；默认窗口为 `until` 前 7 天；`--since` 受保留期限制；
- `--max-invocations 1000`、`--max-date-files 9`、`--max-file-bytes 4194304`（4 MiB）、`--max-event-lines 20000`、`--max-trajectory-rows 5000`；
- stdout 只有一个 JSON 文档（`schemaVersion: "pd-aa-behavior-linkage/v1"`）；诊断走 stderr；
- 退出码：`0` 报告，`2` 参数/读取错误，`3` journal 不可读（关联是 `unknown`，不是“没有发生”）。

输出中与本证据链直接相关的字段：

| 字段 | 用途 |
|---|---|
| `request.window` | 本次读取窗口与保留期裁剪 |
| `coverage.complete` + `coverage.incompleteReasons` | 覆盖是否完整；不完整时不得把空结果读成“不存在” |
| `coverage.journal / eventLog / trajectory` | 各来源状态、读取文件数、截断、解析错误 |
| `invocations[].intervention.configIdentity` | 当时记录的 host/plugin 版本、Hook 指纹、`evidenceCoverage` |
| `invocations[].association` + `associationReasons` | `strong_run / weak / ambiguous / unknown / conflict` |
| `invocations[].evidenceLayers` | `runAssociation / requestAssociation / principleAdherence / behaviorImprovement` 四层 |
| `invocations[].facts.actions` | 工具行动、来源、强度、`ordering`（恒 `unknown`） |
| `invocations[].facts.corrections / outcomes` | 纠正与任务结果；`outcomes` 恒 `model_completion_only`，`taskSuccess` 为 `unknown` |
| `invocations[].facts.artifacts` | 工具声明路径 vs 产物确认（默认 `unknown`） |
| `invocations[].unknowns / conflicts` | 具体未知与冲突原因码 |
| `nextAction` | 可操作的下一步 |

### Q5. 哪些关联可以确认，哪些只能保持 unknown？

运行关联（`runAssociation`）可信的条件：journal 中该 `hookInvocationId` 唯一、`sessionId + runId` 一致、在该 run 内唯一匹配，且本次读取的 journal 范围完整（`journalRangeComplete=true`）。满足即可为 `strong_run`。

**运行关联可信 ≠ 行为记录完整。** 两者必须分开报告，且降级条件不同：

- **行为来源截断**（`coverage` 中的单会话行截断、总轨迹上限、日期范围裁剪，来源为 corrections / outcomes / weakCandidates）只影响 `facts` 与 `coverage.complete`，**不参与** `journalRangeComplete`；因此即使 `coverage.complete=false`，关联仍可保持 `strong_run`，此时 `coverage.incompleteReasons` 只表示行为事实是下界，不表示关联不可信。
- **journal 自身不完整或唯一性无法证明**时，关联必须降为 `unknown`：journal coverage 非 `complete`、`truncation.omitted > 0`、`outputTruncated`、`malformedJsonLines / invalidEnvelopeRecords / invalidRecords` 任一大于 0；身份缺失（`runId` 缺失或 workspace 身份不可证）；open/terminal 记录重复；`targetIdentityUnproven`；open 与 terminal 的配置身份不一致。open/terminal 在读取范围内不可见时，身份有效为 `weak`，否则为 `unknown`。
- 同一 run 内多次干预 → `ambiguous`（`run_has_multiple_invocations`）。
- open 与 terminal 分类冲突 → `conflict`（`terminal_conflicted`）。

可以确认：

- 某次干预记录的 `sessionId + runId` 与同一 `runId` 的 `tool_call` 之间的 **run 级**关联（`strong_run`）；
- 某条纠正记录引用了该 run 的 assistant turn（`run_strong`）；
- 该 run 的 `task_outcomes` 记录存在，且只能读作“模型输出完成记录”。

永远保持 `unknown`：

- 请求级关联（`requestAssociation`）：当前没有可信请求 ID，不得把 run 或随机 token 包装成请求级；
- 送达先后（`ordering`）：journal 的 open 时间是记录时间，不是送达时间；
- 原则是否被遵循（`principleAdherence`）；
- 任务是否成功（`task_outcomes` 的 `taskSuccess`）；
- 产物是否由工具实际产生（`artifacts.confirmation`）；
- 行为是否改善（`behaviorImprovement`）。

行为来源截断（corrections / outcomes / weakCandidates）与覆盖不完整只影响 `facts` 的完整性，不自动把 `runAssociation` 降级；但 journal 自身不完整、唯一性无法证明时，`runAssociation` 仍会降为 `unknown`。两者必须分开报告。

### Q6. 是否需要先发布或安装？

分两条路径：

1. **只读关联读取（推荐本轮使用）**：不需要安装。已安装 `pd-cli` 1.166.0 不含 `activation link`，但可直接用仓库构建的 1.167.0：

   ```powershell
   node packages/pd-cli/dist/index.js activation link --workspace <ws> --since <ISO> --until <ISO> --json
   ```

   该命令只读；不写生产库、不装插件。

2. **插件侧干预（本轮不执行）**：已安装插件 2.6.2，仓库源码 2.6.4。若要让已安装宿主产生真实干预，正式流程是：

   ```text
   changeset → 合并 → 发布 → 使用官方安装器更新 → 核对 ~/.pd/runtime 与插件版本
   ```

   **禁止**手工复制 `dist/` 或覆盖 `~/.pd/runtime`、`~/.openclaw/extensions/principles-disciple`（AGENTS.md §1.1）。也不得把仓库源码构建结果当作“已安装版本”来声称验证。

### Q7. 本次调用数量、费用上限、超时、失败停止条件与清理方式？

本轮实际执行：**0 次宿主调用、0 次模型调用、0 次安装、0 次生产写入。** 只做本地无模型读链实跑（§3）。

获批后建议的上限（见 §4），三个口径分开计：

| 口径 | 上限 | 分配 |
|---|---|---|
| 宿主回合数 | 2 | 1 正例（含 1 次工具）+ 1 对照（无工具） |
| HTTP 请求数 | 3 | 正例最多 2（工具结果回传需要第二次模型请求）；对照 1 |
| 工具调用次数 | 1 | 仅正例，只读工具 |

0 次付费模型调用（仅 `127.0.0.1` 假 provider）。超时：配置预检 25 秒、宿主外层 120 秒、Agent 45 秒。

停止条件：只在**本次必须确认的运行身份（`hookInvocationId` / `sessionId` / `runId`）或工具行动缺证**时停止；此外，实际请求数超出上表、journal 不可读、非预期工具错误或超时也停止。请求级关联、`ordering`、原则遵循、行为改善为 `unknown` 是本实验的设计预期，不构成停止理由。停止后不重试、不放大窗口。

清理：终止进程树、`finally` 关闭本地端点；保留 `.tmp` 原始证据；不删除共享状态；不改生产配置。

---

## 2. 证据包结构（`pd-aa-evidence-package/v1`）

目标：任何人都能在不读聊天记录的情况下，独立复核“这次干预是否与这条工具行动在 run 级发生了关联”，并看清哪些结论不能得出。

### 2.1 目录布局

```text
<evidence-root>/                    # 提交版：docs/implementation-reports/aa-evidence/<packageId>/
  manifest.json                     # 机器可读索引（见 2.2）
  notes.md                          # 人读总结：结论 / 限制 / 下一步
  link-output.json                  # pd activation link 的原始 stdout（可脱敏，不得改写）
  journal/events_YYYY-MM-DD.jsonl   # 原始字节副本，或仅 locator + sha256
  trajectory/trajectory.db          # 原始字节副本，或仅 locator + sha256
  host/                             # 宿主轮次摘要（stdout/stderr 摘录、请求摘要）
```

原始未脱敏资产放在 worktree 的 `.tmp/aa-evidence/<packageId>/`（gitignored），提交版只放摘要、哈希与已脱敏 JSON；`manifest.files[].locator` 必须指向真实存在且可读取的位置，临时资产要写明保留限制。

### 2.2 `manifest.json` 必填字段

```json
{
  "schemaVersion": "pd-aa-evidence-package/v1",
  "packageId": "<UTC>-<agent>",
  "generatedAt": "<UTC ISO>",
  "kind": "LOCAL_NO_MODEL_SAMPLE | CONTROLLED_HOST_RUN",
  "boundary": "一句话说明这份包能证明什么、不能证明什么",
  "host": {"layer": "installed|repo|published", "name": "openclaw", "version": "", "commit": null},
  "plugin": {"version": "", "path": "", "effectiveHookSetFingerprint": "", "evidenceCoverage": "complete|partial|unknown"},
  "model": {"provider": "", "model": "", "requestCount": 0, "localFakeProvider": true, "paidCalls": 0},
  "invocation": {"hookInvocationId": "", "runId": "", "sessionId": "", "artifactId": "", "activationId": "", "targetBodySha256": ""},
  "files": [{"id": "", "locator": "", "sha256": "", "bytes": 0}],
  "coverage": {"complete": false, "incompleteReasons": [], "journal": "", "eventLog": "", "trajectory": ""},
  "associations": [{"hookInvocationId": "", "association": "", "evidenceLayers": {}}],
  "supportedConclusions": [],
  "unsupportedConclusions": [],
  "cleanup": {"processReaped": true, "endpointClosed": true, "productionWrites": 0}
}
```

### 2.3 可重复读取步骤

1. 校验哈希：对 `files[]` 逐项计算 SHA-256 并与 manifest 比对；不一致即停止。
2. 用同一窗口复跑读取器：

   ```powershell
   node packages/pd-cli/dist/index.js activation link --workspace <ws> --since <start> --until <end> --json > rerun.json
   ```

3. 对比 `rerun.json` 与 `link-output.json`：除 `generatedAt` 与绝对路径外应一致。
4. 检查 `coverage.complete`、`incompleteReasons`、每个 invocation 的 `evidenceLayers`。
5. 只按 §1 Q5 允许的层级写结论；`requestAssociation / principleAdherence / behaviorImprovement` 不得升级。

### 2.4 已完成的结构落地（本地无模型样例）

本轮用真实读取器跑了一个**合成夹具**，证明包结构可读、可哈希、可复跑：

- 目录：`D:\Code\_worktrees\principles\PRI-1114-coverage-propagation\.tmp\PRI-1114-evidence-package-sample\`
- 结果：`association=strong_run`，`coverage.complete=true`，`actions=1`，`corrections=1`，`outcomes=1`；
- `evidenceLayers`：`requestAssociation / principleAdherence / behaviorImprovement` 均为 `unknown`；
- 产物：`manifest.json`（含各文件 SHA-256）、`link-output.json`（原始 JSON）、`ws/`（夹具）。

边界：夹具是合成的，**不是宿主证据、不是模型证据、不是行为证据**；它只证明读链与包结构。

---

## 3. 本轮实际执行与未执行

已执行：

- 只读核对仓库源码与安装产物版本；
- 只读复核已安装 OpenClaw 2026.11.1 的 embedded prompt producer；
- 真实 `pd activation link` 在合成夹具上的本地无模型实跑（§2.4）；
- 证据包结构与复读命令文档化。

未执行（及原因）：

| 操作 | 原因 |
|---|---|
| 真实宿主回合 | 需新的有界批准；且 Q3 的 B1/B2/B3 未解决 |
| 真实/付费模型调用 | 未批准；历史额度已耗尽 |
| 安装或更新 `~/.pd/runtime` / 插件 | 未批准；安装目录归安装器 |
| 生产工作区启用 | 未批准 |
| 工具行动验证 | G1 范围明确无工具；需单独批准 |

---

## 4. 决策卡（NEEDS_OWNER）

### 决策 1：是否批准把 `controlledAdmission` 接入一条**仅隔离环境、默认关闭**的受控入口？

| 项 | 内容 |
|---|---|
| 目的 | 在 embedded 缺 `currentUserMessageId` 时，用一次性冻结输入替代宿主身份，完成一次受控干预 |
| 环境 | 独立 config/state/workspace；仅 `127.0.0.1` 假 provider；不碰安装目录与生产配置 |
| 调用 | 0 次模型调用；0 次宿主调用即可先做单元/夹具验证 |
| 成本 | 0 |
| 代码范围 | 仅受控准入控制器 + hook 的显式开关分支；默认关闭；不新增表、不新增自动选择器 |
| 停止条件 | 输入 SHA-256 或 manifest SHA-256 不匹配、身份歧义、本次必须确认的运行身份缺证 |
| 清理 | 删除隔离目录中的临时准入文件；生产不受影响 |

### 决策 2：是否批准一次受控实验（1 正例 + 1 对照，正例含 1 次只读工具）？

| 项 | 内容 |
|---|---|
| 目的 | 证明“干预记录 → 一条可观察工具行动”的 run 级关联 |
| 环境 | 隔离 config/state/workspace；本地假 provider；最多 1 个只读工具；无并发 |
| 调用 | 宿主回合 2（1 正例 + 1 对照）；HTTP 请求最多 3；工具调用 1；付费模型 0 |
| 成本 | 0（本地假 provider） |
| 超时 | 预检 25s / 宿主外层 120s / Agent 45s |
| 停止条件 | 本次必须确认的运行身份或工具行动缺证、HTTP 请求数超出 3、非预期工具错误、超时；请求级关联/时序/行为改善为 `unknown` 属设计预期，不停止 |
| 清理 | 终止进程树、关闭端点、保留 `.tmp` 证据、不改生产 |
| 为什么需要新批准 | G1 卡明确“无工具”，且历史两次额度已用完 |

在决策 1/2 获批前，本轮不实现接线、不跑宿主、不装插件。

---

## 5. 明确不做

- 不新增自动选择器、控制台、数据库表或生产写入机制；
- 不伪造请求 ID，不把 run 级关联包装成请求级；
- 不改写冻结实验、历史样本或既有批准记录；
- 不用 `workspace-agents-md` 通道冒充 prompt-hook 干预；
- 不把合成夹具或本地假 provider 结果当作真实模型行为改善证据。
