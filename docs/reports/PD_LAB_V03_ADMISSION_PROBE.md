# PD-Lab v0.3 T7a-Data 准入探测交付报告（Admission Probe）

| 属性 | 内容 |
| --- | --- |
| 工单 | PRI-1257 [PD-Lab v0.3][R2] 完整轨迹准入探测与独立来源分组（HANDOFF T7a 第 1–2 项） |
| 范围 | 准入探测（`admission-probe.mjs` + `npm run lab:probe`）、按研究路径准入分类、`source-groups.json` 生成与验证、补齐队列。**不含** Judge Protocol 校准（PRI-1258）、T6 试点、资格三态分级（DT-08/09 属 T7a-judge 部分，随 PRI-1258） |
| 权威依据 | SPEC §5–§6、TECH §5.2/§5.4、CONTRACT §2.4/§3、HANDOFF T7a |
| 实现基线 | `origin/main` `2e91fdfa7`（2026-11-20） |
| 交付物 | `scripts/dev/pd-lab/admission-probe.mjs`、`scripts/__tests__/pd-lab-admission-probe.test.ts`、`scripts/__tests__/fixtures/pd-lab-admission-probe-helpers.mjs`、根 `package.json` 的 `lab:probe`、本报告 |

## 1. 数据集与快照标识

本交付的验证全部使用**合成数据**（真实 schema + 合成内容）。真实冻结数据集与真实快照**未在本任务中探测**：

| 对象 | 状态 | 说明 |
| --- | --- | --- |
| 真实冻结数据集（16 条全保真样本） | NOT_PROBED | 公开脱敏副本 `experiment/prompt-v2/dataset/pain-dataset.json` 的 session 结构已复核（16 Pain / 14 唯一 session：`anon-99bb88401742848e` 承载 S01+S08、`anon-33bb9526a5cb5f81` 承载 S02+S04；14 条 `host_kind=openclaw`，2 条空），仅作事实核对，未作为探测输入 |
| 真实 T1 快照 | NOT_PROBED | 快照尚未按 D3+D6 执行（PR#2695 记录真实快照 NOT_RUN） |
| 合成验证数据 | USED | `scripts/__tests__/fixtures/pd-lab-admission-probe-helpers.mjs` 构造：`applyTrajectorySchemaBase` 真实 schema、合成数据集/快照/blob-manifest |

## 2. 探测器版本

- 入口：`npm run lab:probe` = `node scripts/dev/pd-lab/admission-probe.mjs`
- CLI：`--dataset <file> --snapshot <dir> --out <dir>`（必填，exit 2 缺参）+ 可选 `--expectations`、`--authorizations`、`--cross-session-review`、`--verify-source-groups`
- 探测器自身 SHA-256 随每次运行写入报告的 `probe.sha256`（自引用文件哈希，测试断言 64 位十六进制）
- 退出码：`0` 探测完成 · `1` 结构失败（输入不可读、库打不开、缺核心表、生成分组自验失败——**绝不输出零问题伪装成功**）· `2` 用法错误 · `3` `--verify-source-groups` 发现 INVALID_PLAN（CONTRACT §3：映射不完整阻断计分，不默认一例一组）

## 3. TECH §5.2 检查覆盖表

| TECH §5.2 检查 | 实现位置（admission-probe.mjs） | 问题代码 | 测试 |
| --- | --- | --- | --- |
| 会话在 user_turns/assistant_turns 无任何行 | `analyzeSession` gapReasons #1 | `SOURCE_GAP` | 'DT-02' 用例 |
| 保留证据区分（started_at 早于最早行 / turn_index 起始>0 / 否则 SOURCE_GAP） | `analyzeSession` retentionEvidence + CONTRACT §2.4 规则 | `SOURCE_RETENTION_EXPIRED` vs `SOURCE_GAP` | 'DT-07'、'positive retention evidence'、'turn_index starting above 0' 用例 |
| blob_ref 无对应 blob 文件 | blob 循环（manifest 无条目或文件缺失） | `TURN_BLOB_MISSING` | 'DT-03' 用例（dropBlob） |
| blob 文件存在但哈希与 Manifest 不符 | blob 循环 sha256 比对 | `DIGEST_MISMATCH` | 'DT-03' 用例（corruptManifestEntry） |
| result_preview 命中 500 字符截断形态 | SQL 谓词 `length===500 && substr(-3)='...'`（**不取正文**） | `TOOL_RESULT_PREVIEW_ONLY` | 'TOOL_RESULT_PREVIEW_ONLY' 用例（497+`...` 恰 500 形态） |
| Pain 无可定位会话/时间锚点 | main（session_id 空检测；created_at 结构校验 fail-loud） | `PAIN_ANCHOR_MISSING` | 'PAIN_ANCHOR_MISSING' 用例 |
| turn_index 不连续且无保留证据 | `analyzeSession` 洞检测 | `SOURCE_GAP` | 'message order error'、closed-set 用例 |
| 缺期望档案或期望未解决 | `analyzeExpectations`（缺档/`resolved!==true` 两分支） | `EXPECTATION_UNRESOLVED` | 'EXPECTATION_UNRESOLVED' 用例 |
| 授权引用无效或过期 | `analyzeAuthorization`（缺档/withdrawn/expired/structure_only 四分支） | `AUTHORIZATION_UNVERIFIED` | 'DT-06' 用例 |
| 库打不开沿 TrajectoryDbUnavailableError 语义直接失败 | `openTrajectoryReadonly` → exit 1 `trajectory_db_unavailable`/`trajectory_schema_unexpected` | —（结构失败，非问题代码） | 'unreadable trajectory.db'、'missing core tables' 用例 |

TECH §5.2 表之外的 CONTRACT §2.4 首批代码实现位置：

| 代码 | 触发条件 | 测试 |
| --- | --- | --- |
| `REFERENCE_UNAVAILABLE` | ① `tool_calls.params_json` 空/非法 JSON（工具调用/返回断链）② 结构化 `evidenceRefs`（`session:`/`pain:`/`blob:` 前缀）在快照内解析失败；非结构引用（如 `owner_reported:cli`）不猜测 | 'tool call/return break'、'structured evidenceRefs' 用例 |
| `FUTURE_INFORMATION` | 期望记录 `visibleAt` 晚于样本 `painEvent.created_at`（期望证据在决策时点不可见，SPEC §5.3） | 'FUTURE_INFORMATION' 用例 |
| `ENVIRONMENT_UNAVAILABLE` | T1 快照形态（两库+blob）不含环境快照 → `BEHAVIOR_BRANCH` 恒 BLOCKED（CONTRACT §2.4 已知情况） | 'ENVIRONMENT_UNAVAILABLE' 用例（每样本一条，不降级 completeness） |

**闭集 round-trip（ERR-146）**：closed-set 用例构造 5 样本世界触发全部 11 个代码，并断言 emitted 集合与 CONTRACT §2.4 首批列表完全相等——无死枚举、无未申报代码。

## 4. SOURCE_GAP 与 SOURCE_RETENTION_EXPIRED 的区分（DT-07 冻结语义）

判定 `SOURCE_RETENTION_EXPIRED` **必须**同时满足：

1. 观察到缺口（gapReasons 非空：无行 / 最早行晚于 Pain 触发 / 单侧角色缺失 / turn_index 起始>0 / 洞 / 顺序倒挂）；
2. 存在积极保留证据（`sessions.started_at` **严格早于**该会话最早存活行；或 `user_turns.turn_index` 起始>0）。

仅时间戳较晚而无证据 → `SOURCE_GAP`，impact 明确写出"两种可能（从未存在 / 被清扫但无证据）"，且注明 Pain 之前只有少量轮次不是缺陷。零行会话即使 `sessions` 行存在也一律 `SOURCE_GAP`（TECH §5.2 证据条件要求"最早行"存在，无行时不推断）。保留清扫日志作为第三类证据**未实现**（无权威日志源），边界在此披露。

## 5. 按研究路径的准入分类（CONTRACT §2.4 三路径）

| 路径 | BLOCKED 条件（实现于 `classifySample`） |
| --- | --- |
| `PIPELINE_REPLAY` | `PAIN_ANCHOR_MISSING`/`SOURCE_GAP`/`SOURCE_RETENTION_EXPIRED`/`TURN_BLOB_MISSING`/`DIGEST_MISMATCH`/`AUTHORIZATION_UNVERIFIED`/`REFERENCE_UNAVAILABLE`。`TOOL_RESULT_PREVIEW_ONLY` **不阻塞**（生产入口读同样的预览）但必须记录 |
| `EXPECTATION_LABELING` | 上述全部 + `EXPECTATION_UNRESOLVED` + `FUTURE_INFORMATION` + 条件性 `TOOL_RESULT_PREVIEW_ONLY`（仅当期望档案声明 `dependsOnToolOutput`） |
| `BEHAVIOR_BRANCH` | 上述全部 + `ENVIRONMENT_UNAVAILABLE`（历史快照恒有） |

- `NOT_EVALUATED`（不是 READY）：① `host_kind` 为非空非 openclaw（第一版仅覆盖 OpenClaw 轨迹库，TECH §5.2）；② 数据集为脱敏公开副本（`«redacted sha256:… len:N»` 形态检测 → 结构审计照跑、路径资格不判，DT-06 分离语义）。
- `executableForDeclaredPath[p]` = 该路径 `READY`（SPEC §5.2 能力标签分离：completeness 独立报告证据完整性，期望缺失的样本可以 INCOMPLETE 而同时可执行管道重放——诊断重放不需要期望）。
- 统计分别输出每路径 `READY/BLOCKED/NOT_EVALUATED` 计数 + `painCount`/`caseCount`/`sessionCount`/组数（禁止 Pain 条数冒充样本数，测试钉定 16 Pain → 14 组）。

## 6. Source Groups（CONTRACT §3）

生成规则（`buildSourceGroups`）：

- `caseId = experimentPainId`（数据集样本主键）；映射**必须**覆盖每个样本；
- 机械规则：同一 `session_id` 的所有 Pain 同组（`sg-<sha256('session:'+sid)[:12]>`）；无 session 锚点的 case 获独立单例组并在 rationale 显式注明（不静默默认一例一组）；
- 跨会话合并**仅**经 `--cross-session-review`（每条 `{sessionIds≥2, basis, approvedBy}` 皆非空，引用的 session 必须存在于数据集，否则结构失败 exit 1）；合并组 rationale 记录依据与批准人；
- `digest = sha256(canonicalJson({groups, rationales}))`——与 T4 消费方 `alignment-report.mjs` 的 `sourceGroupsDigest` 规范化**同一算法**（probe 不 import 其非导出内部函数，重复实现并以测试钉定生成→verify 的 digest 重算稳定）；
- 每组必有非空 rationale。

验证规则（`validateSourceGroups`，生成后自验 + `--verify-source-groups` 模式同函数）→ INVALID_PLAN（exit 3）：`CASE_UNMAPPED`（缺映射，含 SC-19 语义：不默认一例一组）、`UNKNOWN_CASE`、`SESSION_SPLIT_ACROSS_GROUPS`、`CROSS_SESSION_MERGE_WITHOUT_BASIS`、`GROUP_WITHOUT_RATIONALE`、`SOURCE_GROUPS_DIGEST_MISMATCH`、`SOURCE_GROUPS_DIGEST_MISSING`、结构/schema 错。

16 条合成复算（同真实 session 结构）：16 Pain → 14 组（S01/S08 同会话、S02/S04 同会话），测试断言 `painCount=16, sessionCount=14, independentSourceGroupCount=14, groups 键数=16`。DT-04：同源 10 变体 → 恰 1 组；同 session 拆两组 → INVALID_PLAN。

## 7. 补齐队列（Stage D）

`--out/remediation-queue.json`（`pd-lab-remediation-queue.v1`）：每个问题一条 `{caseId, problemCode, missingEvidenceType, affectedPaths, nextAction, authorizationStatus, remediable, requiresOwnerDecision}`。要点：

- 不完整样本**不删除**，保留全部原因；
- `SOURCE_RETENTION_EXPIRED` / `PAIN_ANCHOR_MISSING` / `ENVIRONMENT_UNAVAILABLE` 标记 `remediable=false`（本快照内不可恢复：行已删/锚点不存在/历史环境不可重建）；
- `EXPECTATION_UNRESOLVED` / `AUTHORIZATION_UNVERIFIED` / `FUTURE_INFORMATION` 标记 `requiresOwnerDecision=true`（需 Owner 建档/授权/裁定）；
- 授权撤回（withdrawn）在队列与报告 `authorizationStatus` 中**单独记录**，不并入泛化 unverified；
- 缺失证据永不自动变成完整证据；不改变原始数据集身份或历史 digest（探测只读，输出全部为派生物）。

## 8. 合成验证结果

`npm run test:scripts -- pd-lab-admission-probe`：**41/41 PASS**（真实 CLI 子进程 × 真实 schema 合成库 × 参数绑定 SQL）。分组：

| 分组 | 用例数 | 覆盖 |
| --- | --- | --- |
| 数据完整性（TECH §5.2 全行） | 16 | 健康正控、DT-02、角色错误、顺序错误、工具断链、preview-only 三态、DT-03、锚点缺失、期望缺档/未解决、DT-06 ×3、FUTURE_INFORMATION、DT-05、ENVIRONMENT、evidenceRefs ×3 类、脱敏副本、非 openclaw 宿主 |
| 保留期判定 | 5 | 正常无问题、DT-07（SOURCE_GAP 不误判）、started_at 证据、turn_index 起始>0 证据、不可补齐标记 |
| 来源分组 | 8 | 同 session 同组、DT-04 十变体一组、16→14 复算、有据合并、无据合并 INVALID_PLAN、缺映射 INVALID_PLAN（SC-19）、同 session 拆组 INVALID_PLAN、rationale 缺失 INVALID_PLAN + 自生成文件 verify 通过 |
| 路径分类与计数 | 2 | 路径独立性（replay READY ≠ labeling READY）、每路径分别计数 |
| 安全与 CLI 契约 | 9 | 源文件 hash+mtime 前后不变、报告零正文标记、无网络/模型面（负向能力断言）、exit 2 用法、库不可读 exit 1 不出零问题、缺核心表 exit 1、write-once、非法期望/授权文件 exit 1、stdout 单行 JSON + 探测器 digest + NOT_RUN_WITHOUT_D6 |
| 闭集 round-trip | 1 | 11 代码全触发且无额外代码（ERR-146） |

## 9. 真实数据探测：NOT_RUN

**未执行**对真实冻结数据集与真实快照的探测。原因：

1. **D6 未批准**——全保真数据授权及使用边界（HANDOFF §2 D6）未给出；无 D6 时本工具不得访问生产 DB、复制真实 Blob、读取全保真轨迹。
2. **真实快照不存在**——T1 真实快照执行需 D3+D6（PR#2695 已记录真实快照 NOT_RUN）。
3. 公开脱敏副本不具运行资格（SPEC §6.3）；本探测器对脱敏副本的行为是显式 `NOT_EVALUATED`（结构审计模式），不冒充全保真判定。

授权状态：D2（实时模型裁判）不需要、未使用（零模型调用）；D5（Owner 盲评）不需要、未执行。PRI-1258 处理 D2/D5 与 Judge Protocol 校准。

## 10. 未解决问题与下一步

| 项 | 状态 | 归属 |
| --- | --- | --- |
| 真实 16 条样本的实际准入统计 | 待 D6+D3 后对真实快照执行 `lab:probe` | Owner 决策 D6 → T7a 真实探测 |
| 期望档案与授权档案的真实数据源 | 合成输入格式已定（`expectations`/`authorizations` JSON，CONTRACT §2.3 语义）；真实档案不存在 → 真实探测将如实输出全样本 `EXPECTATION_UNRESOLVED`/`AUTHORIZATION_UNVERIFIED` | Owner 建档（T7b 数据治理） |
| 保留清扫日志作为第三类保留证据 | 未实现（无权威日志源） | 随 T7b 扩充评估 |
| `SOURCE_GROUPS_DIGEST` 与 T4 的跨模块字节对账 | probe 用相同 canonicalization 语义独立实现（TECH §3.2 钉死 alignment-report.mjs 导出面，不能 import 其内部函数）；自生成→verify 稳定已有测试 | 如 Owner 要求跨模块同一 digest 数值对账用例，属 PRI-1258 接线时补 |
| 资格三态（BLOCKED/EXPLORATORY_ONLY/CONFIRMATORY_READY，DT-08/09） | 不在本任务范围 | PRI-1258 |

## 11. Complexity Delta

```text
New durable source of truth: NO   （admission-report/source-groups/remediation-queue 均为可复算派生物）
New persisted schema/state:  NO   （只读探测；输出 JSON 均在 --out，不入库、不建服务）
New subsystem/service/background process: NO
New public abstraction/interface: NO  （一个 CLI + 既有 lab:* 别名模式）
New runtime feature flag: NO
New cross-package dependency: NO （scripts/dev 工具，仅依赖既有 better-sqlite3；不进产品闭包，lab-payload-closure 负控）
New host/platform-specific behavior: NO
New external/network capability: NO （零网络、零模型；测试负向断言）
```

回滚：revert 三个新文件 + `package.json` 一行；无生产副作用、无已产生运行需要处理（本任务全部运行均为合成测试产物，位于测试临时目录）。
