# PRI-1146 Phase 8：Production Dist 端到端验收报告（2026-11-09）

**第一轮（2026-11-09）结论：ALL SCENARIOS PASS（8/8）。** 全部场景运行于当日的 production dist 构建（`npm run build` 全仓产物），无 Runner/Registry/Committer mock。

> **历史分区说明**：本文第 1–4 节保留 2026-11-09 第一轮 8/8 的原始记录，不修改、不冒充。第二轮评审修复后的复验（S1–S18，含 S14–S18 新场景）见文末「第二轮复验（2026-11-10）」。**引用本文件时不得用 8/8 代表当前 HEAD 的结果。**

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

---

# 第二轮复验（2026-11-10）— 评审修复后 S1–S18

第二轮评审提出 P1-01（Telemetry 生产接线）、P1-02（System Prompt Digest）、P2-01（Receipt 跨进程完整复验）、P2-02（Shadow 双来源一致性）四个必修问题。修复后**重新构建 production dist 并重跑全部场景**；下表只记录这一轮的结果，不引用第一轮日志。

## 运行环境与证据锚点（第二轮）

| 项 | 值 |
|---|---|
| 分支 / HEAD | `ai/PRI-1146-diagnostician-output-v2-only`，HEAD `234ebc843`（merge `origin/main` `acf6af406`） |
| 构建 | 全仓 `npm run build` exit 0；`packages/pd-cli/dist/index.js` 构建时间 2026-11-10 13:09:40（本轮场景全部在构建之后执行） |
| 真实模型 | pi-ai / zai / `glm-5.3`（`ZAI_API_KEY`），真实 wire，无 mock |
| 驱动入口 | 真实 `packages/pd-cli/dist/index.js`；组合场景由真实 dist 模块组装 |
| 证据文件 | `.tmp/p101/*.log`、`.tmp/pri1146/e2e/results-*.json`、`.tmp/pri1146/e2e/ws-s1{4,5,6,7,8}`（会话工件，不入库） |

## 场景结果（第二轮）

| # | 场景 | 结果 | 关键证据 |
|---|---|---|---|
| S1 | 正常 V2 诊断（真实模型） | PASS | taskId `diag_router-diagnosis_manual_1794288044516_ic5m4i1b`，router run `_1`，`runtime=pi-ai`；Stage A 第 3 次尝试才通过（前 2 次 `output.valid must be true` 失败记录在 `runs` 表，失败路径真实可见） |
| S1b | 重启后 receipt 读取 | PASS | 新进程 `readRouterContextReceipt` → `available` |
| S2 | Rule → 同次 Principle Candidate（shadow） | PASS | `candidateId=0a0df852-0e52-4148-91d2-5fc85d692f63`，`basis=source_declared_relation`，`authorizesGeneration=false` |
| S3 | Rule → 已有 Canonical Principle | PASS | 预置 principle 出现在当次暴露集合，`assocLinked=true` |
| S4 | 幻觉 canonical id | PASS | `unresolved`，诊断 Artifact 与候选完整保留 |
| S5 | 语义正确性不冒充 | PASS | 2 个 artifact 均 `semanticCorrectness=not_evaluated` |
| S6 | Owner 审批（真实治理路径） | PASS | `unresolved → resolved`，`mutation=bound`，target `05b3acb1-5346-4263-b341-b675f016e8a7`，无自动批准 |
| S7 | V1 负向（registry/reader/committer） | PASS | 三路全拒，无隐式 fallback |
| S8 | 空白数据初始化 | PASS | step1 在重建后的空白工作区完成 schema 初始化并跑通全链（S1 即其产物） |
| S9a/b/c | Prompt 注入（原则文本是数据） | PASS 3/3 | 注入文本不进 system prompt；静态 prompt 跨两次暴露不变；无特权写入 |
| S10a/b | V1 候选来源拒绝 | PASS 2/2 | `owning_output_not_v2` / `artifact_not_v2_envelope` / `recommendation_ref_not_found` 全部拒绝且账本无写入；合法 V2 仍可入账 |
| S11a/b/c | 账本不可读 | PASS 3/3 | typed `ledger_unavailable` receipt + `context_invalid`；重启后 receipt 仍可读（artifact `8ae8fdaf-52f7-4b73-9fb5-9ed52149eae9`） |
| S12a/b/c | 账本损坏 | PASS 3/3 | `ledger_corrupt`（非 `target_missing`），账本未被修改 |
| S13 | 原始遥测落盘 | PASS | `critical-events.jsonl` 1 行：`eventType=diag_router_trusted_context_unavailable`，`traceId=diag_router-diagnosis_e2e-s13-1794288048467`，`reason=ledger_unavailable`，未重写 |
| S14 | `pd pain record` Telemetry 持久化 | PASS | 真实 CLI 第 1 次尝试即触发；落盘事件 `traceId=diag_router-diagnosis_manual_1794287390122_bb84fsaa`，`timestamp=2026-11-10T05:10:14.605Z`，`payload.reason=ledger_unavailable`；非 allowlist 事件泄漏 0 |
| S15 | `pd pain retry` Telemetry 持久化 | PASS | 落盘事件 `traceId=diag_router-diagnosis_e2e-s15-1794287389240`，`sessionId=pd-cli-pain-retry`；非 allowlist 事件泄漏 0 |
| S16 | System Prompt Digest 一致性 | PASS | `receiptDigest == sha256(实际 Provider prompt) == sha256(base prompt) == b85683b24b1a8f1f8980410e42398d5484955d07ae45439d187edcdc788739a6`；`messageDigest` 与重建一致；重建 merged prompt digest 一致（`mergedPromptRebuildMatches=true`） |
| S17a | Receipt 跨进程完整复验 | PASS | 独立进程 `verify-receipt-full.mjs`：`status=available`，`systemPromptDigest`/`messageDigest` 与重建值逐字节一致，`contextHash=ctx-cf5aabc` |
| S17b–h | 7 类篡改负向 | PASS 7/7 | message→`context_receipt_source_mismatch`；system-prompt→`context_receipt_source_mismatch`（重建 digest `018a8158…`）；predecessor-digest→`context_receipt_invalid`；Run/Task lineage→`context_receipt_lineage_mismatch`；predecessor content→`predecessor_artifact_mismatch`；删除 input payload→`run_input_payload_missing`；删除 artifact→`persisted_evidence_missing` |
| S18a | Shadow 双来源一致（正控制） | PASS | `ok=true`，仍只读、不授权生成 |
| S18b–h | Shadow 双来源负向 | PASS 7/7 | V1 run output / 缺失 run output → `run_output_invalid`；不同但合法的 V2 → `run_output_recommendation_ref_mismatch`；recommendationRef 集合不一致 → `run_output_recommendation_ref_mismatch`；artifact envelope 损坏 → `context_receipt_invalid`；run lineage 不匹配（两种）→ `run_lineage_mismatch` |
| S18i | 负向无副作用 | PASS | 无 resolutions、无 binding、无生成授权，持久化状态不变 |

**合计：40 项断言全部 PASS（S1–S8 共 8 项，S9–S13 共 12 项，S14–S18 共 20 项），0 BLOCKED。** S8（空白初始化）不单列断言，其证据是 step1 在重建后的空白工作区完成初始化并跑通全链。

```text
node .tmp/pri1146/e2e/step1-cli-spine.mjs
node .tmp/pri1146/e2e/run-full-e2e.mjs
node .tmp/pri1146/e2e/run-e2e-s9-s13.mjs
node .tmp/pri1146/e2e/run-e2e-s14-s18.mjs
node .tmp/pri1146/e2e/run-e2e-s14-s18.mjs --only=s17
node .tmp/pri1146/e2e/verify-receipt-full.mjs <ws> <taskId> <runId> [profileSystemPrompt] [outputLanguage]
```

## 复验过程中修正的是「验收脚本」，不是「判据」

- S16/S17 的前驱 artifact 原先从 `artifacts` 表查询，但 Stage A/B 产物实际持久化在 `pi_artifacts`（`artifacts` 只放 router 最终产物）。脚本改为按 `runs.input_payload` 里的 `rootCauseArtifactId` / `distillerArtifactId` 读取，断言内容未放宽。
- S17 首跑有 2 个篡改未被识别：`message` 篡改在健康账本下是空操作、`lineage` 篡改改的列不在验证路径上。修正为 schema 合法的 `unavailable` 篡改与 `runs.task_id` 篡改（并在验证脚本中增加持久化 lineage 前置检查），复跑 8/8。
- S14 首跑失败是 Stage A 模型输出未通过结构化校验导致 router 未运行（不是遥测接线问题）；脚本改为最多 3 次真实 `pd pain record` 尝试并逐次留痕，第 1 次即触发。

## 已知限制（本 PR 不修，列为 follow-up）

`validateRuntimeProfile`（`packages/principles-core/src/runtime/config/pd-config-validate.ts`）不解析 `runtimeProfiles.*.systemPrompt`，因此 YAML 中配置的 profile 追加层在 CLI 生产路径上被静默丢弃（`effectiveProfile.layer=null`）。这导致：

- S16 能证明「receipt digest = Provider 实际收到的 base prompt」，但 CLI 路径上不存在第二层可供对照；
- 两层合并的正确性由 `diag-router-system-prompt-digest.integration.test.ts` 的 A–E 五个用例覆盖（空层、非空层、两层同变、Principle 变而静态 prompt 不变、恶意 Principle 不改指令边界）。

这是既有配置缺陷，与本轮四项修复无关；修复它会改变配置语义，超出本 PR 范围。
