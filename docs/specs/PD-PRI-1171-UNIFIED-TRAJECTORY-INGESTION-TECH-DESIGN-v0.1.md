# 技术设计：统一宿主轨迹摄取（PRI-1171 实施蓝图）

| 项 | 值 |
|---|---|
| 编号 | TD-UNIFIED-HOST-TRAJECTORY-INGESTION-001 |
| 版本 | v0.1 |
| 状态 | 配套 SPEC-001 v0.1（PR #2516）；SPEC 批准后本设计即为实施依据 |
| 日期 | 2026-11-11 |
| 范围声明 | 本文行使 SPEC 授予的技术决断权。与 SPEC 冲突时以 SPEC（Owner 意图）为准 |

---

## §0 文档定位

SPEC v0.1 回答"做什么、为什么、边界在哪"；本文回答"怎么建"：模块布局、接口签名、DDL 细节、解码器字段映射、触发模型、测试矩阵、工单拆解。实施工程师（AI）应能仅凭 SPEC+本文开工，无需重新推导决策。

## §1 勘察结论（实施资产盘点，2026-11-11 源码级）

| 资产 | 现状 | 复用方式 |
|---|---|---|
| `host-runtime/governance-observation-store.ts` | API 齐备：`ingestGovernanceObservations`（rollout 谱系+观察+checkpoint+degradations+rollback 标记）、`readGovernanceCheckpoint`/`ListGovernanceCheckpoints`、promotion、retention 常量（32 轮/7 天/12 前导/尾滞 7 天）；`GovernanceObservationInput.hostKind` 为 `'codex'` 字面量；`MAX_TEXT_BOUND=200` 常量硬编码 | 升格为统一观察存储：hostKind 扩枚举、kind 增 reasoning、文本上限策略化（§4） |
| `codex-adapter/ingestion/transcript-decoder.ts` | `TranscriptPort` 已是注入式抽象（FS 解耦）；`decodeTranscriptWindow` 增量解码；批界常量 `MAX_BATCH_BYTES=1MB`/`MAX_BATCH_RECORDS=256` | Port 与解码骨架平移入 seam；Codex 专有记录解析留 adapter（§6） |
| `host-runtime/codex-ingestion-consent.ts` | consent 台账 schema v2（decision: pending/granted/revoked/failed；decidedVia；按工作区单文件） | 泛化为 hostKind 维度 v3（§8.1） |
| feature-flag 生命周期 | `codex_conversation_ingestion` KEEP_QUIET，graduation 含"explicit Owner default-on decision" | WorkBuddy 新 flag 以 Owner 2026-11-11 指示为 default-on 依据（§8.2） |
| `openclaw-plugin/package.json` | **已依赖** `@principles/host-runtime` ^3.3.0 | OpenClaw live 观察写入零新增跨包依赖（§7.1） |
| WorkBuddy 插件 `hooks/hooks.json` | wrapper 命令模式（PreToolUse/PostToolUse/PostToolUseFailure/UserPromptSubmit/…，`timeout` 30s）；payload 各通道带 `transcript_path` | 新增 Stop 注册=一行 manifest+wrapper 分支（§8.3） |
| Codex 触发模型 | pd-hook `turn_complete`（Stop）回合摄取 + `workspace-worker` 周期 `catchUpCodexIngestion`（内部重查 flag） | 该双触发模型泛化为 seam 标准运行方式（§8.3） |

## §2 模块布局

```
host-runtime/src/conversation-ingestion/
  index.ts                    # seam 公开面（host-runtime barrel 再导出，包内公开）
  source.ts                   # TranscriptSourceAdapter / LiveSourceAdapter 契约
  pipeline.ts                 # 统一五段管线编排（locate→decode→validate→consent→ingest）
  consent.ts                  # 同意台账 v3（hostKind 维度，Codex v2 兼容读）
  text-policy.ts              # 同意分层文本上限策略
  adapters/
    codex-rollout.ts          # 自 codex-adapter/ingestion 平移：定位+路径校验+版本守卫
    workbuddy-projects.ts     # 新增：~/.workbuddy/projects jsonl 解码器（§5）
    openclaw-agent-sqlite.ts  # 新增（P3）：openclaw-agent.sqlite WAL 安全快照读（§7.2）
```

职责迁移表（P1 执行）：

| 现位置 | 去向 | 理由 |
|---|---|---|
| `transcript-decoder.ts` 的 `TranscriptPort`/批界/解码骨架 | `seam/source.ts`+`pipeline.ts` | 宿主中立 |
| `transcript-locate.ts`/`transcript-path.ts`（rollout 路径规则） | `adapters/codex-rollout.ts` | Codex 专有 |
| `codex-home.ts`/`codex-version.ts` | 留 `codex-adapter/ingestion/` | Codex 专有 |
| `ingestion-fields.ts`/`admission.ts`/`turn-context.ts`/`explicit-owner-statement.ts` | 留 `codex-adapter` | 治理信号语义，非采集 |
| `codex-ingestion-consent.ts` | 泛化迁移为 `seam/consent.ts`（原模块保留 re-export 兼容一个版本） | 三宿主共用 |
| `governance-observation-store.ts` | 原地升格（v4），不移动 | 存储 SSoT 不动位置 |

## §3 核心接口（签名级）

```ts
// source.ts
export type SeamHostKind = 'codex' | 'workbuddy' | 'openclaw';

export interface SessionRef { sessionId: string; cwd?: string }
/** hook 载荷线索（如 UserPromptSubmit/Stop 的 transcript_path）——确定性定位优先来源 */
export interface HookHints { transcriptPath?: string; agentTranscriptPath?: string; generationId?: string }

export type TranscriptLocator =
  | { status: 'ok'; filePath: string; expectedIdentity: TranscriptExpectedIdentity }
  | { status: 'degraded'; reason: string; nextAction: string };

export interface TranscriptSourceAdapter {
  readonly hostKind: SeamHostKind;
  /** 确定性定位：hints.transcriptPath 优先，其次按宿主规则推导。禁止目录扫描猜 latest */
  locate(session: SessionRef, hints: HookHints, env: { home?: string }): TranscriptLocator;
  /** 增量窗口解码：纯函数，FS 经 TranscriptPort 注入（测试可 spy，flag-off 零读证明依赖此设计） */
  decode(port: TranscriptPort, locator: TranscriptLocator & { status: 'ok' },
         checkpoint: GovernanceCheckpointRecord | null): DecodedDelta;
}

/** live 钩子观察映射（可选实现；OpenClaw 主用，Codex 现状保留，WorkBuddy P2 不接） */
export interface LiveObservationMapper {
  readonly hostKind: SeamHostKind;
  toObservations(hookEvent: unknown): readonly GovernanceObservationInput[];
}

// text-policy.ts —— 同意分层
export type TextPolicy =
  | { tier: 'bounded'; maxChars: 200 }        // 未同意全文（默认）
  | { tier: 'full'; maxChars: 20_000 };       // 已同意全文（硬顶防畸形长行，仍过脱敏管道）
export function resolveTextPolicy(consent: ConsentState): TextPolicy;

// pipeline.ts —— 唯一编排入口
export interface RunIngestionArgs {
  workspaceDir: string;
  source: TranscriptSourceAdapter;
  session: SessionRef; hints: HookHints;
  flags: { ingestionEnabled: boolean };        // flag-off ⇒ 零 port 调用（隐私不变量）
  consent: ConsentState;
}
export function runConversationIngestion(args: RunIngestionArgs): IngestGovernanceObservationsResult | PipelineDegradation;
```

管线五段：`locate → decode → validate(rc-1..9) → sanitize(既有 sanitizeString/sanitizeValue) → consent 门 → ingestGovernanceObservations(收敛+checkpoint+retention)`。每段降级均带 `reason/nextAction`（rc-9）。

## §4 存储 v4（additive）

1. `governance_observation_schema_version`：3 → 4，迁移幂等（`ensureGovernanceSchema` 版本判断，缺表建表、旧表不重写）；
2. `host_kind` 取值扩为 `codex | workbuddy | openclaw`（应用层枚举校验为主，DDL 不加窄 CHECK——与现状一致，存量 NULL=unknown 语义不变）；
3. `kind` 增 `reasoning`（`GovernanceObservationKind` 联合类型扩展；kind 无 DDL 约束，纯应用层）；
4. `visible_text` 写入由 `boundedString(text, MAX_TEXT_BOUND)` 改为 `boundedString(text, resolveTextPolicy(consent).maxChars)`——**存量行不动**，v4 只影响新写入；
5. `governance_rollouts.rollout_identity` 语义通用化=宿主会话持久单元：Codex rollout id / WorkBuddy sessionId / OpenClaw sessionId（不加列，语义文档化于 store 头注）；
6. reasoning 行的字段映射：`visible_text`=脱敏后 reasoning content；`sanitized_tool_facts_json` 不用；`assistant_item_id`=同轮 assistant message 的 record id（配对规则见 §5.3）。

## §5 WorkBuddy 源适配器（P2 核心）

### 5.1 路径解析（确定性，两级）

1. 优先 hook 载荷 `transcript_path`（UserPromptSubmit/SessionStart/SessionEnd/Stop 各通道均带；`InstructionsLoaded` 为空串须跳过——取证 §6.2）；
2. 兜底推导：`<home>/.workbuddy/projects/<encodeCwd(cwd)>/<sessionId>.jsonl`，`encodeCwd`：盘符小写、路径分隔符与 `:` 一律转 `-`（如 `D:\Code\principles` → `d-Code-principles`，与取证 §2.1 一致）。**不做目录枚举、不猜 latest**（SPEC §4.6 延续）。

### 5.2 记录类型映射表

| jsonl `type` | observation `kind` | 字段映射 |
|---|---|---|
| `message` role=user | `user_turn` | `content`→`visible_text`；`timestamp`→`observed_at`；`messageId`→`host_turn_id` |
| `message` role=assistant | `assistant_turn` | 同上；`providerData.model`→`sanitized_tool_facts_json.model` |
| `reasoning` | `reasoning` | `content`（缺失用 `rawContent`）→`visible_text`；归属配对见 5.3 |
| `function_call` | `tool_call` | `name`→身份、`arguments`→`sanitized_tool_facts_json.params`；`callId`→`tool_use_id` |
| `function_call_result` | `tool_call`（结果侧） | `output`→result preview（经 `sanitizeValue`）；按 `callId` 回填配对 |
| `file-history-snapshot` | 不入库 | 跳过（计数入 degradations.warnings，非静默） |
| `ai-title` | 不入库 | 同上 |
| `resend-fork-notice` | 分支标记 | 触发 5.4 fork 处理 |
| 未知 type | 不入库 | 显式降级 `wb_unknown_record_type`（rc-9），不崩 |

### 5.3 身份与配对

- **logical key**：`wb|<sessionId>|<record.id>`（收敛主键：live 工具观察 × 转录重放去重）；
- **transcript_record_key**：`wb|<sessionId>|<byteOffset>`（append-only 字节序=源序，同 Codex `source_order` 语义：插入序≠转录序的 P1 教训直接继承）；
- **reasoning 归属**：向前就近配对同 `parentId` 链上下一条 assistant `message`（`parentId` 缺失时→`completeness='partial'`+`phase='unattributed'`，不猜）；
- **工具配对**：`callId`（取证实测 100% 配对）；结果先到/孤悬→`completeness='partial'`。

### 5.4 特殊语义

- **压缩**（`providerData.isCompacted`）→ 传入 `compactionTimestamp`（复用既有参数）；
- **fork**（`resend-fork-notice`）：fork 点之后旧行不动，新分支行正常写；受影响旧轮标 `completeness='partial'`（fork 后旧分支语义=被编辑历史，保守不删不回滚）；
- **子代理**（`<sessionId>/subagents/agent-*.jsonl`）：P2 **不采**（主会话优先），列 P3 跟进项；
- **变体基线**：取证 §8.1 变体清单冻结为 fixtures（`message` 5 变体/`function_call` 3/`reasoning` 2 + `logicalParentId` 止于 08-24 + `ai-title` 08-11 新增），宽容解析：可选字段缺失降级，新变体→显式降级+契约测试红。

### 5.5 边界

批 ≤1MB/≤256 条（复用 Codex 常量）；单会话文件 >50MB → 分批降速+健康页滞后告警；解码纯函数化（TranscriptPort 注入）。

## §6 Codex 平移（P1）与升级（P3）

- **P1 平移零行为变化**：`TranscriptPort`/解码骨架/批界入 seam；Codex 专有（rollout 记录解析、路径规则、版本守卫 `classifyCodexVersion`）留 adapter 调 seam。**锁定手段**：迁移前后对同一 fixtures 跑 `ingestGovernanceObservations`，`governance_observations`/`governance_transcript_checkpoints`/`governance_rollouts` 逐字段快照对比测试（生产 8748 行不动本身即验收）。
- **P3 升级**：`resolveTextPolicy(consent='granted')`→`full`（20k 硬顶）；rollout 的 reasoning 项→`reasoning` kind（字段映射同 §5.2 规则）；retention/quarantine 机制不动。

## §7 OpenClaw 接入

### 7.1 live 观察写入（P3）

openclaw-plugin 钩子路径（llm.ts/prompt.ts/after-tool-call）在现有 `recordAssistantTurn/recordUserTurn` **旁路**增调 seam（直调 host-runtime，零新依赖）：

- logical key：`oc|<sessionId>|<runId|turnIndex>`；写 `governance_observations`（hostKind='openclaw', source='live_hook'）；
- `user_turns`/`assistant_turns` 基表写入**原样保留**（治理权威，P4 分层声明落 SPEC §4.2）；
- 旁路失败绝不影响钩子主路径（best-effort+rc-9 有界诊断，同 evidence recorder 模式）。

### 7.2 离线兜底源（P3，Owner 可裁剪）

- 快照读：连 `-wal`/`-shm` 一起复制到 `.state/` 临时目录→只读打开（既有运维惯例，防热库锁）；
- 读取面：`transcript_events`（+`session_transcript_active_events` 对齐）；**列探测防御**：所需列缺任一→显式降级 `oc_agent_schema_drift`（宿主内部 schema 无契约，rc-9 不猜）；
- logical key：`oc|<sessionId>|<eventId>`，与 live 行收敛。

## §8 同意、开关与触发

### 8.1 同意台账 v3

`{workspace}/.state/conversation-ingestion-consent.json`（按 hostKind 分键；Codex v2 文件读取兼容迁移，写回 v3）：

```json
{ "schemaVersion": "3", "hosts": { "workbuddy": { "decision": "granted", "decidedVia": "owner_directive_20261111", "decidedAt": "...", "evidenceRef": "PRI-1171 SPEC 修订记录" } } }
```

### 8.2 特性开关

- `workbuddy_conversation_ingestion`：category quiet，**enabled: true**（evidence=Owner 2026-11-11 指示 + "重要功能默认开启"既有产品决策；graduation/retirement 条款仿 `codex_conversation_ingestion` 改写）；lifecycle 元数据按 §16 规范补齐；
- **flag-off = 零转录读取**：pipeline 入口短路在 `locate` 之前（port spy 测试证明，同 Codex 隐私不变量标准）；
- Codex 沿用既有 flag；OpenClaw 兜底源独立 flag（P3 定义，默认 off）。

### 8.3 触发模型（三宿主统一为 Codex 已验证的双触发）

| 触发 | 时机 | 说明 |
|---|---|---|
| 回合摄取 | Stop/turn_complete 钩子 | WorkBuddy hooks.json 新增 Stop wrapper 行（`timeout` 30s，非阻断语义按官方 stop_hook_active 契约） |
| 周期补读 | workspace-worker catch-up | `catchUpCodexIngestion` 泛化 `catchUpConversationIngestion(hostKind)`，内部重查 flag+consent |

## §9 健康可观察性

- `pd-cli`：新命令 `pd health ingestion`（输出 JSON+人读两态）：每宿主 `{ flag, consent, lastSuccessAt, checkpointOffset, lagBytes, lastDegradation }`；数据源=`readGovernanceCheckpoint`/`ListGovernanceCheckpoints`+consent 台账（无新存储）；
- Console 状态页：消费同一 CLI/接口（只读状态视图，非轨迹浏览——G6 边界）；
- cli-1/cli-6 合规：`--json` 纯净输出、降级带 nextAction。

## §10 测试矩阵

| 层 | 测试 | 关键断言 |
|---|---|---|
| 解码器（WorkBuddy） | 变体基线 fixtures 契约测试 | §5.2 映射逐字段；可选字段缺失→降级不崩；未知 type→显式降级 |
| 隐私不变量 | flag-off port spy | WorkBuddy/Codex 同标准：flag-off 全程 port 零调用 |
| 收敛 | live×transcript 重放 | 同 logical key 恰一行；重放幂等 |
| 迁移 | schema v3→v4 | 幂等；存量行逐字段不变；hostKind/kind 新值可写可读 |
| P1 行为锁定 | 平移前后快照对比 | 三表逐字段一致（§6） |
| 保留 | 窗口执行 | 7 天/32 轮→expired；promoted 豁免；quarantine 不误伤 |
| reason 配对 | 孤悬/parentId 缺失 | partial+unattributed，不猜归属 |
| OpenClaw 兜底 | 列探测 | 缺列→`oc_agent_schema_drift` 显式降级 |
| BDD | Owner 旅程 | 开通后健康页三宿主齐、WorkBuddy 数据流可见 |
| CLI | `pd health ingestion` | 真实 commander 注册测试（cli-7） |

## §11 实施拆解（工单粒度，每项独立 PR-able）

**P1（提取，行为零变化）**
1. seam 模块族+§3 接口+text-policy/consent v3（纯新增，无接线）；
2. Codex 平移入 seam+行为锁定快照测试；
3. changesets：host-runtime minor（openclaw-plugin/codex-adapter/workbuddy-adapter 联动 pin）。

**P2（WorkBuddy 开通）**
4. workbuddy-projects 解码器+变体 fixtures；
5. hooks.json 增 Stop + wrapper 分支 + worker catch-up 泛化；
6. flag 定义（默认 on）+同意记录写入（owner_directive_20261111）；
7. `pd health ingestion`+Console 状态页。

**P3（深度对齐+兜底）**
8. Codex full+reasoning（consent 已 granted 即生效）；
9. OpenClaw live 旁路观察写入；
10. openclaw-agent-sqlite 兜底源（列探测降级）+子代理采集（§5.4 跟进）。

依赖顺序：1→2→(4..7 依赖 1)；8 依赖 2；9/10 相对独立。回退面：每项 revert 独立；数据面 additive，无需回滚迁移。

## §12 常量与边界

| 常量 | 值 | 来源 |
|---|---|---|
| 批字节/条数 | 1MB / 256 | 复用 CODEX_INGESTION_MAX_BATCH_* |
| bounded 文本上限 | 200 | 现状 MAX_TEXT_BOUND |
| full 文本硬顶 | 20,000 | 新增（防畸形行；仍全量过脱敏） |
| 保留窗口 | 32 可见轮 / 7 天 | 现状常量，三宿主一致 |
| WorkBuddy 单会话告警阈 | 50MB | 新增：超限分批+健康页滞后告警 |
| Stop 钩子 timeout | 30s | hooks.json 既有规格 |

## §13 技术风险增补（SPEC §9 之外）

| 风险 | 对策 |
|---|---|
| openclaw-agent.sqlite 无契约 schema | 列探测+显式降级（§7.2）；P3 独立 flag 默认 off |
| WorkBuddy fork/压缩语义未定论 | 保守：fork→partial、压缩→compactionTimestamp 标记，不做推断性回滚 |
| reasoning 高敏感面扩大 | 同意台账粒度到 hostKind；full 层级仅 granted 生效；导出面按高敏感字段（SPEC §5 延续） |
| 双触发并发（Stop×worker） | checkpoint 单写者（既有 store 事务收敛）；重放幂等兜底 |

---

## 附：与 SPEC v0.1 的条款对应

SPEC §4.1 seam=本文 §2/§3；§4.2 存储 v4=本文 §4；§4.4 各宿主=本文 §5/§6/§7；§6 健康=本文 §9；§7 迁移矩阵=本文 §11；§9 风险=本文 §13 增补。
