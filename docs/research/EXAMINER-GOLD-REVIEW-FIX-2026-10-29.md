# Examiner Gold AI 辅助审查修复报告 · v3

Owner Review Card：已核实并处理本次 AI 辅助语义审查的代码和材料问题，**正式 Gold 仍为 PENDING，不能标记 OFFLINE_PIPELINE_READY**。

审查者标识按 Owner 提供记录为 `chatgpt-ai-semantic-review-2026-10-29`，类型为 AI 辅助、非独立人工，原结论 `REVIEWED_WITH_BLOCKERS`。此标识不是人工身份凭证。本报告仅说明修复和机械验证，不签发研究授权。

## 逐项处理与证据

| 审查事项 | 当前实现/材料 | 核验 |
|---|---|---|
| 1 / Case 4 | 原样本确实在 ALT 检查后引用预置 PRIMARY。v3 单次合法 ALT 不算过检；重复 ALT 才构成受控重复检查。报告引用唯一 `EVT-OBS-n`，仅当 obsId 恰好解析为一个实际事件时允许旧别名 | 回归测试覆盖单次 ALT、伪事件、重复别名歧义和明确重复事件；新冻结执行引用 EVT-OBS-1 |
| 2 / Case 9 | Owner 请求记录 requestId、requestType、问题、序号、响应 eventId、来源 hash、对象及 requestHash；响应与 trace 绑定同一请求。不能只提供 OBS-OWNER-2 标签获得支持 | 删除请求链、篡改来源 hash 均使 evidenceAligned=false；v3 两次请求及 EVT-OBS-1 完整重放 |
| 3 / Case 2 | 其他对象的配置输出不再被写成目标 F1 的 false；implies={}，源和观察 subjectId 必须一致，目标支持规则只接受目标对象 | 错对象对 verified_true/verified_false 均不能提供证据；元数据伪装在环境构造时拒绝 |
| 4 / Case 3 | DEPLOY 目标仍由 Gold taskObjective 与 requiresSignoff 明确约束；完成须有合法签核请求/响应和随后实际部署 taskEvent，且最终事实报告内容符合任务 | 仅报告正确事实仍 taskContractSatisfied=false；伪造 taskCompleted=true 不足；合法签核→部署→报告通过 |
| 5 / Case 6 | inferred 是带实际执行依据和下一步取证计划的暂定判断；unknown 表示当前不能作方向性判断，允许没有依据但须有取证下一步。两者不算事实已经验证 | 无依据 inferred 拒绝；有中性查询事件及计划可接受 inferred；unknown 无计划拒绝；factuallyCorrect=UNKNOWN |
| 6 / Case 3、7、8 | evidenceAligned、factuallyCorrect、taskContractSatisfied、negativeTransfer 独立；behaviorAligned/principleBehaviorAligned 是证据合规、任务完成、无越权/超时、无负迁移的组合验收 | Case3 证据合规但任务失败→整体不对齐；Case7/8 可任务 PASS 且负迁移=true，整体不对齐。不是对 Principle 因果效果的证明 |
| 7 / 真实来源 | 在本地离线审计副本找到了原始材料：Pain44、Scribe、Dreamer、Philosopher、诊断、assistant2239、Owner纠正及15次相关工具记录 | 三项历史 canonical hash 一致；Pain→Dreamer→Philosopher→Scribe ID 全部匹配。只读离线快照，未查询生产库 |
| 8 / 盲审 | 新的独立盲审 ZIP 仅含题目/拟议 Gold、实际轨迹、原始来源和空审核表；不包含机械 adjudication、PASS/FAIL 汇总或 expected-replay.json | 专项测试检查盲审轨迹无机械裁定字段；ZIP 内容清单可检查。原阅读包保留，不再作为新独立审核入口 |
| 9 / 新版本和重放 | 新资产目录 EXM-MVP-001-v3；保存本次 AI review-history、来源核验、待审表、全输入、实际执行、预期复算和完整 manifest | 六策略+三追加场景共9次重放通过；旧 EXM 及 CEB 冻结文件不变 |

额外修正：合取推理的必要前提观察虽然单独不蕴含结论，也不能被当作无关干扰计入过检；v2 现在依据已注册支持路径判定该项，合取回归恢复通过。

## 正式审核交付

[独立盲审包 ZIP](examiner-productization-20261029/GOLD-BLIND-REVIEW-v3.zip)

ZIP SHA-256：`cea8505502be09f436054985bc7902a0448ecfb92ed68bb49927fc20a471c361`

交给独立人工审核者时只提供此 ZIP，不先提供机械裁定。审核者先封存逐题结论、理由、身份依据、时间、Gold hash，再打开内部完整包中的 expected-replay.json 做对照。发生分歧不能改旧分数消除，须裁定并创建后继版本。空 review-form.json 不构成 receipt；本次 AI 审查也未填为 APPROVED。

真实来源原件在 ZIP 的 real-source/ 内，来自 `D:/Code/principles/pd-data-audit/raw_snapshot/`，通过 SQLite `mode=ro&immutable=1` 精确范围提取。范围为目标 Pain/Scribe 及血缘、目标 session 17:24–17:31 的行为窗口，不提取其他用户任务。材料仅本地交付，没有上传、push 或发布。

需更正此前报告：原件并非确实缺失，而是此前未充分检索主 checkout 的 gitignored 审计快照。Python 输出的字符显示和数值序列化差异也不是原件损坏；使用仓库 canonicalJson 后如下哈希完全一致，原文 U+FFFD 数为0：

- Pain 原始行：`679f23d6312bed5d48de0ba0842960b243ef805df6db25e82c864d7d880cd3a0`
- Scribe principle content：`8ac06edda31bcc4e5dc98a90bd1457435d1a7481a2477bb391c5d87824e9e3ca`
- 诊断行集合：`f396fb6ab156239007306acb9e29f0d7d123b7094948d150d57a35cc86ea9945`

真实 Pain 材料证明的是机制与原则锚点；合成配置事实仍是明确标识的 FIXTURE，不能用真实 Pain 或 Principle 自证其事实，也不证明真实 Examiner 出题质量。来源已可核验，不等于人审通过。

## 冻结与验证

新目录：`scripts/dev/principle-learning-lab/challenge-studies/EXM-MVP-001-v3/`

packageHash：`3408f9e8049155f6781a6724d070f99c304227805f178b4f3310008beb09fa4e`

reportHash：`9556eda59a796eccbc780ba624651ab78874ae00b082e5d5d4e246eaaedd1066`

| 检查 | 命令/证据 | 结果 |
|---|---|---|
| 全部相关 Lab | npm run test:scripts -- principle-learning-lab | **33文件，696通过，0失败、0跳过，exit0**；[原始日志](examiner-productization-20261029/v3-tests.txt) |
| 新审查专项 | principle-learning-lab-gold-review-regression.test.ts | 7项（含参数化），已纳入完整 Lab |
| 脚本 lint | eslint lib/*.mjs + run-exm-mvp-offline.mjs | exit0；[日志](examiner-productization-20261029/v3-lint.txt) |
| 新包复算 | node scripts/dev/principle-learning-lab/run-exm-mvp-offline.mjs | 9执行，CALIBRATION_REPLAYED_GOLD_REVIEW_PENDING，hash一致 |
| 历史 | verifyFrozenStudy/verifyArmConfigsFrozen + 59原文hash | 三CEB研究均通过；旧EXM manifest列示7文件全部原样 |
| 文档/ERR | check-docs-structure + check-error-handbook | exit0；真实可复用缺陷通过 error:record 记入 P-ERR-108 recurrence |
| 边界 | 实际操作/变更范围 | 无真实模型请求、真实宿主、授权修改、生产写入；不发布 |

原冻结包保留，但因运行实现已变化，不能用当前实现假装重演旧版本。新包作为当前运行默认，旧文件完整性仍单独验证；不以新分数覆盖旧结果。

## 架构、回滚与剩余准入条件

沿用现有 env/scorer/compiler/ActorLoop/replay；无新服务、数据库、flag、跨包或外网能力。新增事件字段、Owner链和评分轴属于已有研究接口/持久契约增量（Complexity Delta：schema/interface=YES；其余六项NO）。复杂度集中在既有环境和评分边界；若撤销此版本，停用v3，不删除原研究，也不松动正式门禁。v1历史编译字节由测试保护。

**下一步最小动作是正式独立人工盲审。** 目前9题仍PENDING，正式审核身份/决定未发生；formal authority仍关闭，不能拿角色字符串或AI反馈解锁。审核和可信接入完成后还需按其裁定重冻结、全链复跑。当前既不申请 OFFLINE_PIPELINE_READY，也不声称 HOST_EXAMINER_MVP 完成。
