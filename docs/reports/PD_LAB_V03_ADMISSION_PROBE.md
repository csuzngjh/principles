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

`npm run test:scripts -- pd-lab-admission-probe`：**52/52 PASS**（真实 CLI 子进程 × 真实 schema 合成库 × 参数绑定 SQL）。分组：

| 分组 | 用例数 | 覆盖 |
| --- | --- | --- |
| 数据完整性（TECH §5.2 全行） | 16 | 健康正控、DT-02、角色错误、顺序错误、工具断链、preview-only 三态、DT-03、锚点缺失、期望缺档/未解决、DT-06 ×3、FUTURE_INFORMATION、DT-05、ENVIRONMENT、evidenceRefs ×3 类、脱敏副本、非 openclaw 宿主 |
| 保留期判定 | 5 | 正常无问题、DT-07（SOURCE_GAP 不误判）、started_at 证据、turn_index 起始>0 证据、不可补齐标记 |
| 来源分组 | 8 | 同 session 同组、DT-04 十变体一组、16→14 复算、有据合并、无据合并 INVALID_PLAN、缺映射 INVALID_PLAN（SC-19）、同 session 拆组 INVALID_PLAN、rationale 缺失 INVALID_PLAN + 自生成文件 verify 通过 |
| 路径分类与计数 | 2 | 路径独立性（replay READY ≠ labeling READY）、每路径分别计数 |
| 安全与 CLI 契约 | 9 | 源文件 hash+mtime 前后不变、报告零正文标记、无网络/模型面（负向能力断言）、exit 2 用法、库不可读 exit 1 不出零问题、缺核心表 exit 1、write-once、非法期望/授权文件 exit 1、stdout 单行 JSON + 探测器 digest + NOT_RUN_WITHOUT_D6 |
| 评审加固（CodeRabbit r1，17 项全修） | 11 | turn_index 洞专属用例、`npm run lab:probe` 别名端到端、--out 之外零新增文件（无 WAL 旁文件）、存在但不可读的库（SQLITE_NOTADB）→ trajectory_db_unavailable、授权缺 scope 结构拒绝、LATER_CLARIFICATION 无 visibleAt → FUTURE_INFORMATION、时区偏移按时刻比较、manifest 重复 ref（Map.has）、blob ref 路径分隔符拒绝、重叠 merge 集拒绝、datasetSha256 绑定校验 |
| 闭集 round-trip | 1 | 11 代码全触发且无额外代码（ERR-146） |

评审修复中的行为收紧（相对首轮实现，全部来自有效评审发现）：授权档案 `scope` 必填（缺省不再是 full_fidelity）；`LATER_CLARIFICATION` 期望无 `visibleAt` 时按不可证明同时可见处理（FUTURE_INFORMATION）；全部 ISO 时间比较改为时刻数值比较（时区偏移下字符串序错误）；`blob:` evidenceRef 解析要求文件实际存在；manifest `ref` 必须为纯文件名（无路径分隔符）；重叠 merge 集结构拒绝；verify 模式校验 `datasetSha256` 数据集绑定；`--out` 独占创建（原子 mkdir）；SQLite 懒打开的非库文件在首次查询时以 `trajectory_db_unavailable` 结构化失败（不再裸栈）。

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

## 11. r2 最终整改（P1×3 + P2×4，2026-11-20）

第二轮独立评审的 7 项发现全部修复；测试由 52 增至 **91**（39 条新增真实 CLI 子进程负控）。

| 项 | 根因 | 修复 | 新增测试 |
| --- | --- | --- | --- |
| P1-1 Pain 锚点 | 只验 session_id 非空，未验证冻结 Pain 对应真实 `pain_events` 行；健康 fixture 数据库行与样本不一致 | `painEvent.id` 必填正整数（缺失/非法 → 结构拒绝）；`validatePainAnchor` 按 ID 查库：行不存在 / session 不一致 / `created_at` 时刻不一致（非字符串序，时区偏移安全）→ 各自独立的 `PAIN_ANCHOR_MISSING` impact；fixture 按样本自动插入真实对应行 | 6（缺失行 / session 不一致 / 时刻不一致 / 时区等价时刻通过 / ID 非法 / ID 缺失） |
| P1-2 授权完整性 | 只验 status+scope，无用途/有效期/撤回的完整验证 | 按 CONTRACT §2.1（范围/用途/有效期/撤回）扩展：`purpose` 必须匹配 `--study-purpose`（默认 `pd-lab-admission-probe`）、`effectiveAt`/`expiresAt` 必填且须覆盖评估时刻（时刻比较）、`withdrawn` 短路（其他字段无论为何均不通过）；type 错误仍结构拒绝、缺字段逐案 `AUTHORIZATION_UNVERIFIED` 不静默授予；报告记录 `authorizationEvaluatedAt` | 9（缺用途 / 缺生效 / 缺失效 / 未生效 / 已过期 / 已撤回短路唯一问题 / 用途不匹配 / scope 限制+status 分离 / 自定义 --study-purpose 匹配） |
| P1-3 Blob 路径越界 | 字符串检查+existsSync 不能阻止符号链接指向快照外 | `readBlobFileSafely`：ref 纯文件名 → lstat（ENOENT/symlink/非普通文件分类拒绝）→ 双侧 realpath + 目录边界（win32 大小写不敏感）→ `O_NOFOLLOW` 打开（POSIX）→ fstat 重验 dev/ino 身份（TOCTOU）→ 经 fd 哈希；失败按 reason 分类为 TURN_BLOB_MISSING / REFERENCE_UNAVAILABLE，绝不读取被拒路径 | 6（正常 / 外部链接拒读且外部文件 sha+mtime 不变 / 内部链接同拒 / 悬空链接 / 目录目标 / manifest ref 分隔符结构拒绝） |
| P2-1 datasetSha256 | 仅"存在且不匹配才拒"，缺失可绕过 | 强制绑定：缺失/null/空串 → `DATASET_SHA256_MISSING`；非 64-hex → `DATASET_SHA256_FORMAT`；不匹配 → `DATASET_SHA256_MISMATCH`；全部 INVALID_PLAN（exit 3）；digest 规范化语义不变、`{groups, rationales}` 结构不变 | 6（缺失 / null / 空串 / 非法格式 / 不匹配 / 正确绑定通过） |
| P2-2 evidenceRefs | `.filter(typeof==='string')` 静默丢弃非法元素 | 区分缺失与非法（rc-3/rc-4）：null 字段 / 非数组 / 任何 null、数字、对象、空串元素 → 结构拒绝 `dataset_invalid_structure` 并指名下标；非法元素绝不在解析中消失 | 8（正常通过 / null 元素 / 数字 / 对象 / 空串 / 字段 null / 字段非数组 / 字段缺失） |
| P2-3 blob evidenceRef 摘要 | evidenceRef 只查 manifest+文件存在，未独立验证内容 | `blob:` 引用走同一安全读取路径并实际计算 SHA-256 与 manifest 比对：不一致 → `DIGEST_MISMATCH`（该引用不算已解析）；复用 `blobHashCache`（outcome 缓存）避免重复读取 | 2（仅 evidenceRef 引用 + 内容篡改 → 命中 / 内容完好 → 干净解析） |
| P2-4 WAL 只读 | fixture 用 DELETE journal，未证明生产 WAL 库的只读保证 | 采用 Pain Recall read model 的同一契约（pain-recall-read-model.ts 先例）：100 字节头分类 → WAL 库经"指纹验证 staged snapshot"读取（T0 指纹 → 复制 main+活跃 -wal 到私有临时目录 → 副本校验 → T1 main→wal→main 三点复检）→ 只读打开副本 → 用后删除；rollback journal 保持直开；头不可读 fail-closed；报告记录 `readPlan`/`stagedRead` | 2（A 静默 WAL：WAL 头+无 sidecar → staged 读取、快照目录文件集+sha+mtime 逐项不变、staging 清理；B 活跃 WAL：autocheckpoint 关闭的写连接提交未 checkpoint 数据 → probe 正确读到、db/-wal/-shm sha+mtime 全不变、零新增文件、staging 清理） |

**跨模块契约保护**：CONTRACT §2.4 问题代码闭集与 §2.1/§3 语义未变（新增全部是既有代码的子情形）；TECH §5.1 快照结构与只读要求遵守方式升级为 staged 模式（与生产 read model 同契约）；T4 消费端（build-decision-input.mjs / alignment-report.mjs）零改动，source-groups 的 `{groups, rationales}` 形状、digest 计算语义不变（新增 datasetSha256 字段为 §3"映射随数据集发布"的绑定实现）；ERR-146 闭集 round-trip、ERR-178 正负控、健康/隔离正负控全部保持。

**已知平台边界**：符号链接用例使用 junction（Windows 免特权创建、POSIX 等价普通 symlink）；`O_NOFOLLOW` 分支在 POSIX 生效，Windows 由 lstat+realpath 边界检查承担同一保证。

## 12. r2 第二轮评审（9 项，2026-11-20）

第二轮独立评审 9 项发现全部核实并处理（其中 R820/R856 与本轮 P1-2/P2-3 重复，评审基于 r1 HEAD `af72a456b`——已在 r2 修复并有回归锚定用例）。测试由 52 → **102**。

| 发现 | 核实结论 | 修复 | 测试 |
| --- | --- | --- | --- |
| R820 授权仅 status+scope 即放行 | 属实（评审对象为 r1 HEAD）；r2 P1-2 已修复：purpose/effectiveAt/expiresAt 缺一即 AUTHORIZATION_UNVERIFIED 阻断 | 已由 P1-2 覆盖 | P1-2 套件 + 回归锚定用例（bare grant 不放行） |
| R600 turn_index 起点>0 误判保留期删除 | **属实且严重**：生产 `nextUserTurnIndex`（openclaw-plugin/src/hooks/prompt.ts:121-127）对新会话返回宿主用户消息数+1，首轮落库序号 ≥2——0 基假设对该生产者不成立，正常会话会被判 RETENTION_EXPIRED 全路径阻断 | 非零起点不再是缺口也不是保留证据；保留证据仅剩 `sessions.started_at` 严格早于最早存活轮（冲突时 started_at 保留=首轮时刻，语义可靠，trajectory.ts:400-405 实证）；turn_index 洞保留为 SOURCE_GAP。**CONTRACT §2.4 的 turn_index 例证对本生产者不可机械化——偏离已在此披露** | 生产编号正控（2,3 连续→零 SOURCE_*）；started_at-only 保留负控；DT-07 三向全部保持 |
| R285 host_kind=null 结构拒绝 | 属实：真实冻结数据集 S01/S08 即为 null，schema 允许 NULL | 接受 null→未知归属语义（非字符串仍拒绝） | 真实数据集形态入口用例（null 通过且不伪造 openclaw） |
| R455 ok=false/PARTIAL_CONSISTENCY 快照仍发 READY | 属实：T1 生产者明确禁止部分一致快照被正式实验消费 | manifest `ok!==true` 或 `consistencyStatus!=='CONSISTENT_WITHIN_WINDOW'` → 全探测结构拒绝（exit 1 `snapshot_consistency_unverified`），不发任何 READY | ok=false / PARTIAL_CONSISTENCY 两个 fail-closed 用例 |
| R345 期望缺 basis 仍可标注 | 属实：CONTRACT §2.3 要求每项期望携带 basis | basis 必填枚举（缺失/非法 → 结构拒绝），resolved=true 不能替代来源依据 | 缺 basis 结构拒绝用例 |
| R856 独立引用损坏 Blob 绕过校验 | 属实（评审对象为 r1 HEAD）；r2 P2-3 已修复：evidenceRef blob 走安全读取+digest 比对 | 已由 P2-3 覆盖 | P2-3 套件 + 评审原始示例锚定用例 |
| R695 Emoji 截断预览漏检 | **属实且精妙**：生产者按 UTF-16 码元截断（JS .length/.slice），SQLite length() 按码点——含星面字符的截断预览 length=499≠500 漏检 | 有界窗口检测：SQL 取 `substr(preview,-501)`（≤501 码点，绝不取全文）+ 码点长度；窗口即全文时以 JS UTF-16 长度精确判定 ==500 且以 '...' 结尾；>501 码点必 >500 码元，直接排除 | Emoji 500 码元/499 码点用例（检出）；>501 码点合法结尾 '...' 不误报 |
| R570 时区偏移轨迹误判缺口 | 属实：最早轮次按字符串选取、顺序按字符串比较 | 最早轮次与顺序判定全部改为 isoTimeValue 时刻比较；不可解析时间独立成缺口原因（不静默跳过） | 混合偏移正常顺序正控（零缺口）；跨偏移真实倒序负控（检出） |
| R889 期望依赖工具输出缺口不计入完整性 | 属实：标注 BLOCKED 但 completeness 仍 COMPLETE，完整案例数虚高 | dependsOnToolOutput && TOOL_RESULT_PREVIEW_ONLY → completeness 派生 INCOMPLETE；PIPELINE_REPLAY 独立 READY 语义保持 | replay READY + labeling BLOCKED + completeness INCOMPLETE 三断言用例 |

## 13. r3 最终整改（3 项，2026-11-21）

最终独立复审 3 项发现全部修复；测试 102 → **108**（107 执行 + 1 POSIX FIFO 用例在 Windows 平台显式跳过，Linux CI 真实执行）。

| 发现 | 根因 | 修复 | 测试 |
| --- | --- | --- | --- |
| P1-01 started_at-only 保留证据被 gap 检测门控 | 保留证据只在 gapReasons 非空时参与判定——一个"存活窗口内部完全连续、但 started_at 严格早于最早存活轮"的会话（10:00 建、10:06/10:07 存活、10:08 Pain）不会得到任何 SOURCE_* 判定，积极证据被丢弃 | 保留证据独立判定：`started_at` 有效且**严格早于**最早存活轮时刻 → 无条件 `SOURCE_RETENTION_EXPIRED`（impact 区分"伴随其他缺口"与"仅凭积极证据"两种表述）；不可解析/相等不构成积极证据；turn_index 非零起点旧错误不回归；不推断缺失内容 | Case A 正控（无其他 gap 仍 RETENTION+INCOMPLETE+BLOCKED）/Case B 相等边界/Case C 不可解析+真实缺口保持 SOURCE_GAP/Case D 生产编号兼容 |
| P1-02 POSIX FIFO 永久阻塞 | `open(O_RDONLY)` 对无写入者的 FIFO 会等待写入者——probe 可能被单条夹持的 blob 路径永久挂起 | 采用 `residue-delete.mjs` `readRegularFileNoFollow` 的同一旗标纪律：POSIX 追加 `O_NONBLOCK`（win32 显式 0）——O_NONBLOCK 只让 open 非阻塞，类型裁决仍完全来自 fstat；FIFO/目录/其他非普通文件一律拒绝，内容读取仍只经已验证 fd，不回退路径读取 | POSIX 真实 FIFO 用例（3s 超时边界：完成而非被杀、`not a regular file` 拒绝、无 DIGEST_MISMATCH 即零读取、无 READY、源文件集+sha+mtime 不变）；Windows 显式跳过，junction/symlink/dir 拒绝测试继续执行 |
| P2-01 fstat 异常 fd 泄漏 | openSync 与 fstatSync 同一 try/catch：open 成功后 fstat 抛出会直接进入 catch 返回，fd 未关闭 | fd 生命周期重组：open 成功立即进入**单一 finally 托管区**——fstat/验证/身份绑定/哈希/异常返回全部在区内，任何成功、拒绝、异常路径都恰好关闭一次；close 异常不掩盖原始拒绝原因；错误分类不变（fstat 失败仍归 `unreadable`） | 故障注入（`NODE_OPTIONS=--require` CJS preload 在 ESM 图加载前打补丁，实证对 `import {fstatSync} from 'node:fs'` 可见）：首 fstat 确定性抛出→CLI 结构化拒绝（exit 0 + unreadable impact）、故障 fd 恰好一次 close（计数日志恰一行 `FAULT_FD_CLOSE=1`）、无内容消费 |

## 14. r4 最终整改（3 项，2026-11-21）

最终复审 3 项发现全部核实为属实并修复；测试 108 → **112**（111 执行 + 1 Windows FIFO 平台跳过，Linux 全执行）。

| 发现 | 根因 | 修复 | 测试 |
| --- | --- | --- | --- |
| R965 完整会话误判保留期清扫 | r3 的 started_at-only 保留证据忽略非轮次会话创建者：manual pain（`/pd-pain`，`pain-signal-observability.ts`）以 Pain 时刻建会话并留下 pain_events 行（pain_events **不在保留清扫表**），工具证据写入器（`production-pain-evidence.ts`）同理；`/pd-pain` 先于首轮对话时 started_at 早于最早存活轮，完整会话被判 RETENTION_EXPIRED 全路径阻断 | started_at 差值仅在**无保留免疫的非轮次记录解释**时才是积极保留证据：存在同时刻（时刻相等）的该会话 pain_events 行 → 起始来自该 immortal 记录 → 不构成保留证据（窗口完整则零 SOURCE_*，样本进入实验）；无解释 → 首写入者本身是可清扫轨迹行（轮次或工具调用）且已消失 → 保留证据成立（r3 语义保持）；解释查询入 main 守卫窗口（staged 清理覆盖） | Case E（评审原例：10:00 /pd-pain + 10:01–10:04 两对完整轮 + 10:05 数据集 Pain → 零 SOURCE_*、READY、COMPLETE）/Case F（解释存在但不掩盖独立连续性缺口→SOURCE_GAP 保留）/Case G（无解释→保留证据独立成立）/r3 Case A–D 全保持 |
| NODE_OPTIONS 空格拆分 | Node 按空白拆分 NODE_OPTIONS，含空格的 preload 路径未加引号使 CLI 启动即败 | preload 改经**子进程 argv**（`node --require <path> probe.mjs …`），不经 NODE_OPTIONS；新增含空格目录的回归（复制 preload 到 `preload dir with spaces/` 后 --require 仍启动并完成） | 空格路径回归用例（argv 单元素传递，CLI 正常启动+故障注入照常生效） |
| FIFO 对账盲区 | `fingerprintTree` 只记录普通文件——FIFO 被删/替换不会使前后对账失败 | FIFO 用例补 lstat 身份断言（前后 `isFIFO()` + dev/ino 相等，绝不打开管道） | 已并入 FIFO 用例（Linux CI 执行） |

## 15. r5 最终整改：起点解释与前缀完整性解耦（2026-11-21）

r5 复审核心发现：r4 把"pain 行解释了 started_at"直接当作"前缀完整"——**解释了会话为何在此刻创建，不等于创建后没有发生过其他历史事件**。整改将两个维度彻底拆分，测试 112 → **118**（117 执行 + 1 Windows FIFO 平台跳过）。

### 生产语义核实（本轮重读源码）

| 事实 | 位置 | 结论 |
| --- | --- | --- |
| manual Pain 建会话时间 | `pain-signal-observability.ts:129-145` | 以 Pain 时刻 INSERT sessions（ON CONFLICT 只更新 updated_at）；pain_events 行同流写入且 **immortal** |
| session upsert 保留 started_at | `trajectory.ts:399-405` | 确认（r2 已证） |
| 会话创建者完整清单 | 全库 `INSERT INTO sessions`/`upsertSession` 枚举 | 轮次写入器（recordUserTurn/recordAssistantTurn/recordSession）、manual-pain 观测写入器、工具证据写入器（production-pain-evidence.ts:405/555，同流写 tool_calls 行） |
| 各创建者的持久化证据 | 同上 | 轮次创建者→可清扫轮次行；manual-pain→immortal pain_events 行（同时刻）；工具证据→可清扫 tool_calls 行（同时刻） |
| nextUserTurnIndex 起始编号 | `prompt.ts:121-127` | 新会话=宿主用户消息数+1（≥2），非 0 基；**不持久化预期起点** |
| turn_index 能否证明前缀 | 同上 | 不能——起始编号无持久化锚点，连续性不证明起点 |
| 清扫实际删除 | `trajectory-retention.ts:468` TRAJECTORY_RETENTION_TABLES | tool_calls/assistant_turns/user_turns（+governance_observations expired 类）；pain_events/sessions/signal_confirmations/correction_samples 均 immortal |
| 清扫审计痕迹 | 全模块无 INSERT | **清扫不写任何持久化审计**——清扫后无法从库内证明"发生过清扫" |
| 独立历史来源 | signal_confirmations/correction_samples | immortal 表携带指向可清扫轮次行号的引用（references_assistant_turn_id/user_turn_rowid/bad_assistant_turn_id/user_correction_turn_id）；AUTOINCREMENT 行号不复用 ⇒ **存活行引用已消失的轮次行号=该行被删除的正向证明（N1）** |
| T1 快照来源边界 | 快照形态 | 两库+blob，无清扫元数据 |

### 算法（两个独立维度）

**维度 A — Start Explanation**（枚举：EXPLAINED_BY_MANUAL_PAIN / EXPLAINED_BY_TOOL_EVIDENCE / EXPLAINED_BY_TURN_WRITER / UNEXPLAINED / NOT_APPLICABLE）：只按创建者**真实持久化证据**判定——pain_events 行与 started_at **时刻相等**→MANUAL_PAIN；tool_calls 行同时刻→TOOL_EVIDENCE；started_at==最早存活轨迹行（轮次∪tool_calls 的最早时刻）→TURN_WRITER；started_at 早于最早轨迹行且无任何非轮次记录解释→UNEXPLAINED；其余（不可解析/晚于所有行/无行）→NOT_APPLICABLE。禁止时间邻近猜测。

**维度 B — Prefix Completeness**（三态）：
- **PROVEN_COMPLETE**：started_at 时刻==最早存活轨迹行时刻 → 首写入者是仍存活的轨迹行 → 其前不可能有任何行（更早的写入者会把 started_at 设得更早）。
- **PROVEN_INCOMPLETE**：N1 存活 immortal 行引用已消失的轮次行号（正向删除证据）；或 N2 UNEXPLAINED 差值（首写入者是可清扫轨迹行且已消失）。
- **UNKNOWN**：其余全部——**尤其是 manual-pain-first 类**（完整会话与被清扫会话在该快照中可观察字段完全相同，见下"不可区分性"）；UNKNOWN 永不升级为 COMPLETE。

**组合规则**（按 r5 指令表）：PROVEN_INCOMPLETE → `SOURCE_RETENTION_EXPIRED`（正向证据）+ INCOMPLETE + 全路径阻断；UNKNOWN → `SOURCE_GAP`（"前缀完整性无法证明"）+ INCOMPLETE + 全路径阻断——即使存活窗口内部全部连续检查通过；PROVEN_COMPLETE → 仅常规 gapReasons（DT-07 语义不变）。

### 可识别性约束（如实披露）

**Case E（pain-first 完整会话）与 Case H（早期轮次被真清扫）在快照中可观察字段完全相同**——生产者不持久化预期起点，清扫不留审计，pain 行只解释起点不证明其后的历史。因此两者都判 UNKNOWN → SOURCE_GAP → INCOMPLETE → 阻断；**宁可如实报告证据不足，也不放行**。要区分两者需要生产者侧新增 provenance（如首写入者类别或预期起点字段）——必要性在此披露，实现属生产变更、超出本 PR 范围，未偷偷引入。turn-created 会话（Case I）不受影响：其起点解释本身即完整性证明（PROVEN_COMPLETE 可达）。

### Case 矩阵（全部真实 CLI 子进程）

| Case | 输入 | 预期→实际 | 断言要点 |
| --- | --- | --- | --- |
| A（r3 保持） | started_at 10:00、存活轮 10:06+、无解释记录 | RETENTION_EXPIRED（N2）→✓ 实际一致；INCOMPLETE+BLOCKED | 证据文案更新为 N2 表述 |
| B/D（保持） | started_at==最早轮 | PROVEN_COMPLETE→零 SOURCE_*→✓ | — |
| C（保持） | started_at 不可解析+真实缺口 | UNKNOWN+gapReasons→SOURCE_GAP→✓ | — |
| E（重写） | 评审原例：10:00 /pd-pain+10:01–10:04 两对完整轮+10:05 数据集 Pain | EXPLAINED_BY_MANUAL_PAIN + UNKNOWN → SOURCE_GAP+INCOMPLETE+BLOCKED→✓ 实际一致；**不产生 RETENTION_EXPIRED** | impact 含 "cannot be proven"；报告字段 sessionStartExplanation/prefixCompleteness 断言 |
| F（r4 保持） | 解释+独立 gapReasons 缺口 | SOURCE_GAP（不被解释掩盖）→✓ | — |
| G（r4 保持） | 无解释差值 | PROVEN_INCOMPLETE→RETENTION→✓ | — |
| **H1** | pain-first+早期轮 aged+**真清扫**+immortal signal_confirmations 引用被清扫轮 | PROVEN_INCOMPLETE（N1）→RETENTION_EXPIRED+INCOMPLETE+BLOCKED→✓ 实际一致 | sweep.outcome=completed、清扫后行数断言、impact 含 "reference turn rows that no longer exist" |
| **H2** | 同 H1 但无 immortal 引用 | UNKNOWN→SOURCE_GAP+INCOMPLETE+BLOCKED→✓ 实际一致；**绝不 PROVEN_COMPLETE** | EXPLAINED_BY_MANUAL_PAIN + UNKNOWN 断言 |
| **I** | 轮次创建者（started_at==首行，无非轮次同时刻记录） | PROVEN_COMPLETE→READY→✓ 实际一致 | EXPLAINED_BY_TURN_WRITER+PROVEN_COMPLETE+零 SOURCE_*（除 ENVIRONMENT） |
| **J** | 仅有 Pain 解释+无前缀证明 | UNKNOWN→SOURCE_GAP+INCOMPLETE+BLOCKED→✓ 实际一致 | — |
| **K** | 非零 turn_index+解释起点 | UNKNOWN→SOURCE_GAP；**不判 RETENTION**→✓ 实际一致 | — |
| **L** | 解释起点+独立 N1 缺口（真清扫+引用悬空） | PROVEN_INCOMPLETE→RETENTION_EXPIRED（正确正向代码）→✓ 实际一致 | 解释不掩盖缺口；impact 含引用细节 |

## 16. r6 最终整改：证明强化（2026-11-21）

r6 复审三项全部属实全部修复；测试 118 → **126**（125 执行 + 1 Windows FIFO 平台跳过）。

| 发现 | 根因 | 修复 | 测试 |
| --- | --- | --- | --- |
| P1-a 优先级错误 | 三态判定先判 `started_at == 最早存活轨迹行`（PROVEN_COMPLETE）后查悬空引用——同时刻用户轮存活+引用悬空的会话被错误升级 COMPLETE | 优先级重排：**N1 悬空引用第一优先**（无论 started_at 关系如何）；PROVEN_COMPLETE 仅在 N1 为零且存在首写入者身份锚点且证据覆盖完整时可达 | 确定性 Hook 回归：脚本时钟让生产清扫器提交 assistant_turns 批次后耗尽预算（user_turns 批次未启动）——started_at 时刻用户轮存活+悬空引用 → PROVEN_INCOMPLETE + RETENTION_EXPIRED + BLOCKED；断言 `deletedByTable.assistant_turns=1`、清扫后行数、outcome |
| P1-b 时间戳不是身份锚点 | created_at 是时间不是行身份：同毫秒碰撞、已删首写入者与存活者同时刻、**裸 recordSession 创建合法**（prompt.ts:659 每次 prompt 构建都会裸建会话）——等值分支与 N2（UNEXPLAINED 差值）均不成立 | 时间戳等值分支与 UNEXPLAINED 差值全部降级 UNKNOWN；`FIRST_WRITER_IDENTITY_PROVENANCE_AVAILABLE=false`（当前 schema 无首写入者身份锚点）→ PROVEN_COMPLETE 在生产者 provenance 落地前不可达（枚举保留+守卫显式）；PROVEN_INCOMPLETE 仅经 N1；recordSession 全调用方枚举入报告（prompt.ts:659/trajectory.ts:481,511,1687 内部） | 时间戳碰撞用例（首写入者经真清扫删除+存活者同时刻+无引用→UNKNOWN 不误判 RETENTION）；recordSession-only 用例（裸建会话合法→UNKNOWN）；Case I 预期按审计结论调整（PROVEN_COMPLETE→UNKNOWN，披露） |
| P2 旧版快照缺可选证据表整批失败 | 引用查询无条件访问 signal_confirmations/correction_samples（不在 REQUIRED_TRAJECTORY_TABLES）；旧版 T1 快照缺表→查询阶段 SQLite 错误→probe 崩溃 | 逐源能力检查（表存在+必需列存在，PRAGMA table_info，常量表名）；不可用源跳过并披露（report.snapshot.prefixEvidence.sources+coverageComplete）；**缺失≠零缺失**——无其他正向证据时保持 UNKNOWN；任一可用源发现悬空引用仍判 PROVEN_INCOMPLETE | A/B/C（缺表）/D（表在但列缺失——legacy migration 形态）/E（部分覆盖+user_turns 源真实悬空引用→PROVEN_INCOMPLETE）五用例 |

**Case I 预期调整披露**：turn-created 会话（started_at==首行）原判 PROVEN_COMPLETE——r6 审计证明该推论依赖"时间戳唯一标识首写入者"，生产不成立（碰撞+裸建会话）→ 降级 UNKNOWN+SOURCE_GAP+阻断，直至生产者 provenance 落地（Owner 决策项）。**系统性影响**：当前 schema 下无任何会话可达 PROVEN_COMPLETE——所有样本经 UNKNOWN→SOURCE_GAP 如实阻断，等待 provenance；N1 悬空引用路径（PROVEN_INCOMPLETE）不受影响。

## 17. Complexity Delta

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
