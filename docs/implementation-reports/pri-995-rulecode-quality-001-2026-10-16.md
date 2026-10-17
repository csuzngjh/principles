# PRI-995 — SPEC-RULECODE-QUALITY-001 v0.2 实施报告（A + B1）

日期：2026-10-16。分支 `codex/rulecode-quality-001`，基于 origin/main `807fcab90`（PR #2048/#2049 已并入，无堆叠依赖）。
SPEC：`docs/specs/SPEC-RULECODE-QUALITY-001-v0.2.md`（验收契约）；评审核实：`docs/specs/SPEC-RULECODE-QUALITY-001-REVIEW-VERIFICATION.md`。
敏感原始材料与完整运行证据保存在本机交付目录 `D:\Code\pd-deliveries\rulecode-quality-001-20261016\`（不入库）。

## 结论速览

| 状态轴 | 结论 |
|---|---|
| A 实现 | **PASS**（A1/A2/A3 全部落地，见下） |
| A 回归 | **PASS**（新增 6 个测试文件/用例组；core internalization、host-runtime、codex-adapter（30/30 worker + 全量）、pd-cli 全量通过；openclaw-plugin 除 4 个干净 main 同样复现的既有环境性失败外全绿，基线证据在交付目录。首轮独立评审发现的 codex-adapter 1 处夹具漏迁移已修复复绿） |
| A 真实生成评审（Q26） | **PASS**（真实 zai/glm-5.3-flash，116.6 秒一轮 approved，对抗回放 0 失败） |
| B1 只读调查 | **DONE**（结论：本机不存在满足 SPEC 8.1 的宿主可信审批来源） |
| B2/B3 | **NO-GO**（8.2 条件 1/2/4 不成立） |
| B4 | **BLOCKED**（依赖 B2/B3；主 prompt 历史批准不可复用为新 RuleCode 批准） |
| 发放 | **未发布**（未发版、未升级生产安装、未激活任何规则；PR 待 Owner） |

## A1 — 生成前意图依据完整性（Q01/Q13/Q14/Q20/Q21/Q22）

- `intent-contract.ts`：新增 `ScribeExecutionConditionsV1`（version:1 + `requiredFacts[{factKind,required,textualBasis}]`）+ 结构校验 + 提取器（区分 legacy 缺席与损坏）。
- `scribe-output.ts` / `scribe-prompt-builder.ts`（契约 v7→v8）：scribe 输出新增可选 `executionConditions`（present-but-malformed 硬拒）；提示词新增 EXECUTION CONDITIONS 指令块（只能基于 Owner-attributed 原文声明，`requiredFacts: []` 合法）。
- 新模块 `artificer-intent-preflight.ts`：消费循环内、证据预检通过后、**构造 runner 之前**运行。判定映射 SPEC 5.3：executable / intent_unverified / intent_conflict / unsupported（trusted_fact_provider_absent）/ needs_evidence（trusted_fact_unknown）/ source_error / source_fault_persistent。停点 → needs_human_review（CAS+读回，出边 `pd runtime internalization retry --confirm`），零生成调用。
- 核查记录 `intentBasisVerification`（任务 metadata 加法、带版本、绑定 scribe 工件/intentContract/executionConditions 摘要、checkedBy=deterministic-preflight）；**证据而非通行证**——每次生成前从当前 scribe 工件重 derive（Q13/Q20 由结构保证）。
- 防御镜像：`ArtificerRunner.invokeRuntime` 在 LLM 调用前重跑同一判定（run-once/CLI 直调不可绕过；PDRuntimeError input_invalid）。
- 源故障退避 `sourceFaultBackoff`（Q21/Q22）：证据源 I/O 与意图源 I/O 共用；1-then-2 周期退避（每周期遇消费减一）、重启持久（state.db metadata）、第 3 次连续 → `source_fault_persistent` NHR 终态（非 Owner 标签）；读取成功清除计数。ArtificerTrustedFactsPort 定义为宿主 seam（SPEC 8.3 形状），生产 Codex 未接（B1 结论）。
- **行为变化（有意）**：code_tool_hook 通道的 artificer 生成现在要求完整意图依据；legacy scribe 工件（含原痛苦两任务形状）停为 `execution_conditions_missing`。prompt 通道豁免不变（既有获批 prompt 原则不受影响）。相关测试夹具已迁移到新契约（断言保留）。

## A2 — 生成与评审增量（Q02/Q04/Q07/Q23）

- `artificer-prompt-builder.ts`（v12→v13）：删除 "closest per-call proxy" 与 "params 里编码的前置条件当证据" 指导（原坏 GLM 产物自填 `owner-design-approved` 的教唆源）；替换为：params 文本是 agent 自述永不是批准证据；无状态规则可读真实 history 但不能创造不存在的事实；不可观察的要求写入 risks 而非代理。新增条件 INTENT EXECUTION CONDITIONS 块（required facts 列表 + 禁止自填替代）。
- `behavior-example-pack.ts`：Q04 **有效输入**冲突检测——比较维度为 toolName+params+ruleContext 全量（键序无关深比较）。仅当两例对规则完全不可区分（相同动作+相同上下文+相反标签=不可满足）时 fail loud；上下文有差异的对（如读前写教学对：同 params 不同 priorReadOfTarget）是实质不同输入、不算冲突，其判别质量归评估器语义审查。Q26 首跑中该检测（初版仅比 action）曾在脱敏折叠场景真实触发；评审后按 SPEC"相同**有效**输入"口径修正为全量比较并补三例单测（同输入拒/上下文差异过/全同拒）。
- Q02/Q23 负控测试：原坏产物（substring 自填批准逻辑）在真实生产回放 deps 下被拒（三缺陷全现：自填标记放行/git -C 漏拦/只读搜索误拦）；脱敏真实 Codex 载荷经生产与回放两入口 action 语义逐项一致（命令文本保持命令文本、空路径为 "" 非 null——不写不存在的 null 负控）。
- Evaluator 既有防护（LLM 自报剥离、真实沙箱、缺 gateDeps 失败关闭、repair 环）**未改动**，由 Q26 真实链与既有回归共同覆盖。

## A3 — 运行时强制暂停（Q10/Q19/Q24/Q15）

- `production-rulehost-gate.ts`：V2 隔离从 `!context` 收紧为 `context === undefined || context.history.status !== 'available'`；sentinel 与合法 unavailable 以引用同一性+故障种类区分，警告携带 `provider_absent/provider_returned_undefined/provider_invalid/provider_failed/history_unavailable`。逐调用逐规则跳过，不动治理状态；健康 V1 照常执行；shadow 跳过不影响 live。deadline 早退补 `evaluatedLiveRules: 0` 观测（Q24，隔离 probe 曾指出该缺口）。Codex 无 provider 路径保持暂停（codex-adapter 290 测试通过）。
- **行为变化（有意，SPEC 7.1 明确）**：provider 坏对象/抛异常/合法 unavailable 时 V2 规则以前会执行，现改为强制跳过。既有 provider 异常测试断言已扩展（原"故障可观测"期望保留 + 新增暂停断言）。

## B1 结论（详见交付目录 B1-AUTHORITY-AUDIT.md）

只读调查生产 state.db（23 表）、Codex 宿主面（sessions/config/runtime）、私有库。PD 自有 approvals 全为 prompt 通道激活批准（对象≠开发设计批准）；intent_decisions/activation_decisions 空；宿主无 trustedFacts/ruleContextProvider 表面；会话流无结构化决定对象/绑定/撤回。8.2 条件 1/2/4 不成立 → **B2/B3 NO-GO，B4 BLOCKED**。原痛苦两 artificer 任务 failed×3 未动（无生产恢复授权）。

## Q26 受控正例（真实链）

隔离工作区（.tmp，非生产）：可观察事实 = 真实轨迹行（负例：写 /etc/config/app.conf；正例：写工作区 tmp 草稿）。真实装配 → 意图预检 executable（记录含全部摘要）→ 真实 zai/glm-5.3-flash（profile 原值：timeoutMs 600000 / maxTokens 32000 / reasoning low，密钥仅经环境变量）→ runAdversarialLoop 一轮 approved（116.6s），5 个规范对抗用例 + Owner 标注全过。生成代码忠实意图（拦风险路径/脱敏占位/绝对系统路径，放行工作区，context 不可用按 v2 契约 allow）。产物在交付目录 `q26-evidence/`。

## 验收矩阵（Q01–Q26）

| ID | 结果 | 证据 |
|---|---|---|
| Q01 | PASS | 循环级 T-I1 + 单元：legacy scribe → NHR execution_conditions_missing，runner 零调用、零 run 行 |
| Q02 | PASS | `original-bad-artifact-negative-control.test.ts`：真实生产回放拒坏产物（自填标记/git -C/只读搜索三缺陷） |
| Q03 | N/A-B | 四态契约已定义（TrustedFactResolution），B2 NO-GO 无宿主可验证 |
| Q04 | PASS | pack 冲突检测单测 + Q26 首跑真实装配器触发实录 |
| Q05/Q06 | 部分（Q23 覆盖载荷语义一致性；生成侧误拦由 Q02 负控钉死） |
| Q07 | PASS（提示层）：编码前批准不可缩成提交检查——A2 文本 + 意图门结构性保证 |
| Q08 | N/A-B | 权威 not_required 需来源（B NO-GO） |
| Q09 | N/A-B | 血缘负控需 provider（B NO-GO） |
| Q10 | PASS | `production-rulehost-gate-v2-isolation.test.ts` 9 例（正控+5 故障路径+deadline 逐路断言） |
| Q11 | PASS（既有机制+Q26 实证）：首跑 rejected（path-boundary 独立反例拒掉 substring 规则，2 轮耗尽）正是"自测通过、独立反例失败不进审阅" |
| Q12 | PASS（既有回归未动；evaluator-runner 剥离/缺 gateDeps 关闭保持） |
| Q13 | PASS | 记录换材料失效单测（篡改 scribe 工件后旧记录不放行） |
| Q14 | PASS | 重复停点幂等单测（CAS 读回一致） |
| Q15 | PASS | gate 级 no-provider 暂停断言 + codex-adapter 全量绿 |
| Q16–Q18 | N/A-B | 依赖 B/正式激活授权 |
| Q19 | PASS | V1 继续 + shadow 不影响 live 两例 |
| Q20 | PASS | T-I4 直调 runner 防御镜像（LLM 调用前拒）+ 记录非通行证单测 |
| Q21 | PASS | 退避计数/跳过消费/成功清除单测（跨 handle=跨重启） |
| Q22 | PASS | 第 3 次连续 → source_fault_persistent NHR（detail 含故障，非 Owner 标签） |
| Q23 | PASS | `codex-payload-action-parity.test.ts` 5 载荷两入口一致 + 语义钉死 |
| Q24 | PASS | deadline/降级路径 evaluatedLiveRules=0 + no_rules_armed 断言 |
| Q25 | PASS | 意图记录摘要绑定 + Q26 报告含基线/profile（无密钥）/包路径 |
| Q26 | PASS | 交付目录 q26-evidence/（116.6s 一轮 approved，对抗 0 失败） |

## 复杂度增量与回滚

New durable truth: NO；新持久状态: YES（intentBasisVerification/sourceFaultBackoff，任务 metadata 加法、带版本、损坏 fail-closed）；新子系统/新 flag/新跨包依赖/新外部能力: NO；新公共面：core 内部扩展 + trustedFacts seam（如实列 YES 项见 PR 卡）。回滚：PR revert；metadata 字段为加法，旧读端忽略；未支持新契约的规则按 A3 暂停。

## 已知边界与 follow-up（未入本 PR）

- 证据脱敏会把工作区外绝对路径折叠为占位符——path 型 /etc 原则的 Owner 样例判别力受限（Q26 通过"工作区外一律拦"语义绕开；改进脱敏保判别力立 follow-up）。
- 5 个规范 v2 对抗用例以读前写家族为默认语义，非 helper 正例路径的 .bak 变体期望 block——其他写类原则需评估适用性（既有行为，未改动）。
- openclaw-plugin 4 个既有环境性失败（workbuddy resolver×2、ledger EPERM×2）与 tar flaky：干净 main 复现，基线证据在交付目录。

## 独立评审与修复记录（2026-10-16）

独立子代理双轴评审（Standards/Spec）初裁 REQUEST CHANGES，全部 P1 已修、P2 处置如下：

- **P1-1（已修）**：codex-adapter `workspace-worker.test.ts` PRI-992 用例夹具漏迁移（无 scribe 依赖 → 意图预检 scribe_dependency_unresolved）；已补 succeeded scribe 依赖+完整意图依据工件，30/30 复绿。教训：跨包消费者套件必须在其依赖包 dist 重建后复跑（首轮全绿跑在旧 host-runtime dist 上，verify:merge 不含 adapter 套件的既有盲区再次确认）。
- **P1-2（已修）**：Q04 比较维度收窄为 action+ruleContext 全量（见 A2 节），补上下文差异教学对单测。
- **P2-3（已修）**：恢复 V2_CONTEXT_INSTRUCTION 标题行意外丢失的换行（v13 意外突变）。
- **P2-4（记录不改）**：runner 防御镜像口径 `channel !== 'prompt'`（覆盖 skill/defer_archive/null）宽于消费循环的 code_tool_hook 守卫——skill 通道 artificer 若达运行将以 input_invalid 响亮失败而非 NHR 停点；两入口都零生成、不静默，差异属可接受边界（skill 通道当前非 MVP-enabled）。
- **P2-5（已修）**：resolveScribeArtifact 弃用 cast，stateManager 参数类型扩为含 piArtifactStore 公开 getter；与 runner buildContext 的依赖遍历同构仅靠注释约束，漂移风险已知（预检每次重 derive 保证核的是当前工件）。
- **P2-6（记录）**：scribe 提示声称 executionConditions REQUIRED 但校验器允许缺席（legacy 兼容）——遗漏在下一阶段以 execution_conditions_missing NHR 两段式浮出，需重跑 scribe；有意设计。
- **P2-7（已修）**：executable 记录 CAS 失败时 recordPersisted=false 进入遥测 payload（rc-9）。
- **P2-8（已修）**：SPEC v0.1/v0.2、评审核实、执行边界文档随本分支提交（docs/specs/）。
- **P2-9（已修）**：assessIntentBasis 撤出公共 barrel（runner/测试直接文件导入）。

## 最终上游材料停点修复（2026-10-17）

修复共享 resolver 将损坏 JSON、空白内容或仅含身份字段的对象包装为有效依据的问题。只从正式 Philosopher 正文字段及既有 analysis 形状收集材料；无有效正文返回缺失，assessment 同时拒绝空白投影。消费预检与 Runner 防御继续复用同一实现，不增加审批权威或持久状态。

验证：7 项真实 SQLite/store→resolver→preflight 负控在修复前全部失败，修复后通过；相关 core 三文件 104 项、host-runtime 四文件 27 项全部通过，core 重建、修改文件 ESLint、ERR 记录检查通过。独立静态复审无新增阻断。完整合并门禁由正常推送 hook 执行，远程 CI 以最终提交为准。

复杂度增量：本次窄修复所有项均 NO。既有审批语义识别与两层模型重述的能力边界保持披露，不将材料非空误称为原意完整证明。未修改生产状态、安装文件或激活规则；B 的 NO-GO/BLOCKED 结论不变。
