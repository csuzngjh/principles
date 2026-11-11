# 技术设计：统一宿主轨迹摄取（PRI-1171 实施蓝图）

| 项 | 值 |
|---|---|
| 编号 | TD-UNIFIED-HOST-TRAJECTORY-INGESTION-001 |
| 版本 | v0.2（三路独立评审修订版：代码事实/生产数据/对抗架构） |
| 状态 | 配套 SPEC-001 v0.2（PR #2516）；SPEC 批准后本设计即为实施依据 |
| 日期 | 2026-11-11 |
| 范围声明 | 本文行使 SPEC 授予的技术决断权。与 SPEC 冲突时以 SPEC（Owner 意图）为准 |

## 修订记录

| 版本 | 变更 |
|---|---|
| v0.1 | 首稿 |
| v0.2 | 评审修订：① seam 收窄——宿主解码器**留在各自适配器包**（workbuddy-adapter / openclaw-plugin），host-runtime 只保留宿主中立最小集（评审 P1：原布局违背 AGENTS §8.2）；② 删除零消费方的 `LiveObservationMapper`（投机缝）；③ 文本截断改造点更正为 core `evidence-sanitizer.ts`（原 §4.4 写错了位置：现状 visible_text 上限来自 `sanitizeString` 的 200+15 截断后缀，非 store 的 `MAX_TEXT_BOUND`）；④ WorkBuddy 压缩标记**不**传 `compactionTimestamp`（该参数在 store 是主动墓碑，会清有效证据 body）；⑤ Codex full 层须新版披露+新版同意（不复用旧 bounded 同意）；⑥ checkpoint upsert 增 MAX 单调保护；⑦ OpenClaw 兜底源降级为待证据附录；⑧ 双层 flag 门控显式化；⑨ Stop 字段名/encodeCwd 规则/timeout/依赖类型等事实性修正；⑩ 测试矩阵补齐（incomplete-tail 继承、consent 撤销处置、conflict 路径、pd-hook 集成锁定） |

---

## §0 文档定位

SPEC v0.2 回答"做什么、为什么、边界在哪"；本文回答"怎么建"：模块布局、接口签名、DDL 细节、解码器字段映射、触发模型、测试矩阵、工单拆解。实施工程师（AI）应能仅凭 SPEC+本文开工，无需重新推导决策。

## §1 勘察结论（实施资产盘点，2026-11-11 源码级+生产数据双核查）

| 资产 | 现状（核查修正后） | 复用方式 |
|---|---|---|
| `host-runtime/governance-observation-store.ts` | API 齐备：`ingestGovernanceObservations`、`readGovernanceCheckpoint`、`listGovernanceCheckpoints`（小写 l）、promotion、retention 常量（32 轮/7 天/12 前导/尾滞 7 天）；`GovernanceObservationInput.hostKind` 为 `'codex'` 字面量；schema 版本=3 | 升格统一观察存储（§4） |
| **visible_text 截断真相** | 上限来自 core `evidence-sanitizer.ts` 的 `sanitizeString`（`MAX_EVIDENCE_VALUE_CHARS=200` + 15 字符 `___TRUNCATED___` 后缀 = 最长 **215**）；store 的 `MAX_TEXT_BOUND=200` 只截身份字段 | full 层改造点在 sanitizer（§4.4） |
| `codex-adapter/ingestion/transcript-decoder.ts` | `TranscriptPort` 注入式接口；`decodeTranscriptWindow` 按 byte-offset 源序增量解码；批界 `1MB/256`；**现状显式丢弃 reasoning**（decoder :282）——P3 增录需同时改 decoder 与 store kind 两处 | Port 与解码骨架入 seam（§2） |
| checkpoint 真相 | 唯一写入点=Stop 转录增量路径的 store 事务（upsert，**无 MAX 单调保护**）；live 路径（UserPromptSubmit/PostToolUse）**从不写 checkpoint**——生产 Codex 库 checkpoint 表 0 行与 8748 行 live 观察并存即此因。Stop 路径另有三类常态降级不落库：CLI 版本高于验证上限（`unverified_above`）、verified-outcome 写失败、logical_key 冲突 | §4.5 加 MAX 保护；§9 健康面为 live-only 会话定义显式状态 |
| `host-runtime/codex-ingestion-consent.ts` | 台账 schema **v2**（字符串）；decision: pending/granted/revoked/failed；decidedVia 枚举**无** owner_directive；含 `disclosureVersion` 语义（同意绑定披露版本）；文件在 `<workspace>/.pd/codex-ingestion-consent.json` | 泛化 v3（§8.1） |
| feature-flag 机制 | `codex_conversation_ingestion`：quiet、enabled:false；quiet 默认开有充分先例（signal_collector PRI-797、openclaw_diagnostician_consumer 等）；**硬约束**：quiet flag 必须有 lifecycle 条目且 consumers 指向真实存在的文件（census 测试强制） | §8.2 |
| **flag 层叠事实** | Codex catch-up 是双层门：`host.codex`（core 默认开）先于 `codex_conversation_ingestion`；**`host.workbuddy` 现为 quiet enabled:false（默认关）**——本机工作区已显式开启 | §8.2 门控层级 |
| openclaw-plugin 依赖 | `@principles/host-runtime ^3.3.0` 在 **devDependencies**（esbuild 构建期打包，10 个 src 文件真实 import）——"零新增运行时依赖"结论成立，表述按此理解 | §7.1 |
| WorkBuddy 插件 hooks.json | 注册 5 事件：PreToolUse/PostToolUse/PostToolUseFailure（30s）、UserPromptSubmit（**15s**）、SessionStart（30s）；**无 Stop**；`plugin/scripts/wrapper.cjs` 存在 | §8.3 |
| Codex 触发模型 | pd-hook `turn_complete`（Stop）触发摄取，flag 检查先于任何转录 I/O；worker 周期 `catchUpCodexIngestion` 内部重查双层 flag | §8.3 双触发泛化 |
| WorkBuddy 转录存储 | `~/.workbuddy/projects/`：jsonl **219 个/约 477MB**（此前 566MB 为含非转录文件的全目录口径）；六+1 记录类型；callId 配对实测 100% | §5 |
| OpenClaw 宿主转录 | `openclaw-agent.sqlite`（857MB 活库）：`transcript_events` 68,485 行——**37% 行 event_json 为 NULL、正文在 event_zstd BLOB（zstd 压缩，两列互斥）**；assistant content 为分块数组、user 为字符串；`session_transcript_active_events` 仅位置索引无正文 | §7.2 附录（兜底源已降级） |

## §2 模块布局（评审修订：seam 收窄，解码器归各宿主包）

```
host-runtime/src/conversation-ingestion/          ← 宿主中立最小集（seam 全部内容）
  index.ts        # seam 公开面（host-runtime barrel 再导出）
  source.ts       # TranscriptSourceAdapter 契约 + TranscriptPort + 批界常量（自 codex-adapter 平移）
  pipeline.ts     # 统一五段管线编排（locate→decode→validate→consent→ingest）
  consent.ts      # 同意台账 v3（hostKind 维度；Codex v2 兼容读迁移）
  text-policy.ts  # 同意分层文本上限策略

宿主解码器（各归各包，新宿主接入零 host-runtime 改动）：
  codex-adapter/src/ingestion/         ← 保留宿主专有（rollout 解析/路径规则/版本守卫/live 入口）
  workbuddy-adapter/src/ingestion/     ← 新增：projects jsonl 解码器（§5）
  openclaw-plugin/src/core/…           ← P3 live 旁路构造观察（§7.1；兜底源若重启则解码器也在此包）
```

理由（评审 P1 采纳）：AGENTS §8.2"宿主特定集成归宿主适配器"；原布局使每新增宿主必改 host-runtime（版本联动+changeset 膨胀），seam 退化为"知道所有宿主的中心"——没有消除"每宿主一套方案"，只是搬进一个包。收窄后**新宿主接入=在自己包内写解码器+实现契约**，公共包零改动。

P1 平移清单（修订）：`TranscriptPort`/批界/`incomplete-tail` 语义/增量解码骨架 → seam `source.ts`；Codex 专有（rollout 记录解析、`transcript-locate`、`codex-home`、`codex-version`、`ingestion-fields`、`admission`、`turn-context`、`explicit-owner-statement`）**全部留在 codex-adapter**；`codex-ingestion-consent.ts` 泛化迁移为 seam `consent.ts`（原路径保留 re-export 一个版本周期）。

## §3 核心接口（签名级；已删除投机缝）

```ts
// source.ts
export type SeamHostKind = 'codex' | 'workbuddy' | 'openclaw';

export interface SessionRef { sessionId: string; cwd?: string }
/** hook 载荷线索。注意字段名按通道区分：UserPromptSubmit/SessionStart/SessionEnd 为
 *  transcript_path；Stop 为 agent_transcript_path（能力矩阵 Table A 原文）。 */
export interface HookHints { transcriptPath?: string; agentTranscriptPath?: string; generationId?: string }

export type TranscriptLocator =
  | { status: 'ok'; filePath: string; expectedIdentity: TranscriptExpectedIdentity }
  | { status: 'degraded'; reason: string; nextAction: string };

export interface TranscriptSourceAdapter {
  readonly hostKind: SeamHostKind;
  /** 确定性定位：hints 优先，其次按宿主规则推导。禁止目录扫描猜 latest */
  locate(session: SessionRef, hints: HookHints, env: { home?: string }): TranscriptLocator;
  /** 增量窗口解码：纯函数，FS 经 TranscriptPort 注入（flag-off 零读证明依赖此设计）。
   *  必须继承 incomplete-tail 语义：无尾换行的半行不推进 checkpoint（与 Codex decoder 一致，
   *  防钩子触发时读到宿主正在写的半行）。 */
  decode(port: TranscriptPort, locator: TranscriptLocator & { status: 'ok' },
         checkpoint: GovernanceCheckpointRecord | null): DecodedDelta;
}

// text-policy.ts —— 同意分层（full 层须 disclosureVersion 达标，见 §8.1）
export type TextPolicy =
  | { tier: 'bounded'; maxChars: 200 }        // 未达新版同意（默认；=现状语义）
  | { tier: 'full'; maxChars: 20_000 };       // 新版披露+新版同意后（硬顶防畸形行；截断率随 P3 验收实测披露）
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

（v0.1 的 `LiveObservationMapper` 已删除：pipeline 签名不接收、OpenClaw 旁路直接构造观察、Codex live 映射留 adapter——零消费方的投机缝，出现第二个真实消费者再提炼。）

管线五段：`locate → decode → validate(rc-1..9) → sanitize → consent 门 → ingestGovernanceObservations`。每段降级带 `reason/nextAction`（rc-9）。

## §4 存储 v4（additive）

1. `governance_observation_schema_version`：3 → 4，`ensureGovernanceSchema` 版本判断幂等（缺表建表、旧表不重写）；
2. `host_kind` 扩 `codex | workbuddy | openclaw`（应用层枚举校验，DDL 不加窄 CHECK；存量 NULL=unknown 不变）；
3. `kind` 增 `reasoning`：改 store 联合类型 **并同步删除 codex decoder 的显式丢弃分支**（:282）——两处必须同 PR；
4. `visible_text` 全文化改造点（**评审更正**）：现状截断在 core `evidence-sanitizer.ts` 的 `sanitizeString`（200 + `___TRUNCATED___` 15 字符后缀）。v4 方案：`sanitizeString` 增可选 `maxChars` 参数（默认 200 保持现状语义），seam 按 `resolveTextPolicy` 传值；**full 层截断后缀语义**：超长仍加 `___TRUNCATED___` 标记（保证可辨识截断）。core 是公共包——此改动列入 changeset 矩阵（§11）；
5. `governance_rollouts.rollout_identity` 语义通用化=宿主会话持久单元（Codex rollout id / WorkBuddy sessionId / OpenClaw sessionId），不加列、头注文档化；
6. **checkpoint 单调保护（评审新增）**：upsert 改 `byte_offset = MAX(byte_offset, excluded.byte_offset)`（`last_ordinal` 同理）——防 Stop 与 worker catch-up 并发时后提交者把水位拉回（重复解码/健康页抖动）；
7. **fork 处理不新增 store 输入**（评审修订）：v0.1"fork 后旧轮标 partial"依赖 store 不存在的参数——改为 degradation 警告（`wb_fork_notice`），旧行保留不动；
8. reasoning 行映射：`visible_text`=脱敏后 content；`assistant_item_id`=同 `parentId` 链配对的 assistant record id（配对失败→`completeness='partial'`+`phase='unattributed'`，不猜）。

## §5 WorkBuddy 源适配器（P2 核心；解码器在 workbuddy-adapter 包内）

### 5.1 路径解析（确定性，两级）

1. 优先 hook 载荷：UserPromptSubmit/SessionStart/SessionEnd 取 `transcript_path`，Stop 取 **`agent_transcript_path`**（矩阵 Table A 原文；`InstructionsLoaded` 的 transcript_path 为空串须跳过——取证 §6.2）；
2. 兜底推导：`<home>/.workbuddy/projects/<encodeCwd(cwd)>/<sessionId>.jsonl`。`encodeCwd` 规则以**取证实测样本为准**（`D:\Code\principles` → `d-Code-principles`）：盘符小写，路径分隔符与 `:` 折叠为**单个** `-`（不产出双横线）；实现时以取证样本 fixtures 锁定，不照抄文字规则。**不做目录枚举、不猜 latest**。

### 5.2 记录类型映射表

| jsonl `type` | observation `kind` | 字段映射 |
|---|---|---|
| `message` role=user | `user_turn` | `content`→`visible_text`；`timestamp`→`observed_at`；`messageId`→`host_turn_id` |
| `message` role=assistant | `assistant_turn` | 同上；`providerData.model`→`sanitized_tool_facts_json.model` |
| `reasoning` | `reasoning` | `content`（缺失用 `rawContent`）→`visible_text`；归属配对见 §4.8 |
| `function_call` | `tool_call` | `name`→身份、`arguments`→`sanitized_tool_facts_json.params`；`callId`→`tool_use_id` |
| `function_call_result` | `tool_call`（结果侧） | `output`→result preview（经 `sanitizeValue`）；按 `callId` 回填配对 |
| `file-history-snapshot` / `ai-title` | 不入库 | 跳过（计数入 degradations.warnings，非静默） |
| `resend-fork-notice` | 分支标记 | degradation 警告 `wb_fork_notice`（§4.7：不改旧行） |
| 未知 type | 不入库 | 显式降级 `wb_unknown_record_type`（rc-9），不崩 |

### 5.3 身份与配对

- **logical key**：`wb|<sessionId>|<record.id>`；
- **transcript_record_key**：`wb|<sessionId>|<byteOffset>`（append-only 字节序=源序，继承 Codex"插入序≠转录序"教训）；
- **工具配对**：`callId`（取证实测 100%）；结果先到/孤悬→`completeness='partial'`。

### 5.4 特殊语义（评审修订）

- **压缩**（`providerData.isCompacted` 等）：**不传 `compactionTimestamp`**——该参数在 store 是主动墓碑（清 `observed_at<=ts` 全部 unpromoted 行 body 置 rolled_back），而 WorkBuddy jsonl 历史行在压缩后仍完整在盘（取证 §8.2），传入会**删除仍然有效的证据**。P2 仅记 degradation 警告 `wb_compaction_marker`；语义定论（SPEC §11）后再设计；
- **fork**：degradation 警告（§4.7），不删不回滚；
- **incomplete-tail**：显式继承 Codex 语义（§3 decode 契约）——无尾换行的半行不推进 checkpoint；
- **子代理**（`<sessionId>/subagents/agent-*.jsonl`）：P2 不采，P3 跟进；
- **变体基线**：取证 §8.1 变体清单冻结为 fixtures，宽容解析，新变体→显式降级+契约测试红。

### 5.5 边界

批 ≤1MB/≤256 条；单会话文件 >50MB → 分批+健康页滞后告警；解码纯函数（TranscriptPort 注入）。

## §6 Codex 平移（P1）与升级（P3）

- **P1 平移零行为变化**：中立骨架入 seam、宿主专有留 adapter。**锁定手段（评审补强）**：①三表逐字段快照对比（fixtures 含 conflict/incomplete-tail/TOCTOU/降级路径用例，非仅 happy path——生产 checkpoint 表为 0 行，快照对它是平凡通过，必须用合成 Stop payload 走真实管线生成 checkpoint 再锁定）；②pd-hook 集成层测试：真实 Stop payload fixture 端到端（live 入口+admission candidates+verified outcomes 等价性）；③错误分类跨包移动后 `catch` 分支仍匹配（`TranscriptReplacedError` 等）。
- **P3 升级**：full 层生效条件=**新版披露文本+同意台账新版记录**（§8.1；旧 granted 针对 bounded 披露授予，不自动覆盖全文+reasoning——Owner 对 SPEC v0.2 的批准构成新版同意决定，P3 落台账 decidedVia=owner_directive）；reasoning 增录=store kind 扩展+decoder 删丢弃分支两处同 PR（§4.3）。

## §7 OpenClaw 接入

### 7.1 live 统一观察写入（P3）

openclaw-plugin 钩子路径在现有基表写入**旁路**直调 seam 构造 `GovernanceObservationInput[]`（hostKind='openclaw', source='live_hook'）：

- logical key：`oc|<sessionId>|<runId|turnIndex>`；
- **独立开关** `openclaw_unified_observation`（quiet，默认 on，依据=Owner 统一指示；lifecycle consumers 指向真实文件）——新增写入面必须有独立禁用手段（评审 P1 采纳）；
- **消费权威规则**：诊断/证据消费面以统一观察存储为准；基表与观察表不一致（旁路 best-effort 失败）时以观察表为准+有界诊断；
- `user_turns`/`assistant_turns` 基表写入原样保留（治理权威：轮次计数/纠错锚点）；
- 旁路失败绝不影响钩子主路径（best-effort+rc-9，同 evidence recorder 模式）。

### 7.2 离线兜底源（**已降级：待证据附录，默认裁剪**）

重启前提：①量化钩子停机窗口频率（插件升级/禁用间隙）；②实证 live `runId|turnIndex` 与 `transcript_events` 事件 ID 的桥（**评审证实现无已验证桥**——无桥则收敛承诺不成立，只能做"显式声明的独立补录"且容忍不去重）。若重启，技术要点：

- 快照改用 better-sqlite3 `db.backup()` 或 `VACUUM INTO`（三文件复制非原子、readonly 连接无法做 WAL 恢复——评审证伪"复制 db+wal+shm"方案）；
- 解码必须带 `event_json IS NULL → event_zstd`（zstd 解压）分支——**37% 行正文在压缩列**（生产实测 25,419/68,485），只探列名会静默丢事件；assistant content 为分块数组、user 为字符串，需分型处理；`session_transcript_active_events` 仅位置索引；
- zstd 解压依赖落 openclaw-plugin（不进 host-runtime/core）。

## §8 同意、开关与触发

### 8.1 同意台账 v3

- **权威文件**：`<workspace>/.state/conversation-ingestion-consent.json`（按 hostKind 分键）。**迁移**：P1 读到旧 `.pd/codex-ingestion-consent.json`（v2）→迁移写入 v3→旧文件改名为 `.superseded` 后缀（不删除，保审计）；health/管线**只读 v3**（唯一权威，防双文件并存歧义——评审 P2 采纳）；
- 记录含 `disclosureVersion`；**full 层生效判定 = decision=granted 且 disclosureVersion ≥ 当前披露版本**（Codex 旧 granted 停留 bounded 直到新版记录）；
- decidedVia 枚举扩展 `owner_directive`；WorkBuddy granted 记录 `decidedVia: 'owner_directive'`、`evidenceRef: 'PRI-1171 SPEC 修订记录 2026-11-11'`；
- **撤销处置**：revoke→停增量（管线 consent 门拒绝）；已入库数据**不删除**，按既有 retention 自然过期（默认保全，符合 DATA_CLEANUP_GUIDELINES；如需立即清 body 属破坏性操作须另立 Owner 决定）。

### 8.2 特性开关（双层门控显式化——评审 P2 采纳）

```
摄取生效 = host.<kind>（宿主总开关） AND <kind>_conversation_ingestion（采集开关） AND consent=granted
```

- Codex 现状即此结构（catch-up.ts:80-84 双层门）；WorkBuddy 同构：`host.workbuddy`（quiet 默认 off；**本机工作区已显式 enabled**）∧ `workbuddy_conversation_ingestion`（quiet **默认 on**，依据=Owner 2026-11-11 指示；lifecycle 仿 signal_collector 先例，consumers 指向真实文件路径——census 测试强制）；
- **"默认开通"语义澄清**：宿主总开关默认关的工作区，采集随总开关关（与 Codex 相同的既有语义）；本 Owner 工作区两者皆开→P2 落地即生效；
- `host.workbuddy` flag description（"no transcript reads"）随 P2 同步修订（SPEC §8 已列）；
- flag-off=零转录读取：pipeline 入口短路在 `locate` 之前（port spy 测试，WorkBuddy/Codex 同标准）。

### 8.3 触发模型（双触发，三宿主一致）

| 触发 | 时机 | 说明 |
|---|---|---|
| 回合摄取 | Stop/turn_complete 钩子 | WorkBuddy hooks.json 新增 Stop wrapper 行（timeout 30s=矩阵建议值；stop_hook_active 契约防循环） |
| 周期补读 | worker catch-up | `catchUpCodexIngestion` 泛化 `catchUpConversationIngestion(hostKind)`；注意 workbuddy-adapter **已有自己的** workspace-worker.ts（与 codex-adapter 同名并存）——泛化落 seam、两个 worker 各自调用 |

并发：Stop×worker 由 checkpoint MAX 单调保护（§4.6）+logical key 幂等兜底。

## §9 健康可观察性

- **形态统一（评审修正）**：扩展现有 `pd health` 为内嵌三宿主采集段（不新增独立命令，与 SPEC §6"扩展现有 health-codex 模式"一致）；cli-1（--json 纯净）/cli-6（降级带 nextAction）/cli-7（真实注册测试）合规；
- 每宿主输出：`{ hostFlag, ingestionFlag, consent, lastSuccessAt, checkpointOffset, lagBytes, lastDegradation }`；
- **live-only 会话状态（评审新增）**：live 路径不写 checkpoint（§1 真相）——健康面对无 checkpoint 的会话以 `MAX(observed_at)` 报 `lastObservedAt` 并标注 `live_only`（显式状态，不显示为滞后异常）；
- Console 状态页消费同一接口（只读状态，非轨迹浏览——G6）。

## §10 测试矩阵（评审补强）

| 层 | 测试 | 关键断言 |
|---|---|---|
| 解码器（WorkBuddy） | 变体基线 fixtures 契约测试 | §5.2 映射逐字段；可选字段缺失→降级不崩；未知 type→显式降级 |
| 隐私不变量 | flag-off port spy | WorkBuddy/Codex 同标准：flag-off 全程 port 零调用 |
| **半行竞态** | jsonl 无尾换行写入中读取 | incomplete-tail 语义：半行不入库、checkpoint 不推进（显式继承，非默认） |
| 收敛 | live×transcript 重放 | 同 logical key 恰一行；重放幂等 |
| **checkpoint 并发** | 旧水位交错提交 | MAX 保护：水位不回退；重复解码由幂等吸收 |
| 迁移 | schema v3→v4 | 幂等；存量行逐字段不变；hostKind/kind 新值可写读；checkpoint upsert 单调 |
| **P1 行为锁定（补强）** | 合成 Stop payload 走真实管线 | 含 conflict/incomplete-tail/TOCTOU/降级路径 fixtures；三表快照含 checkpoint（生产 0 行→必须合成）；pd-hook 集成层等价（live 入口/admission candidates/verified outcomes）；错误分类跨包后 catch 仍匹配 |
| 保留 | 窗口执行 | 7 天/32 轮→expired；promoted 豁免；quarantine 不误伤 |
| reasoning 配对 | 孤悬/parentId 缺失 | partial+unattributed，不猜归属 |
| **consent 生命周期** | 旧 granted+新版披露 | 停留 bounded；新版记录后才 full；revoke→停增量+存量自然过期（不删除） |
| CLI | pd health 采集段 | 真实 commander 注册测试；live_only 状态显式 |
| BDD | Owner 旅程 | 开通后健康页三宿主齐、WorkBuddy 数据流可见 |

## §11 实施拆解（含 changeset 矩阵——评审补全）

**P1（提取，行为零变化）**
1. seam 最小集（source/pipeline/consent v3/text-policy）+Codex 中立骨架平移+行为锁定（快照+pd-hook 集成）；
2. consent v2→v3 迁移（.pd→.state 单一权威+旧文件 superseded）；
3. checkpoint MAX 单调保护（store，schema v4 一起）。

**P2（WorkBuddy 开通）**
4. workbuddy-adapter 内解码器+变体 fixtures+incomplete-tail；
5. hooks.json 增 Stop+worker catch-up 泛化（workbuddy-adapter worker 调 seam）；
6. flag `workbuddy_conversation_ingestion`（quiet 默认 on）+`host.workbuddy` description 修订+同意记录；
7. `pd health` 采集段+Console 状态页。

**P3（深度对齐）**
8. core `sanitizeString` maxChars 参数+store kind/reasoning+codex decoder 删丢弃分支+新版披露文本+同意新版记录（Owner 已批 SPEC 即决定）→Codex full+reasoning 生效；
9. OpenClaw live 旁路（`openclaw_unified_observation` flag+消费权威规则）。

（OpenClaw 离线兜底源=待证据跟进，不在本拆解内。）

**changeset 矩阵**：

| 工单 | changeset |
|---|---|
| 1 | host-runtime minor |
| 2 | host-runtime minor（与 1 同批） |
| 3 | host-runtime patch |
| 4/5 | workbuddy-adapter minor、host-runtime patch（若 seam 契约微调） |
| 6 | **principles-core minor**（flag SSoT：contract+lifecycle 两文件）、pd-cli patch（若披露命令） |
| 7 | pd-cli minor、pd-console patch（状态页） |
| 8 | **principles-core minor**（sanitizer）、host-runtime minor、codex-adapter minor |
| 9 | openclaw-plugin minor、host-runtime patch（若契约微调） |

依赖顺序：1→2→3→(4,5,6,7)；8 依赖 3；9 依赖 1。每项独立 PR-able、独立回退；数据面 additive 无需回滚迁移。

## §12 常量与边界

| 常量 | 值 | 来源 |
|---|---|---|
| 批字节/条数 | 1MB / 256 | 复用 CODEX_INGESTION_MAX_BATCH_* |
| bounded 文本上限 | 200+15 后缀（=现状 215 实测上界） | core evidence-sanitizer 现状 |
| full 文本硬顶 | 20,000（截断率随 P3 验收实测向 Owner 披露） | 新增 |
| `sanitized_tool_facts_json` 上限 | 8,000（现状 MAX_JSON_COLUMN，full 层同界） | 既有 |
| 保留窗口 | 32 可见轮 / 7 天 | 现状常量，三宿主一致 |
| WorkBuddy 单会话告警阈 | 50MB | 新增 |
| Stop 钩子 timeout | 30s | 矩阵建议值（新增注册，非"既有规格"——评审修正） |

## §13 技术风险增补（v0.2）

| 风险 | 对策 |
|---|---|
| 三宿主转录格式均非契约接口 | 宽容解析+变体基线契约测试+显式降级（rc-9） |
| 双存储（观察×治理）P4 张力 | 权威分层声明+消费权威规则（§7.1：不一致以观察表为准） |
| 旧同意被静默扩大范围（评审 P1） | disclosureVersion 门：full 须新版披露+新版记录（§8.1） |
| compaction 墓碑误删有效证据（评审 P1） | WorkBuddy 不传 compactionTimestamp；语义定论前仅警告（§5.4） |
| checkpoint 并发回退 | MAX 单调 upsert（§4.6） |
| live-only 会话无水位 | 健康面显式 `live_only` 状态（§9） |
| 入库体积未量化 | P2 验收实测 WorkBuddy 日均入库量，补基线后评估（SPEC §9） |
| 发布顺序（host-runtime 导出面变更+多包联动） | changeset 矩阵（§11）+安装器原子升级依赖既有 installer 契约，P1 验收含安装态冒烟 |
| WorkBuddy jsonl 高敏感 reasoning/工具输出 | 同意台账 hostKind 粒度+既有脱敏/匿名化管道+导出面按高敏感字段 |

---

## 附：与 SPEC v0.2 的条款对应

SPEC §4.1 seam=本文 §2/§3；§4.2 存储 v4=本文 §4；§4.4 各宿主=本文 §5/§6/§7；§6 健康=本文 §9；§7 迁移矩阵=本文 §11；§8 修订声明=本文 §8.1/§8.2；§9 风险=本文 §13。

