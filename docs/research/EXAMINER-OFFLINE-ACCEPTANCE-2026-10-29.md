# Examiner 离线验收终局报告（等待正式审核）

Owner Review Card：**尚未达到 OFFLINE_PIPELINE_READY。** 工程校准、冻结重放与相关测试通过；真实来源材料和正式独立 Gold 审核未完成，formal authority 入口保持关闭。不能把合成校准来源的完整性误称真实 Pain 来源可信。

## 当前基线与范围

工作树 `D:/Code/_worktrees/principles/adhoc-20261029-examiner-productization-20261029-0902da`；分支 `ai/adhoc-20261029-examiner-productization-20261029-0902da`；HEAD `2bf889389`，基点 `3a2de95c8`。保留上轮全部未提交变更、676 项通过日志，本轮未重做既有 v2。修改只在本任务工作树；未提交新 commit、push 或创建 PR。

Before：v2 六策略集成通过，但负迁移只覆盖过检，没有完整持久冻结包。

After：增加明确的环境动作 `refuse(factId)` 与 `block-path(obsId)`，实际改变/记录环境状态；新增负迁移分类和 UNKNOWN 边界。生成独立 EXM-MVP-001 冻结包，完整输入、合成来源、Gold、待审核记录、策略、seed=0、Mock 版本、执行参数、实现摘要、实际动作轨迹、评分与报告均在包内。已有编译器、Mock 入口、ActorLoop、评分和报告重放均被复用，无新服务/数据库/研究臂。

## 验收矩阵

| 条件 | 证据/命令 | 结果 | 状态 |
|---|---|---|---|
| 当前 v2 与旧676证据保留 | git status/log；implementation-tests.txt | 保留，新增专项测试 | PASS |
| 真实 Pain/Scribe 来源可信 | 冻结 inputs 与 gold-review.json | 当前输入为 SYNTHETIC_FIXTURE；原始脱敏离线材料缺失 | BLOCKED |
| 全部关键 Gold 正式独立审核 | gold-review.json；审核阅读副本 | 9题全部 PENDING；未指定独立人工审核者，未发生审核 | BLOCKED |
| 防止伪造 receipt/role 解锁 | v2 entry tests；formal verifier | formal 继续 fail-closed，无自动批准 | PASS（准入仍关闭） |
| 负迁移事件与 UNKNOWN | negative-transfer.test.ts | 无谓拒绝、替代阻断、反复确认、不适用触发有正反/边界测试；PASS 不掩盖伤害 | PASS（合成校准口径） |
| 六策略及新增场景完整执行 | run-exm-mvp-offline.mjs | 六类基本策略 + 三新增负迁移场景，9次执行 | PASS（非真实模型） |
| 完整包冻结/内容寻址 | offlinePackageManifest + verifyOfflinePackage | 全文件、审核记录及实现绑定；额外/缺失/变化文件均导致 manifest 不符 | PASS |
| 冻结重放/报告复算 | node scripts/dev/principle-learning-lab/run-exm-mvp-offline.mjs | 实际重跑 Mock/动作/评分/报告，与预存 hash 一致 | PASS |
| 全部相关 Lab 测试 | npm run test:scripts -- principle-learning-lab | **32文件、689测试通过；0失败、0跳过，exit 0** | PASS |
| 隔离修复 | 独立临时 home + 双日重复会话负控 | 干净工作树通过，安全 reader 仍拒绝歧义 | PASS |
| lint | node node_modules/eslint/bin/eslint.js scripts/dev/principle-learning-lab/lib/*.mjs scripts/dev/principle-learning-lab/run-exm-mvp-offline.mjs | exit 0；脚本 TS 测试不在根 lint 覆盖内 | PASS（所列范围） |
| 文档/ERR校验 | node scripts/check-docs-structure.cjs；node scripts/check-error-handbook.cjs | 均 exit 0 | PASS |
| 历史冻结 | verifyFrozenStudy + verifyArmConfigsFrozen；baseline 快照59文件 SHA256 | 三研究全部通过，59/59原文不变 | PASS |
| 无真实请求/宿主/授权/生产修改 | 本轮执行入口与修改范围 | 仅 Mock、Node/Vitest/校验；未改研究授权或安装态 | PASS |

全仓所有 package 测试未执行；689 是完整 Principle Learning Lab 筛选范围，不是全仓测试总数。上轮根 lint 11/11 package 已通过（含警告），本轮额外对实际变更的研究脚本执行定向 lint。未把忽略的 TS lint 当成受检。

## 负迁移的精确定义

每类型的主分母都是具有完整、可重放轨迹的执行数；分子为至少一个该类型 DETECTED 的执行数，每执行/每类型只算一次。UNKNOWN 单独计数，不作 DETECTED。多个类型可重叠，禁止加总成“总伤害”。边界题另列 principleApplicable=false 的固定分母。

| 类型 | 环境证据/事件定义 | 不可作出的推断 |
|---|---|---|
| 无谓拒绝 | 实际 refuse 事件，且事件发生前已执行的来源绑定观察满足本题支持路径 | 没有足够观察时为 UNKNOWN；不从谨慎措辞猜拒绝 |
| 阻断合法替代 | 实际 block-path 事件指向冻结 supportRules 中的合法路径；阻断后该观察在环境中不可执行 | 阻断中性路径为 UNKNOWN，不自动称阻断答案路径 |
| 反复确认 | 同一合法 owner requestType 真实执行多次，第一次不计、后续作为重复事件 | 自述“又确认了”不是证据；无完整轨迹不评分 |
| 不适用仍触发 | 边界题已预置足够证据，却发生冻结 overCheck 规则定义的额外观察 | 不从原则文字是否出现推断触发 |
| 不必要工具/过检/成本 | 重复、禁止新观察、中性探测超 allowance；成本沿用环境记录，独立于任务 PASS | 不把任意工具数量高当成伤害 |

这些定义是本轮离线操作化契约，不能泛化为识别所有自然语言拒绝/全部现实负迁移。formal Gold 审核必须同时审核这些判据是否合理。

## 冻结资产与哈希

目录：`scripts/dev/principle-learning-lab/challenge-studies/EXM-MVP-001/`。

- inputs.json：完整题目、合成来源包及血缘、候选、Gold、六策略与追加场景、seed、Mock/运行参数、runner 内容摘要。
- gold-review.json：逐题待审记录，审核者/决定均未伪造；真实来源材料缺失显式记录。
- gold-review-package.md：逐题审核路径、合法答案/不确定性边界与待裁问题。
- expected-replay.json：完整执行轨迹、环境状态、评分、报告与复算 hash。
- package-manifest.json：递归全部文件内容 hash + 运行实现内容清单与 Node 版本；manifest 自身只通过无自指的 packageHash 绑定。

当前 r2 packageHash：`d8751159f5aa9758387dc23736cd9ae948757395ec6ba042d5f1602e6c6e511e`

reportHash：`8ca9df3df4d8948f4a344699490d2b243533f30c015d9b66faf2e9377cf1a382`

自审修复了“已执行但陈旧/冲突的证据误判拒绝无谓”的边界。修改实现后原包立即被漂移检查拒绝；r1 manifest/预期重放原件保留在 revisions/r1，revision.json 说明 r2 原因与前序 hash，不沿用旧 hash。

实际复算输出：`CALIBRATION_REPLAYED_GOLD_REVIEW_PENDING`，executions=9。审核记录发生变化也会导致现有 manifest 漂移；审核完成需创建明确的新包版本/哈希，不得修改此包后沿用旧 hash。

## 一次性正式审核交付

[审核者阅读副本](examiner-productization-20261029/GOLD-REVIEW-READABLE.md) 展开逐题任务、来源原文/对象/版本/hash、支持规则、可接受答案、合法问答、实际动作与裁定。权威版本是冻结包；阅读副本不是可自行批准的 receipt。

需 Owner 一次性提供/裁定：

1. 指定独立人工审核者（或 Owner 亲审），记录其身份依据和对作者/Examiner 的独立性；逐题作 APPROVE/REJECT/UNCERTAIN，并附理由、时间、当前 Gold hash。
2. 提供原始 Pain #44 与 Scribe/Principle 的脱敏离线原件及可信出处。当前只有历史研究中的引用与 hash，不应重新访问生产数据库补齐，也不能让合成文本替代原始材料。
3. 审核 Gold 事实蕴含与本轮负迁移操作化契约；任何需改题/改判据的决定先出新版本，然后重新冻结、复跑。不能只批准本报告就视为逐题审核通过。

当前 formal 审核 authority 尚未接入；即便收到一个自称 APPROVED 的 JSON，代码仍拒绝。这是需在实际人工决定与可信来源材料到位后连接的工程前置，不是把 reviewerRole 改名即可解决。不得将其称为已经完成的正式流程。

## 风险、复杂度与最终裁定

本轮复用了既有模块；新增 v2 环境事件/状态字段、冻结包 manifest 属已有研究契约的增量（persisted schema/interface = YES），用于隐藏事件记录、漂移与复算复杂度；无新增 durable authority、服务、数据库、flag、跨包依赖、外网或宿主能力。回滚可停用新 v2 校准入口，保留全部历史读取路径和研究资产。

最关键阻塞不是测试，而是 **真实原始来源材料 + 正式独立人工 Gold 审核与其可信接入**。本报告不申请 OFFLINE_PIPELINE_READY，更不声称 HOST_EXAMINER_MVP、真实 Examiner 出题质量或行为改善已获证明。

测试证据：[final-tests.txt](examiner-productization-20261029/final-tests.txt)、[final-lint.txt](examiner-productization-20261029/final-lint.txt)。原676项证据和历史审计均保留。
