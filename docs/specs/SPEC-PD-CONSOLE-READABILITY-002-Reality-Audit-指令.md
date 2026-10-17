# SPEC-PD-CONSOLE-READABILITY-002 v1.1 — Reality Audit 执行指令

你是 PD 仓库中的**只读架构及产品契约审计主代理**。Owner 现在只授权 **Reality Audit**，**没有授权实施、修复、提交、创建 PR、合并或更新 Linear**。

## 0. 输入、目的、硬边界

- 目标文档：`SPEC-PD-CONSOLE-READABILITY-002-v1.1.md`（Owner 随本指令提供；如文件未放入仓库，直接使用消息附件/内容，**不得自行创造旧版或猜测路径**）。
- 目标：验证 SPEC 的每一项关键技术断言是否与**当前本地仓库**、生产调用链、既有治理权威和测试真实一致；找出“已实现但未接通”与“确实缺失”的最小差距，给出**是否可以实施**的审计裁定和对 SPEC 的最小必要勘误。
- 绝对禁止：修改源码、配置、文档、测试、数据库、Owner 原则/审批/激活状态；禁止批/拒/替换/停用真实对象；禁止提交、push、建 PR、merge、改 Linear；禁止写 `~/.pd/runtime`、OpenClaw 安装目录、真实 workspace `.pd` / `.state`；禁止为了调查修补安装构建。
- 禁止自动生成新架构/新摘要/新 API 来“证明可做”；审计只发现事实，提出可选的最小改动建议。
- 如需持久化审计记录，只存本地临时目录（仓库外或 gitignored 已知临时目录），不提交；报告中不输出真实 token、原始 prompt、完整轨迹、绝对隐私路径或私有指南全文。
- 不准因缺少访问权限就跳过这一限制。必要数据、用户令牌、安装构建或私有文档无法安全读取时标 **BLOCKED / UNKNOWN**，不得猜测。

## 1. 启动前核验（由主代理负责）

在本地找到 PD 仓库，以**只读方式**记录：当前时间、工作目录、`git status --short`、分支、HEAD SHA、origin/main SHA（若已能读取；不要求 fetch）、最近涉及 Console/治理的变更。不能清理/切换/覆盖用户已有工作树；不能假定历史基线 `b0f807b9` 就是当前版本。先阅读：

1. `AGENTS.md`（权威）、`docs/product/PRODUCT_IDENTITY.md`；适用 ADR（检查状态、修订和 supersede）。
2. `docs/specs/SPEC-PD-UIUX-001-website-console-upgrade-v1.0.md` 与对应实施/验收报告；确认哪些状态语义、移动端、证据与语言切换已有能力。
3. 私有情绪价值指南（按照 AGENTS.md 所述路径，仅阅读，不复制私有正文）；`ERROR_PATTERN_INDEX`、相关错误手册与测试/PR 纪律。
4. v1.1 所列 E1～E15，逐条标 **VERIFIED / PARTIAL / OUTDATED / CONTRADICTED / UNKNOWN**。不要把截图、注释、报告或当前 `main` 自动当作安装运行版本证明。

**先检查** `npm run error:context -- --paths packages/pd-console/src/ui/pages/focus packages/pd-console/src/server/models/ApprovalsGroupedConsoleModel.ts --signals readability i18n evidence lineage` 的脚本副作用；确认只读后执行 Pass 1，按实际命中分析 EP-01/03/06/09/11/13。Pass 2 只有未来实施 diff 出现后才需要，本阶段**不伪造 Pass 2**。不得为了跑命令安装依赖或改持久状态。

## 2. 并行组织（上限严格约束）

采用 **主代理 + 两名并行只读子代理**；同一时刻最多 2 名子代理，加主代理总计 3 条工作流。绝不再开下一层子代理。若宿主不支持子代理，主代理顺序执行同样审计，不跳项。

**子代理 A：审批目标、artifact 内容与治理权威。**

- 沿 `approval record → artifact → principle lineage → ApprovalsGroupedConsoleModel → HTTP/API → 两层 validators → Focus/Principle detail 操作` 画实际生产链。
- 分类列出 `principle`、`scribe`、`rule`、`philosopher`、`dreamer` 以及实际存在的其他 artifact kind：真实短标题、说明、规范性审批全文分别从何字段取；哪些只是注释/标题/候选片段，何时缺失。不得从拼接字符串拆冒号或 `�?` 来猜语义。
- 特别核实 `ApprovalGroup.records`：`principleId` 分组、首个 pending artifact 的 `candidateDescription`/`fitsPromptBudget`/revisionReview、`records[0].channel`，与批准、拒绝、替换循环目标的关系；确认不同行为通道的可撤销性和预算是否可能被第一条代表。
- 对同一 principleId 下不同 artifact/version/channel/status，构造**只读证明或隔离测试 fixture 计划**。说明现有分组操作是否被权威契约授权、是否原子、部分成功怎么返回、是否存在 version/hash/expectedArtifact guard。明确何种情况需要逐目标 UI，何种情况现有分组可安全保留。**不在真实 Owner 数据上做动作实验**。
- 核查 `allowedActions`、治理锁、revision intent confirm、版本一致性、`editApproval` 参数和后端 parser/validation/失败语义；检查 Activation 页既有“创建可注入新版本”能力能否合法复用于待审场景，避免错误推广。
- 输出带 **文件:行号 + 调用者/被调用者 + 契约类型/测试** 的事实和 P0/P1/P2 风险清单。

**子代理 B：阅读/证据/路由/双语及浏览器测试能力。**

- 核对 Focus、OwnerDecisionCard、PrinciplesPage、PrincipleDetailPage、ActivationPage、PainPage、PageShell、locale、validators；梳理标题/正文、Owner narrative、Semantic Selector、readability warnings 的复用条件和真实消费者。
- 实查 `EvidenceChainConsoleModel`、EvidenceChain DTO、已有 lineage resolver、`fetchEvidenceChain`、Pain 页面路由/展开行为。解释 linkedPainId/linkedTaskId/linkedCandidateId/linkedPrincipleId 的可信范围；原则级历史关联是否能对应具体审批 artifact 版本。寻找已有精确深链（如 Activation 的 activationId）作为**现有模式参考**，不能误认为 Pain 已有同类能力。
- 统计 `group.records.length` 的确切含义；行为证据/receipts 现成计数、时效、覆盖、降级语义；确认无记录≠查询失败≠未知。
- 确认是否存在乱码静态字节/动态真实值，`title+statement`、`principle+rule` 生产边界；长 500/2000 字、换行、特殊字符/HTML-like 内容的安全渲染、i18n、ARIA、主题、320/390/1280/1440、实际 200%/400% 缩放是否有现成测试。
- 识别 UIUX-001 已解决的部分，不新增重复状态源或通用格式化/摘要库。输出精确文件行号、现有测试位置、缺口与最小方案，区分 verified 与 inference。

**主代理自己负责：** 约束/ADR/产线真相核对、与两代理结果冲突的复查、测试脚本及前置条件、风险等级、v1.1 逐项适配、最后的裁定与 Owner 问题。子代理结论不可未经原始证据复核就提升为 VERIFIED。

## 3. 主代理必须回答的十个问题

1. 当前 HEAD 与 SPEC 的 E1～E15 哪些一致、哪些过时？能否确认当前安装版本？
2. 是否已经有**真正的短标题**和有来源的 Owner 易读说明？按 artifact kind 的覆盖条件是什么？
3. 哪些展示文本确实属于可被批准的**完整规范性原文**？哪些只是部分提取/注释/标题？缺失时现有契约怎么处理？
4. 在同原则多版本/多通道下，Owner 当前看见的内容与实际操作的 `approvalId`、`artifactId` 是否一一对应？是否存在**批准 A 时实际也批准 B**的生产路径？
5. 部分成功、旧版本、治理锁和安全预检的真权威在哪里？能否只做 UI 调整且不改批准语义？
6. 现有 lineage 可以达到**具体证据身份**、**具体原则**、还是**具体 artifact/version** 哪一级？每一级允许哪些用户可见声明？
7. `PainPage` 是否已经消费精准定位 URL 参数？如果没有，最小应补哪条消费链、哪些负向降级？
8. `PrinciplesPage`/详情/Focus 是否有相同原文重复出现在标题、摘要、依据？哪些已有 Owner narrative 可准确替代，哪些不可？
9. R1～R7 是否会要求新增 durable truth、schema、服务、public interface、写权限、变更通道，或者触碰安装运行时？给出实际 Complexity Delta 预测而非照抄 NO。
10. 最小可执行整改应怎样切片以确保没有误批准、错误证据关联、状态误导，并避免重复建设 UIUX-001？哪些问题必须升级 Owner 裁决？

## 4. 安全核验方法与禁止的捷径

- 优先静态代码与现有测试/fixtures 的只读核查。允许在**确定无真实状态写入且已有隔离测试配置**的前提下运行定向单测/只读验证；需要创建数据库、启动服务、覆盖缓存或清理构建时先确认隔离路径与副作用，否则在报告中列为“计划中的验证，未运行”。**不要求本轮执行全量 build/test:e2e/verify:merge**。
- 若有 Owner 授权的运行中 Console 可只读浏览：记录 URL/界面构建线索、各页面信息与截图；不得输入、重置或提取 token，不得点击批准、拒绝、替换、停用；无法认证就如实标记，而非绕过。
- 不准用页面文案、候选标题或数组顺序推断 artifact/证据关联，不准把 `linkedPrincipleId` 直接当 artifact-version identity。
- 不准新增“已阅读”的持久字段，不准改变授权来源来满足 UI，不能静默修复含 U+FFFD 的真实内容。
- 遇到代码与 SPEC 冲突，只出审计勘误，不偷偷改 SPEC 或源码。生产代码、当前 schema/DTO、真实消费者与测试优先；报告证据等级要清楚。

## 5. 交付格式（必须一次性给完整报告）

标题：`SPEC-PD-CONSOLE-READABILITY-002 v1.1 — Reality Audit Report`。

按顺序给出：

1. **Executive Verdict：** `GO TO IMPLEMENTATION / CONDITIONAL GO / BLOCKED`，并明确这是**实施准入评估**，不是 PR merge 判定或 Owner 体验验收。
2. **审计基线：** 当前分支、HEAD、main、工作树现状、源文件更新时间/访问限制、是否核实安装运行版本、任何命令与副作用。
3. **证据矩阵 E1～E15：** 状态、`文件:行号`、消费路径、与 SPEC 的差异、置信等级；无真实行号不可写“已核实”。
4. **R1～R7 差距矩阵：** `已有并接通 / 已有但断链 / 确实缺失 / 未知`，必要的最小连接点、风险、验证方法、是否阻塞实施。
5. **审批目标一致性表（P1）：** 以 artifact kind × channel × 多版本/多状态为维度，说明展示字段、规范性全文完整性、实际 API 操作目标、群组操作授权、差异与安全边界。
6. **Evidence/Lineage 矩阵（P1）：** Principle/approval/artifact/pain/task/candidate 各身份的可查关系及局限，精准跳转/无关联/多关联/过期/数据不可用/返回契约。
7. **复用优先方案：** 哪些能力已经存在但未连接，必须新增的最小**派生字段/消费逻辑**（如有），为何现有接口不足，所有生产消费者与向后兼容。
8. **拟实施切片：** 最多 3 个切片，按依赖和风险排序。每片写清生产路径、P1 安全前提、定向红灯测试与验收证据；**仅建议，不实施**。
9. **测试与浏览器验收计划：** 红灯→绿灯、负向对抗 fixture、现有 BDD/e2e、图像/响应式/键盘、实际缩放、i18n、证据脱敏；已运行/未运行/受阻分别标明。
10. **SPEC v1.1 勘误建议与 Owner 决策卡：** 每项指出原条款、建议改法、影响、是否需 Owner 选择；不把 Unknown 写成定论。
11. **Complexity Delta、Unknown、停止条件和回滚假设。**

**硬性完成门槛：** 如果不能证明展示原文与审批目标严格对应，不能核实全文的规范性来源，或无法建立真实 evidence/lineage 定位，裁定中必须标记对应 P1 为 **BLOCKED**；可提出独立且安全的排版/i18n 修复作为后续实施切片，不能以该切片完成声称整个 SPEC 通过。

完成后只向 Owner 返回报告和具体修订建议，**停止，不进入代码修改**。
