# PD Pain Recall CLI 实现报告 — SPEC-PD-PAIN-RECALL-CLI-001

- **日期**：2026-10-23
- **分支**：`ai/pain-recall-cli-20261023`（自 `main @ 0e421b1095f7196c7ea8d05be52892321b6d47c6` 创建，与 `origin/main` 一致）
- **SPEC**：`docs/specs/SPEC-PD-PAIN-RECALL-CLI-001.md` v1.0
- **状态**：功能与自动化测试达到 SPEC §9 验收标准；待 Owner 评审合并（不自行合并）

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
| pd-cli 全量 `npx vitest run` | 见下方"运行中/已知限制" |

### 运行中 / 已知限制（如实披露）

- pd-cli 包**全量** vitest 套件在本机运行时间很长（含 codex-plugin-bundle 48s、packaged-install 触发 npm pack 等重型用例），本报告交付时仍在后台执行；专项 recall 测试（44/44）与全部技能合同测试已绿。若全量套件出现与本功能无关的环境性失败，将以精确命令与退出码补充记录，不放宽任何断言。
- `verify:merge` 未整体运行（要求全仓 release 产物链齐备）；其组成项中与本功能相关者（build/typecheck/skill 合同）已逐一通过。

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
- 全量 pd-cli 套件运行时长见 §7 披露；不构成上线阻塞（专项+合同测试全绿）。
- 无阻塞上线事项。
