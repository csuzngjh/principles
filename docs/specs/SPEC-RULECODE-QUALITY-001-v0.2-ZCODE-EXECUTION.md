# ZCode 后端执行指令：SPEC-RULECODE-QUALITY-001 v0.2

> 给 Owner：将本文件全文作为 ZCode 新会话任务消息发送。它自带背景，不依赖旧聊天。技术要求以同目录 v0.2 SPEC 为准。发送本指令表示批准下列既定设计与工程范围，不表示批准任何新原则/规则或生产激活。

## 1. Owner 授权与执行模式

我批准你按以下 SPEC 完成本轮工程实施：

`D:\Code\principles\docs\specs\SPEC-RULECODE-QUALITY-001-v0.2.md`

自主完成调查、实现、回归、纠错、独立审查、真实候选生成验证、提交、推送、建 PR、CI 收敛和中文交付报告。不要只输出计划，不要停在某个切片，不要把代码留在本地。

**后台运行全程不向我询问、不请求方案审批、不等待选择。**本指令已批准 SPEC 中的明确设计。工程内常规选择由你依据代码和 SPEC 决定。请不要发送“是否继续”“请确认”“需要你批准才能做下一步”等会挂起本次任务的消息。

遇到无法取得的外部事实/权限或超出范围的新设计，采取下文确定性处理：记录该分支 BLOCKED 和证据，继续独立工作；任务结束给出真实结果，不现场提问。不要为消除阻塞伪造批准、降低质量门、绕过工具权限或扩大产品边界。

授权范围：

- A 全部工程和 B1 只读调查必须完成。
- B2/B3 默认 NO-GO，仅当 SPEC 第8.2节全部资格已被实际证据证明，才可自主执行本文已批准的条件设计；不需要重复询问。
- 原数据的只读快照、隔离候选安装、单目标候选生成/评审、负控测试，均已授权；测试夹具只能位于隔离环境。
- 可提交推送任务分支、创建/更新 PR、中文 Linear 更新；不合并 PR、不发公共版本、不升级生产安装版、不改生产配置。
- 不批准/拒绝/替换/激活/停用任何生产原则或规则；不执行原生产任务恢复，不重启会消费其他痛苦的全局 worker。
- 既有主 prompt 的批准不能复用为新 RuleCode 的批准。正常到达产品审阅入口可以交付，但不得通过询问 Owner 来挂起本次工程任务。
- 不修改 ZCode、其启动器、权限配置、系统级提示词或主开发环境。

## 2. 背景：你在修什么

PD 是 Owner 治理的 AI 行为内化系统。本次原痛苦来自“复杂变更未经设计确认就实施”。生成 JavaScript 成功不等于忠于原则，也不等于规则已在宿主生效。

原信号：`manual_1791868470372_8c47edyh`。

- 生产工作区：`C:\Users\Administrator\.codex\pd-workspace`。
- canonical runtime：`C:\Users\Administrator\.pd\runtime`；安装器拥有，禁止直接改文件。
- 主 candidate：`fe766b65-81e5-48cd-9236-19d75cb140ed`。
- 主 ledger：`ce2b7885-a9ea-4f6e-94da-b0e6c9b85110`。
- 优先 Artificer：`artificer-52d98a96-65b9-4952-82c5-51ba2d853c53-code_tool_hook`。
- 另一 Artificer：`artificer-406f6131-5a28-4d17-9a7f-a18298d48bd0-code_tool_hook`，只读单列。

已经验证：GLM 5.3 Flash 在原数据隔离副本里约69秒产出代码；代码却用自填 `owner-design-approved` 字符串充当批准，还误拦只读搜索、漏拦Git变体。旧的“五例通过”不足以证明正确，扩展六例也不是有效的模型能力评分，其中有隐藏事实没有进入输入的案例。

共享 gate 还有一个隔离缺口：provider 坏数据/异常会转为 truthy unavailable 对象，依赖 V2 的规则仍可能执行。当前 Codex 没有 provider，V2仍暂停，不能把共享负控复现称为生产 Codex事故。

现有规则生成、Evaluator、沙箱、防模型自报passed、修订和Owner治理能力都应复用。修的是接线、条件和具体缺陷，不重建系统，不建设开发审批平台。

## 3. 必读与执行目录

依次读取：

1. `D:\Code\principles\AGENTS.md` 与新工作树适用规则；保留仓库治理要求。
2. 上述 v0.2 SPEC 全文，这是验收契约。
3. `D:\Code\principles\docs\specs\SPEC-RULECODE-QUALITY-001-REVIEW-VERIFICATION.md`。
4. 需要复现原产物时再读 `ZAI-RULECODE-RESULT.md`、`REVIEW-RF01-RF03-PROBE.mjs/.json`、`REVIEW-ZAI-RULECODE.mjs` 及 `rulecode-zai-copy-1792127239446` 目录。
5. 仓库相关当前ADR、Error Pattern Index及所命中的ERR；不要全量加载历史档案。

主目录 `D:\Code\principles` 有无关工作，不能 reset/clean/stash 或直接覆盖。创建独立 worktree 和 `codex/rulecode-quality-001` 任务分支；若同名已存在，核实归属后复用本任务分支或追加短后缀，不改别人分支。

旧只读参考工作树：`C:\Users\Administrator\.codex\worktrees\codex-rulecode-recovery\principles`，已审HEAD `e2ecbdd0a1adb528606df14bcd46ac3c6010e342`。不要把它默认当作新写入目录。

报告和测试输出存入新目录：

`D:\Code\pd-deliveries\rulecode-quality-001-20261016`

目录若存在，先判断是否本任务未完成记录；续接，不覆盖历史。所有实际源码修改位于任务worktree；测试SQLite仅位于隔离目录，禁止直接写生产state.db。

## 4. 步骤与完成条件

### 步骤1：固定基线和依赖

读取 git status/log/remotes，获取最新远端，记录 main、任务分支和实际依赖。

重新查询 PR：

- #2048：`https://github.com/csuzngjh/principles/pull/2048`，历史HEAD e2ecbdd0a。
- #2049：`https://github.com/csuzngjh/principles/pull/2049`，历史HEAD a0175c9299。

已合并则使用当前main，未合并则检查真实diff及本任务必要依赖。可在隔离任务分支集成已审且必需的提交，或采用明确标记依赖的stacked PR；不得合并这些GitHub PR、强推其分支或重复实现已有能力。集成失败时自行解决本任务范围内冲突；无法解决的依赖写入报告，继续其他可验证工作。

搜索相关 Linear 现有事项，按仓库 linear-cli 的 context/start/handoff 操作；匹配不到可建一个中文任务。跟踪器不可用时落地待补记录，继续代码工作，交付如实列明缺项。

生成 `SOURCE-AND-PLAN.md`：每项需求的现有能力、数据/契约、生产者、消费者、已有测试、缺口、拟修改位置、预算和验证方式。禁止从SPEC文字推定能力已存在。

### 步骤2：先建立有区分力的回归

优先复现并锁定 SPEC Q01、Q02、Q04、Q10、Q19、Q20～Q24：

- provider坏对象、抛异常、合法unavailable时，旧gate仍可能调用没有自保护的V2规则；修复后不能调用。
- undefined、provider缺席、整体deadline分别断言真实路径；不要把所有异常合成一类。
- 不依赖V2的健康规则继续；shadow不影响live；无activation治理变更。
- 原审批原则缺事实/意图依据时零生成调用；生成器漏报依赖不能获得豁免。
- 源I/O故障与Owner缺样例分开；有限技术重试不消耗模型预算且跨重启有效。
- 使用真实Codex脱敏载荷，核对当前共享builder的空字符串/命令行为，不写不存在的null提前放行负控。

保留修复前失败和修复后通过证据；不得删除旧业务断言或弱化feature期望。

旧probe和生成脚本可能把repo路径固定为旧参考worktree。复现旧基线后，应在新报告目录建立候选副本或参数化脚本，指向本任务真实构建，记录源码/加载文件摘要；不得一直运行旧dist却宣称新修改已验证。原证据脚本保留不覆盖。

### 步骤3：实施 A，全链纠错

按SPEC第5～7、9节完成前置核验、生成约束、运行时暂停、独立验证和故障状态。先读immediate callers、exports、store和schema；新metadata有runtime guard、来源绑定、加法兼容和round-trip测试。

现有“剥离LLM自报adversarialResult”、真实沙箱、缺gateDeps失败关闭、repair及Owner批准链保持原权威；不复制模块。

由你自行解决实现过程中常规设计细节，保持最小改动。相邻无关问题记录follow-up，不加入本PR。真实复用型错误按仓库ERR机制记录，不手写记录树。

### 步骤4：完成 B1 并执行确定分支

只读调查本机宿主真实审批来源，输出 `B1-AUTHORITY-AUDIT.md`：已查位置、真实字段、身份/对象/版本/范围/撤回证据、读取路径、当前动作绑定及权限。

逐项填 SPEC 8.2 的五项资格，每项必须有证据：

- 全部具备：实施现有seam内的B2/B3，完成来源失效与逐规则启用负控，再做隔离原数据真实生成/评审。
- 任一缺失：B2/B3标NO-GO，B4标BLOCKED，具体指出缺什么；不向Owner提问、不假造事实、不新建审批系统。继续步骤5～7。

即使B具备条件，本次也仅在候选/原数据副本中验证，不执行生产规则治理或生产恢复。

### 步骤5：证明 A 真能生成合格规则

必须完成 Q26：构造一个基于现有可观察事实、意图清楚、标签一致的隔离受控原则，真实调用既定GLM生成，再走真实Evaluator/独立回放/修订链。不得用预写代码、seeded approved结果、只运行validator或全部拒绝生成来替代。

使用已有ZAI凭据，不打印密钥、不修改生产profile。候选配置读取并固定现有有效profile；profile不可用时记录具体错误，不改用其他模型。

模型预算遵守SPEC：不新增分类模型调用，不增大超时、轮数、repair上限。独立测试不调用LLM。缺凭据、provider持续故障或正例未通过时，A运行验收标PARTIAL；继续交付实现、测试和PR，不编造成功。

原坏产物要在对应的有效反例中被拒绝。不要把“相同输入但希望不同结果”的案例当规则得分。

### 步骤6：评审与交付检查

对真实diff运行error:context，完成 Standards / Spec 两轴自查；有子代理时可分工审查。修复所有本任务相关阻断，不以“评审发现”扩大产品范围。

先跑相关公共入口、store、CLI/parser（若改）、宿主集成、跨包消费者及既有BDD，再跑完整 `npm run verify:merge`。测试命令从实际package脚本读取，不凭文档猜。机器内存不足时使用合理堆设置并记录，不跳过检查。

核对changeset/release-intent，尤其installer是否真正打包修改；不能给私有包添加不合法changeset。可用正规installer将候选装到隔离目录并核实实际加载字节/路径；禁止覆盖安装版试验。

测试失败循环处理到相关问题收敛；无关既有故障给出基线对照和明确未过项，不删测试、不降阈值、不使用no-verify、不隐藏codecov失败。

### 步骤7：提交、推送、PR、CI与报告

将本次SPEC/执行边界和可公开实施报告纳入任务PR中的文档位置；敏感原始材料留本地，公开只保留脱敏最小证据。

分批形成少量语义清楚的提交，不反复堆砌修补提交；不要为整理历史重写其他人远端提交。完成commit和正常push，创建/更新中文PR；明确依赖PR、最终范围、验证和A/B状态。工具可用时attach PR；Linear按handoff置In Review并附中文证据。

查询当前HEAD的review/check，修复本任务相关失败并推送，直到所有本任务可解决的阻断收敛。GitHub瞬时失败有限重试；持续不可用记录请求和本地SHA。远程CI长时间无进展时做有界等待（最多20分钟），记录run链接和pending，不让后端无限等；不得将pending称PASS。

最后重新核实：本次文件已commit、远端SHA一致、PR指向当前HEAD、未提交改动逐项解释、worktree租约正确释放。保留有用工作树和审计证据，不擅自删除含未交付文件的目录。

## 5. 子代理和上下文

若本地工具支持子代理，可把定位、夹具整理、独立审查交给较省额度模型；主代理负责权威判断、生产边界、集成和最终证据。没有子代理就顺序执行，不因此中断。

每个任务worktree最多一个写入者；独立代理只读共享，或用单独worktree交回提交。禁止并发重建同一dist或共享node_modules。不要要求子代理作Owner治理决定。

每个显著步骤更新 `CHECKPOINT.md`：已完成、已验证、未决、当前SHA、下一条具体动作；接近会话预算就先保存续接信息，若宿主支持自动续接则继续。不得因上下文切换遗失commit/push/PR步骤，不要求Owner重新讲背景。

## 6. 不询问时的阻塞处理

| 情况 | 自动处理 |
|---|---|
| B无权威来源/逐规则资格 | 标B BLOCKED，交付来源报告，继续A及PR |
| 需要新产品架构/新外部授权 | 停该分支，写必要后续设计，不擅自实施、不问答 |
| 新规则待Owner批准 | 交付审阅工件入口和pending状态，不自动批准，继续工程收尾 |
| 凭据/服务/网络不可用 | 有限诊断重试，记录未运行的验收，继续独立工作 |
| 自动审批/工具权限拒绝 | 不绕过；记录被拒动作和原因，继续可执行范围 |
| 环境与文档不一致 | 以当前源码/契约/真实运行证据核实并记录漂移，不凭旧路径盲改 |

“不询问”表示自主决策和清晰退出，不表示允许捏造事实、跳过治理、修改安全策略或报告虚假完成。

## 7. 最终报告格式

输出 `IMPLEMENTATION-REPORT.md`、`ACCEPTANCE-MATRIX.md`、`B1-AUTHORITY-AUDIT.md`、`DELIVERY-RECEIPT.json` 和必要日志/候选产物。

最终答复用简单中文，必须列出：

1. A：实现/测试/真实生成评审分别PASS、PARTIAL或BLOCKED，不能合并成一句“测试全绿”。
2. B1结论及B2/B3资格结果，B4处于未恢复/副本通过/review-ready哪一级。
3. 已修什么、用户影响、剩余实际缺口。
4. Q01–Q26逐项证据层级和未运行原因；若A与B范围不同，明确标注适用段。
5. commit、远端SHA、PR、当前HEAD CI、Linear、报告绝对路径。
6. 正式用户更新状态：本次默认未发布、未升级生产、未激活新规则。

只有A和B1的所有必需项实际通过并完成远端交付，才报告“本轮工程交付完成”；若B阻塞，同时明确“原痛苦RuleCode仍未闭环”。缺真实生成、必要测试、push或PR等任何交付项，就报告PARTIAL并列明，不能用一段总结掩盖。

现在开始执行。不要再回复一个等待批准的计划，按上述步骤持续工作到可执行范围完整交付。
