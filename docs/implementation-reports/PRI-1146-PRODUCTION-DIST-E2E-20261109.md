# PRI-1146 Phase 8：Production Dist 端到端验收报告（2026-11-09）

**结论：ALL SCENARIOS PASS（8/8）。** 全部场景运行于本工作树的最新 production dist 构建（`npm run build` 全仓产物），无 Runner/Registry/Committer mock。

## 运行环境与证据锚点

| 项 | 值 |
|---|---|
| 工作树 | `D:\Code\_worktrees\principles\PRI-1146-diagnostician-output-v2-only`，分支 `ai/PRI-1146-diagnostician-output-v2-only`，HEAD 提交见 PR |
| 构建 | 全仓 `npm run build`（exit 0，dist 卫生检查通过） |
| 真实模型 | pi-ai / zai / glm-5.3-flash（`ZAI_API_KEY`），经真实 OpenAI 兼容 wire |
| 隔离工作区 | `.tmp/pri1146/e2e/ws-blank`（空白初始化，Phase 6 清零后重建）、`.tmp/pri1146/e2e/ws-composed`（确定性场景）、`.tmp/pri1146/e2e/ws-v1neg`（负向） |
| 驱动入口 | 真实 `pd-cli/dist/index.js`（pain record → diagnose run）；组合场景经真实 dist 模块组装 SplitDiagnosticianRunner |
| 脚本证据 | `.tmp/pri1146/e2e/step1-cli-spine.mjs`、`run-full-e2e.mjs`（`.tmp/` 会话工件，不入库） |

## 场景结果

| # | 场景 | 结果 | 关键证据 |
|---|---|---|---|
| S1 | 正常 V2 诊断（真实模型） | PASS | taskId `diag_router-diagnosis_manual_1794229529860_77f0euwj`，run `_3`（前两次结构化 repair 未过，第 3 次过——失败路径真实可见）；Artifact `content_json` 含 `schemaVersion=diagnostician-output-v2`、`trustedContextReceipt(schemaVersion=router-context-v2, canonicalPrinciples.status=available, evidenceRefs=[painId,runId])`、`associationValidation(checks=[{rule-1, linked, references_valid}], semanticCorrectness=not_evaluated)`；3 个 Candidate（principle/rule/implementation）均携带 `recommendationRef` |
| S1b | 重启恢复 | PASS | 新进程重新读取 Artifact envelope，`readRouterContextReceipt` → available（message/systemPrompt/predecessor 摘要全部复验） |
| S2 | Rule → 同次 Principle Candidate（shadow） | PASS | `resolveSourceDeclaredRelations` 对真实运行数据：`status=proposed, basis=source_declared_relation, principleId=3beacf2b…, targetCandidateId=384d6322…, semanticCorrectness=not_evaluated, authorizesGeneration=false`；**未写 ruleCandidateBindings**（S6 起始 before=unresolved 证明） |
| S3 | Rule → 已有 Canonical Principle | PASS | 预置 probation principle 后组合运行：receipt `canonicalPrinciples.principles` 实际包含该 id（可信上下文非空暴露）；associationValidation `linked/references_valid`；任务 succeeded |
| S4 | 错误关联（幻觉 canonical id） | PASS | 未暴露 id 作为 target → `unresolved/principle_not_in_context`；诊断 Artifact 与候选**完整保留**（不静默丢弃），任务 succeeded |
| S5 | 语义正确性不冒充 | PASS | 全部 artifacts `associationValidation.semanticCorrectness === 'not_evaluated'`（结构通过 ≠ 语义通过） |
| S6 | Owner 审批（真实治理路径） | PASS | 经真实 `createRuleCandidateBindingReview`（material 经生产读取路径校验 + 真实 digest CAS）→ `mutateRuleCandidateBinding(bind, authenticated_console)` → `bound`；身份解析 `unresolved → resolved(basis=owner_rule_binding)`；全程无自动批准/激活 |
| S7 | V1 负向（真实 dist） | PASS | `resolveOutputSchema('diagnostician-output-v1')` → undefined；`readDiagnosticianOutputFromEnvelope(V1)` → undefined；`SqliteDiagnosticianCommitter.commit(V1)` → 抛 input_invalid（三路全拒，无隐式 fallback） |
| S8 | 空白数据初始化 | PASS | Phase 6 清零后 `pain record` 在空白工作区完成 schema 初始化并创建诊断任务，全链在空白态跑通（S1 即其产物） |

## 过程中发现并当场修复的问题

1. **PRI-817 家族生产缺陷**（schema-prompt-adapter）：V2 判别联合未被识别，通用合成器产出示例被自家 validator 拒绝（rule 目标指向自身）。已修复为领域感知合成（rule → principle-1，evidenceRefs 可追溯），43 项 adapter 测试 + 快照全绿。
2. 默认 Stage A 夹具的 evidenceRef 与真实 `SqliteContextAssembler` 产出的可信上下文不匹配 → 组合场景按 EP-07 不变量把夹具重绑到父 taskId（这正是生产校验在正确工作）。

## 与验收标准的对照

- 指令 §11 的 8 个场景全部覆盖；Browser Acceptance 不适用——本票无任何 UI 改动（Console 展示面零修改，未引入 Mock API）。
- 真实模型运行的 provider/model/runtime 已记录（见上表）；未以 mock-only 冒充：S1/S1b/S2/S6/S7/S8 的数据全部来自真实 CLI + 真实 SQLite + 真实 Ledger。
