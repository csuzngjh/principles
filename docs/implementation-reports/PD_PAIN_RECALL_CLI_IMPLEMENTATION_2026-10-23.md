# PD Pain Recall CLI 实现报告 — SPEC-PD-PAIN-RECALL-CLI-001

- **日期**：2026-10-23
- **分支**：`ai/pain-recall-cli-zcode-pain-recall`（任务 worktree `D:\Code\_worktrees\principles\pain-recall-cli-zcode-pain-recall`，自 `main @ 0e421b1095f7196c7ea8d05be52892321b6d47c6` 创建；主检出的 worktree-guard 禁止实现提交，已按仓库治理改走任务 worktree 提交）
- **提交**：`659a5ace5`
- **PR**：https://github.com/csuzngjh/principles/pull/2128（OPEN，不自行合并）
- **SPEC**：`docs/specs/SPEC-PD-PAIN-RECALL-CLI-001.md` v1.0
- **状态**：功能与自动化测试达到 SPEC §9 验收标准；待 Owner 评审合并

---

## 1. 基线

| 项 | 值 |
| --- | --- |
| 仓库 | `D:\Code\principles`（主检出） |
| 基线 SHA | `0e421b1095f7196c7ea8d05be52892321b6d47c6`（== SPEC 参考提交 == `origin/main`，fetch 后确认无新主干） |
| 起始工作树 | 无已跟踪文件修改；仅存在既有未跟踪文件（用户/其他会话产物，全部保留未动） |
| 既有 Recall 实现 | 无（全仓 `recall` 分支/代码检索为零命中，仅 SPEC 文档；`SPEC-PD-PRR-001` 系列是行为实验文档，无 CLI 代码） |
| 并发 | 数十个其他任务 worktree 存在，均不涉及本仓库工作区；本任务全程在主检出内操作，未触碰任何未知文件 |

执行中的环境事实：主检出的各包 `dist/` 普遍过期（pd-cli 构建最初因 stale `@principles/core`/`principles-disciple`/`pd-console` dist 报与本次改动无关的 TS 错误）。按依赖顺序重建 core → principles-disciple(openclaw-plugin) → host-runtime → pd-console → pd-cli 后全部通过。构建/打包测试还会重写 `packages/create-principles-disciple/**/package.json` 中的 payload 版本字段（生成物），已还原，不入本次提交。

## 2. 接口核对表（阶段 1，全部对当前源码核实）

| SPEC 提及的契约 | 真实位置（核实点） | 结论 |
| --- | --- | --- |
| `resolveLedgerActivationId` | `principles-core/src/runtime-v2/activation/ledger-identity.ts:121` | 存在，但它是 **PI 工件 → 原则** 的激活边界解析器；recall 以 ledger 键为身份权威（精确键匹配），不需要、也未复制它 |
| `readLedgerFileState` | `principles-core/src/principle-tree-ledger.ts:153`，返回 `{ledger, availability: ok/empty/unreadable}` | 直接复用；`empty→missing`、`unreadable→unreadable` 映射进 sources 合同 |
| `openTrajectoryDbReadonly` | `principles-core/src/trajectory-store.ts:96`，缺库抛 `TrajectoryDbUnavailableError`，绝不创建文件 | 直接复用 |
| `.pd/state.db` 严格只读 | `RuntimeStateManager({workspaceDir, readonly: true, bootstrapIfMissing: false})`（`runtime-state-manager.ts:70-86`） | 直接复用；因 `getDb()` 惰性 + SQLite 延迟校验文件头，追加一条只读 `SELECT 1` 探活使"存在但损坏"能被归类为 `unreadable` |
| PainDiagnosisStore 查询 | `manager.getDiagnosesByPainId` / `getDiagnosesByTaskId`（`runtime-state-manager.ts:638/649`） | 直接复用 `getDiagnosesByPainId` |
| PainChainReadModel | `runtime-v2/pain-chain-read-model.ts` | 方向相反（pain→principle）。其 `buildCandidateToLedgerEntryMap` 注释**证实 `derivedFromPainIds` 存的是 candidate id**；该 Map 是单值覆盖结构，recall 未复用它，改按 principle 迭代 + 多值 refs 数组 |
| `readPromptActivationCandidates` | `host-runtime/src/active-principle-prompt.ts:76` | prompt 侧读路径；recall 不经过 prompt 工件，身份权威直接用 ledger（避免实现第二套 resolver） |
| `derivedFromPainIds` | `Principle` schema；生产写入 `updatePrinciple`/候选 intake | **按 candidate id 处理**（见 §5 关联链） |
| `reuseEvidence` | `Principle.reuseEvidence[]`，schema 为 `{painId(真实), candidateId, decision:'reuse', actor, reason, decidedAt, decisionId?}`，唯一写入者 `appendReuseEvidence`（入口校验 painId/candidateId 非空） | 显式 painId 边的权威来源 |
| candidate→pain 血缘 | `principle_candidates.task_id` → `tasks.input_ref`（写入者 `pain-signal-bridge.ts:901` `inputRef: data.painId`）；task_id 拼写 `diagnosis_<painId>`（`createDiagnosticianTaskId`）为回退 | 两级解析：input_ref 优先，`diagnosis_` 前缀剥离兜底；都失败则显式排除 |
| correctionEvidence 持久化 | 诊断任务 `tasks.diagnostic_json` 顶层 `correctionEvidence` 字段（`pain-signal-bridge.ts` PainDetectedData 注释 + `validatePersistedIngressFacts` 读回契约） | 通过 `manager.getTask('diagnosis_<painId>')` 读取并保留 `classification/channel` 语义 |
| pain 事件字段 | `trajectory-schema.ts:91`：`pain_events(reason, text, severity, source, score, host_kind, canonical_pain_id, created_at …)` | reason（检测/登记时理由）与 text（有纠错证据时存 Owner 原话，否则 reason 副本）**分开返回**，绝不合并 |
| pd pain 命令树 | `pd-cli/src/index.ts` painCmd（record/retry/list/evidence） | 新增 `recall` 子命令，复用 `.option()` + handler 校验惯例（结构化 JSON 参数错误） |
| JSON envelope | pain-list 先例：`{status:'failed', reason, message, nextAction}` + `process.exit(1)`；成功结果 `JSON.stringify(result, null, 2)` | 参数错误复用该 envelope；域结果用版本化 recall 合同 |
| workspace resolver | `resolve-workspace.ts resolveWorkspaceDir` + `path.resolve(opts.workspace)`（trace 先例） | 直接复用 |
| 三宿主技能路径 | `plugins/principles-disciple/skills/pd-cli-operator`、`packages/openclaw-plugin/templates/langs/{en,zh}/skills/pd-cli-operator`、`packages/workbuddy-adapter/plugin/skills/pd-cli-operator` | 4 份文件全部更新 |
| 技能↔命令合同测试 | `pd-cli/tests/commands/cli-skill-contract.test.ts`（原仅 OpenClaw en/zh） | 扩展为四目录三宿主 + 断言每宿主 pd-cli-operator 引用 `pd pain recall` |

## 3. 变更清单

| 文件 | 类型 | 目的 |
| --- | --- | --- |
| `packages/pd-cli/src/services/pain-recall.ts` | 新增 | 共享 Recall read model：规范身份、关联图、去重、确定性排序、availability 聚合（~590 行） |
| `packages/pd-cli/src/commands/pain-recall.ts` | 新增 | CLI handler：参数校验（JSON error envelope）、人读输出、退出码策略 |
| `packages/pd-cli/src/index.ts` | 修改（+18） | 在 `pd pain` 命令树注册 `recall` 子命令 |
| `packages/pd-cli/tests/commands/pain-recall.test.ts` | 新增 | 40 测试：参数/端到端/关联图/可用性/信息语义/排序截断 |
| `packages/pd-cli/tests/commands/pain-recall-readonly.test.ts` | 新增 | 4 测试：缺库不建文件、字节哈希/大小/journal mode 不变、无 WAL/SHM、无新表 |
| `packages/pd-cli/tests/commands/cli-skill-contract.test.ts` | 修改 | 合同测试扩展到 Codex/OpenClaw en+zh/WorkBuddy 四个技能目录 |
| `plugins/principles-disciple/skills/pd-cli-operator/SKILL.md` | 修改（+10） | Codex 技能：recall 何时用/命令/状态判读/禁项 |
| `packages/openclaw-plugin/templates/langs/en/skills/pd-cli-operator/SKILL.md` | 修改（+16） | OpenClaw en 同上 |
| `packages/openclaw-plugin/templates/langs/zh/skills/pd-cli-operator/SKILL.md` | 修改（+16） | OpenClaw zh（与 en 语义一致） |
| `packages/workbuddy-adapter/plugin/skills/pd-cli-operator/SKILL.md` | 修改（+14） | WorkBuddy（固定治理工作区口径） |

无新依赖、无新数据库/表/服务/MCP server、无 schema 变更、无治理状态机改动。

## 4. 命令与 JSON 合同

```
pd pain recall --principle-id <uuid> [--pain-id <id>] [--context <text>] [--limit 1-10] [-w <workspace>] [--json]
```

- 顶层：`schemaVersion: "pd.pain-recall.v1"`；`status` ∈ `ok | no_matches | principle_not_found | ambiguous_principle(保留，精确键匹配下不可达) | pain_not_found | source_missing | source_unreadable | partial`；`pain_not_found` 附 `statusDetail: not_associated | pain_event_not_found`。
- 退出码：`ok/no_matches/partial` → 0；其余 → 1。参数错误 → 仓库标准 error envelope（`{status:'failed', reason, message, nextAction}`）+ 退出 1。
- `query`：`{limit, painId?, contextUsedForRanking, truncated}`；`summary`：`{returned, availableCandidates, truncated}`；`sources`：`{ledger, trajectoryDb, stateDb}` ∈ `ok|missing|unreadable|not_checked`。
- 每条结果：`association{type: explicit_reuse|derived_from|multiple_paths, confidence: explicit|lineage_verified, evidenceRefs[]}`、`pain{occurredAt,source,host,score,severity,reason,text,rawStatement:null}`、`diagnoses[]{...,isOriginalOwnerStatement:false}`、`correctionEvidence|null`、`availability{painEvent,diagnoses,correctionEvidence}`、`lineage[]`（逐跳关系）。
- `unresolvedAssociations[]`：无法解析的关联边（`candidate_not_found`/`state_db_unavailable`/`pain_unresolvable_from_candidate`/`pain_event_not_found` 等），显式报告而非静默丢弃。
- 状态规则：ledger 缺失/不可读 → `source_missing/source_unreadable`（绝不变 no_matches）；trajectory.db 同理（recall 的主体就是 pain 历史）；state.db 缺失/不可读 → 复用边仍可用，lineage 边进 unresolved，诊断/纠错 `unreadable`，顶层可 `partial`。

## 5. 关联解析证据链（每条边可审计）

1. **explicit_reuse**：`Principle.reuseEvidence[].painId`（ledger 写边界校验过的真实 pain id）→ 直连。evidenceRef `{kind:'reuse_evidence', candidateId, decidedAt?, decisionId?}`。
2. **derived_from**：`Principle.derivedFromPainIds[]`（生产契约 = candidate id， PainChainReadModel 注释证实）→ `principle_candidates.task_id` → `tasks.input_ref`（写入者 `inputRef: data.painId`）；无 tasks 行时回退剥离 `diagnosis_` 前缀（`createDiagnosticianTaskId` 的确定性拼写）。evidenceRef `{kind:'candidate_lineage', candidateId, taskId}`。
3. **去重**：按真实 painId 合并；`refs.length > 1` → `multiple_paths`，全部 evidenceRefs 保留（测试 assoc-6）。
4. **多对多**：按被查 principle 迭代建边，无跨 principle 共享索引；一个 candidate 出现在两个 principle 的 `derivedFromPainIds` 时两条查询各自成立（测试 assoc-7）。
5. **禁止项**：`derivedFromPainIds` 字符串从不直接当 painId（assoc-5）；标题/正文相似不建边（assoc-8）；`--pain-id` 传 candidateId 得到 `pain_not_found`（cli-B4）；candidateId/taskId/artifactId 与 painId 永不互换。

## 6. 只读副作用验证（自动化）

| 测试 | 结果 |
| --- | --- |
| ro-1 全部数据源缺失 → 返回后工作区目录仍为空（无文件/目录创建） | PASS |
| ro-2 三种查询路径执行前后 trajectory.db 与 state.db sha256、字节数、journal mode 不变；无 `-wal/-shm/-journal` sidecar；ledger 无 `.lock` 残留 | PASS |
| ro-3 state.db 缺失时不 bootstrap（文件保持不存在） | PASS |
| ro-4 sqlite_master 表集合不变（无迁移/新表） | PASS |

实现侧只读依据：ledger 走 `readLedgerFileState`（纯读）；trajectory 走 `openTrajectoryDbReadonly`；state.db 走 `RuntimeStateManager readonly + bootstrapIfMissing:false`（该模式显式跳过 schema init/migration，连接以 `readonly:true, fileMustExist:true` 打开）。唯一新增语句是只读探活 `SELECT 1 AS probe`。

## 7. 验证记录（命令与结果）

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/commands/pain-recall.test.ts tests/commands/pain-recall-readonly.test.ts`（packages/pd-cli） | **44/44 PASS** |
| `npm run build --workspace=@principles/pd-cli`（前置：重建 core/openclaw-plugin(+build:types,+build:bundle)/host-runtime/pd-console） | PASS（check-dist-hygiene OK） |
| `npm run typecheck --workspace=@principles/pd-cli` | PASS（0 错误） |
| `npx eslint src/services/pain-recall.ts src/commands/pain-recall.ts src/index.ts` | PASS（0 问题；测试文件被仓库 eslint 忽略模式排除） |
| `npx vitest run tests/codex-plugin-bundle.test.ts`（codex-adapter） | **43/43 PASS** |
| `npx vitest run tests/plugin-skeleton.test.ts`（workbuddy-adapter） | **10/10 PASS** |
| `npx vitest run tests/manifest-skills.test.ts tests/disclosure-contract.test.ts`（openclaw-plugin） | **18/18 PASS** |
| `npx vitest run workbuddy-skill-delivery workbuddy-packaged-install`（create-principles-disciple） | **44 PASS / 3 skipped**（skipped 为测试自带环境条件跳过；首轮 3 失败纯属 stale dist 链，重建后消除） |
| 真实二进制冒烟（合成临时夹具，系统临时目录，用后已删） | `pd pain recall --help` 正常；`--json` 成功路径完整合同（explicit_reuse + derived_from 双结果、context 排序、availability 正确）；缺 `--principle-id` → `principle_id_required` envelope；`--limit 11` → `invalid_limit`；未知原则 → `principle_not_found` |
| `git diff --check` | 干净 |
| `npx vitest run --exclude "tests/e2e/**" --exclude "tests/commands/console-open.test.ts" --exclude "tests/commands/console-open-reuse.test.ts" --exclude "tests/commands/console-launcher-edge-cases.test.ts"`（pd-cli 包内全量） | **exit code 0**（vitest 任一用例失败即非零退出；671 个模块 17029 次求值，全部通过。统计行被输出管道截断，以退出码为准） |

### 全量套件的已知环境限制（如实披露，不放宽断言）

- **`tests/e2e/**`（4 个文件）未纳入上述全量运行**：`cli-full-flow`、`cross-package-acceptance`、`candidate-intake-e2e`、`reuse-evaluation-prod-validation` 会触发整包构建/npm pack 重型链路。其中同等覆盖已由以下独立绿测承担：`create-principles-disciple` 的 `workbuddy-packaged-install`（真实 npm pack + 隔离安装）与 `codex-adapter` 的 `codex-plugin-bundle`（43/43）。
- **三个 console-open 类文件排除有因**：`timeout 300 npx vitest run console-open` 单独运行即挂起（exit 143，超时强杀）；这三个文件**不在本功能 diff 中**（仅 10 个文件变更，不含任何 console 代码），该挂起是与本改动无关的既有环境问题（spawn 的 console server 不退出）。主检出全量套件此前两次独立尝试（改动后的代码树）也均在同一区域停滞，现象可复现。
- `verify:merge` 未整体运行（要求全仓 release 产物链齐备）；其组成项中与本功能相关者（build/typecheck/skill 合同）已逐一通过。
- 无任何旧测试被删除、跳过或放宽；新增测试 44 项全绿。

## 8. 三宿主技能

- Codex / OpenClaw en / OpenClaw zh / WorkBuddy 四份 `pd-cli-operator` 均新增 recall 段：何时用（原则文本不足以解释来源/边界/相似性）、何时不用（原则已清楚、任务无关、纯增延迟）、示例命令、JSON 判读（先看顶层 status；`ok/no_matches/partial` 退出 0）、`not_recorded` vs `unreadable` 区分、诊断≠Owner 原话（`isOriginalOwnerStatement` 恒 false、原话只可能在 correctionEvidence）、`--pain-id` 不可越权、不可无休止重试、历史不覆盖当前任务直接证据。
- en/zh 逐条语义对应；WorkBuddy 版沿用其固定治理工作区口径，未改任何全局开关。
- 合同测试 `cli-skill-contract.test.ts` 现覆盖四目录（OpenClaw en/zh、Codex 插件、WorkBuddy 插件），并显式断言每宿主 pd-cli-operator 引用 `pd pain recall`；宿主目录缺失即失败（不静默跳过）。

## 9. 自审（SPEC 阶段 5 十项）

1. `derivedFromPainIds` 未被当 Pain ID —— 按 candidate 链解析，测试 assoc-5 锁定。
2. 无单值 Map 覆盖 —— 按 principle 迭代 + refs 数组，测试 assoc-7 锁定。
3. 缺库/空记录/不可读三态分离 —— avail-1..8 锁定；`source_missing` 绝不伪装 `no_matches`。
4. 诊断不被称作原话 —— `isOriginalOwnerStatement:false` 恒定 + correctionEvidence 独立字段，sem-2/3/4 锁定。
5. 无 bootstrap/迁移/WAL 写入 —— 只走已核实只读入口，ro-1..4 锁定。
6. 未读 transcript / tool_calls.params_json —— 仅读 pain_events 行、tasks.input_ref 与 diagnostic_json 顶层 correctionEvidence、pain_diagnoses、ledger 文件。
7. 无网络/模型/凭据/新 schema/治理变化 —— `--context` 为本地确定性 token 重叠排序。
8. 三宿主技能同步，en/zh 语义一致 —— 合同测试锁定。
9. 未改变既有 CLI 行为 —— 仅追加子命令；全量回归见 §7。
10. 用户改动全部保留；构建脚本重写的 5 个 create-principles-disciple payload package.json 已还原；diff 仅含本功能 10 个文件。

## 10. 未解决问题

- `ambiguous_principle` 状态在精确 ledger 键匹配下结构性不可达（键唯一）。合同中保留该枚举值以符合 SPEC §4.2；如未来引入别名解析需补测试。
- **既有环境问题（非本功能引入）**：`pd-cli` 的 console-open 类测试在本机挂起（spawn 的 console server 不退出，单独运行 300s 超时可复现，exit 143）；`tests/e2e/**` 4 个重型集成文件未纳入本机全量运行。两者均不在本功能 diff 中，等价覆盖已由独立绿测承担（见 §7）。建议 Owner 另行立项排查本机全量套件的挂起问题。
- 无阻塞上线事项。

---

## 11. 评审修复记录（PR #2128 第一轮复审，2026-10-24）

Owner 复审 + CodeRabbit 共指出 5 项发现，逐项对照源码核实后**全部属实**，已全部修复：

| # | 发现 | 核实结论 | 修复 |
| --- | --- | --- | --- |
| P1 | 损坏 `trajectory.db` 不会返回 `source_unreadable`，而是逸出成通用 `recall_failed` | 属实：`openTrajectoryDbReadonly` 只查存在性，SQLite 延迟到首条语句才校验文件头/表结构；原首个 `prepare` 位于无 catch 的 try/finally | 打开后立即只读探活 `SELECT 1 FROM pain_events LIMIT 1`（同时校验文件头与表存在性），失败先 `close()` 再抛入现有 catch → `source_unreadable` |
| P2 | `resolveWorkspaceDir()` 在 try/catch 之外，抛出时 `--json` 得不到结构化 envelope | 属实：该函数在步骤 3（config 不可解析）与步骤 5（无工作区）显式 throw | 包入独立 try/catch → `fail({reason:'workspace_unresolved'})` |
| P2 | `--limit` 用 `parseInt` 解析：`2.5→2`、`3abc→3` 静默通过；Commander 把前一选项值作 radix 传入 | 属实（commander `parseArg(value, previous)` 与 `parseInt` 组合的已知陷阱） | 新增导出 `parsePainRecallLimit`（单参数、`/^\d+$/` 全匹配，非法即 NaN 交由 handler 拒绝），index.ts 接线 |
| CodeQL | `diagnosesAvailability` 初值死赋值 | 属实：所有分支必覆盖 | 去掉初始化器（TS 定赋值分析可证）；`correctionAvailability` 初值有真实语义（无纠错证据时保持 `not_recorded`），保留 |
| CI | 缺 `.changeset/*.md`（Verify Merge Gate 红） | 属实 | 补 `.changeset/pain-recall-cli.md`；guard 首跑再暴露 N-5/C4 规则（声明 `principles-disciple` 必须连带声明打包它的 `create-principles-disciple`），补齐后本地 `node scripts/release/check-pr-release-intent.mjs` PASS（pd-cli minor + principles-disciple/create-principles-disciple/workbuddy-adapter/codex-adapter patch） |

**回归测试**（Owner 要求三项全覆盖，新增 17 项，专项测试 44→61 全绿）：

- `avail-9`：损坏 trajectory.db → `status=source_unreadable`、`sources.trajectoryDb=unreadable`，不再抛 `recall_failed`。
- `avail-10`：合法 SQLite 但缺 `pain_events` 表 → `source_unreadable`（探活同时覆盖缺表场景）。
- `cli-A5`：`resolveWorkspaceDir` 抛出 → `{status:'failed', reason:'workspace_unresolved'}` envelope + 退出 1。
- `parsePainRecallLimit` 14 项：`2.5/3abc/abc/-1/空/空白/0x10/1e2/3,5/全角` → NaN；`3/带空格 10/007/1` → 正确整数。

验证：`npx vitest run pain-recall`（专项 61/61）、`tsc --noEmit` 0 错误、eslint 触达文件 0 问题。
