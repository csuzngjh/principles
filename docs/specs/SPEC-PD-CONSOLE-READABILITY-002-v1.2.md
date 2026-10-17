# SPEC-PD-CONSOLE-READABILITY-002：控制台原则阅读与审批体验整改

版本：**1.2** · 日期：**2026-10-13** · 状态：**Reality Audit 已完成并交叉复核；Owner 决策待确认，未授权实施**  
关系：在 v1.1 基础上吸收 Reality Audit 与独立源码复核；补充 `SPEC-PD-UIUX-001-website-console-upgrade-v1.0.md` 的 R2、R5、R6，不取代该 SPEC 或其验收。  
阶段裁定：**CONDITIONAL GO。安全阅读修复可独立申请实施授权；R2 目标一致性和 R5 证据定位在补足明确契约、Owner 裁决前不得实施。此 SPEC 不等于代码实施/合并授权。**

## 1. 结论、目标与设计原则

**目标：** 让 Owner 打开控制台后，先看懂发生了什么、原则准备改变什么、为什么提出、需要自己决定什么，再按需阅读完整的规范性文本、操作后果与行为证据。

当前痛点不只是乱码：长篇规则被当作标题、复杂要求缺少阅读层次、内部术语直露、审批记录被误称为行为证据、证据链接不能定位，以及“编辑”按钮实际上要求替换已验证 artifact。它们可能使 Owner 在未理解审批对象的情况下作决定。

**核心安全不变量：Owner 看见的审查内容、Owner 选择的操作、服务端实际处理的审批目标必须对应。** 可读性不能通过伪造标题/说明、隐藏缺口、把一个 artifact 代表另一 artifact 或弱化治理门禁来达成。

本轮只修复现有 Console 的展示、解释和必要的只读投影/定位消费；保留 Owner 审批权威、证据真实性、可追溯与可撤销边界，不自动改写原则、不改审批状态机、不重设计治理架构。

### 完成标准

1. 规则正文不再作为整段加粗的 h1/h3；原始换行、空行、编号、顺序可读，全文不会被截断结果冒充。
2. 常规卡片区分短标题、可靠说明、完整审批内容和操作；没有相应资料时如实提示，全文在当前审查流程可达。
3. **每个审批目标**的 `approvalId`、`artifactId`、通道及可核实的版本身份与展示内容一致；多版本/多通道不得以第一条内容代替全部。
4. 原则内容、解释、审批记录、行为证据、投递/应用/效果及激活状态各有准确语义。
5. 不熟悉内部编号的 Owner 能理解按钮作用；对应证据能精确定位，无法定位时说明原因；不伪造证据或成功结果。
6. 静态乱码得到验证修复；疑似动态损坏原文不变，不静默猜字、删除、修复存量状态。
7. 技术回归、真实浏览器页面和真实 Owner 理解反馈分别记录，任何一项缺失不能冒充全部通过。
8. 普通审批不得将 `approvalId` 或有条件传输的 `reviewedArtifactId` 冒充通用的 artifact 版本锁；当前显示内容与最终写入目标一致性必须经真实服务端路径验证。
9. 证据查询的截断/窗口与关联完整性必须可见；HTTP 返回失败时核实审批是否已落库，不能将“激活失败”误称为“审批未成功”。

## 2. 依据、基线与证据边界

审计基线：本地 Reality Audit 报告（2026-10-13）记录 `D:\Code\principles` 主检出 `main @ b0f807b9`、`origin/main @ f82feeae`，UIUX-001 合并在 HEAD；独立交叉核查以固定提交 `b0f807b9` 读取生产源码。**远端交叉核查没有连接本地设备**，本地未提交文件状态以审计报告自述为准；安装运行时、已登录 Console 和真实 Owner 数据仍为 UNKNOWN。实施前在隔离 worktree 重新核对最新目标基线，不能假定 `b0f807b9` 仍是 HEAD。

| 编号 | 已知依据 | 确认的问题或边界 |
|---|---|---|
| E1 | v1.0 引用的 Owner 控制台截图 | 多条长规则连续铺开、全文加粗、存在替换字符及工程术语；截图与运行构建的对应关系未核实 |
| E2 | `ApprovalsGroupedConsoleModel.ts` 的 `extractCandidateDescription` | `principle+rule`、`title+statement` 的静态分隔文本含损坏字符；需核查真实 U+FFFD 及编码字节 |
| E3 | `focus-validation.ts` / `FocusPage.tsx` | `candidateDescription` 优先充当卡片标题，正文容器不保证原文换行 |
| E4 | `page-shell.tsx` | 共用页面内容最大宽度约 712px；本轮不得全局改宽来处理长文 |
| E5 | `PrincipleDetailPage.tsx` | 22px 加粗 h1 可承载整条 `learnedPrinciple` 或 `principle.text` |
| E6 | `FocusPage.tsx` | `group.records.length` 作为 evidenceSummary 数值，证据链接固定 `/pain` |
| E7 | `FocusPage.tsx` / `PrincipleDetailPage.tsx` | “编辑”对应 `editApproval(approvalId, newArtifactId, reason)` 而不是直接写正文 |
| E8 | `PrinciplesPage.tsx` / `OwnerDecisionCard.tsx` / i18n | 候选描述在“依据”中重复，部分辅助文字小；存在内部检查码与术语 |
| E9 | v1.0 已知运行界面 | 停留在访问令牌页，尚未验证安装版本、真实对象及登录后跨页行为 |
| E10 | 审批服务端分组及 Focus 操作逻辑 | **源码已证实**按 `principleId` 分组、取第一条 pending artifact 描述，并循环提交**全部 pending**；通道与可撤销性从 `records[0]` 取值，甚至可能取自已决定记录。`fitsPromptBudget` 也仅基于一个目标，不能代表全组 |
| E11 | 提取器与真实数据形状 | 生产 artifactKind 与 `contentJson` 来源形状不得混称：scribe/philosopher/dreamer 是**内容结构**而不是必然不同的 kind；rule 注释提取没有发现生产写入方，不能据此承诺 rule 的规范性全文。仅第一候选/标题/注释也不等价于规范性全文 |
| E12 | Principles 列表及详情 | Semantic Selector 的 `learnedPrinciple.text` 可能是完整行为准则而非短标题；详情已经有 incident/rationale/applicability/expectedBehavior/currentEnforcement 等 Owner narrative 能力 |
| E13 | Evidence Chain 读模型及 `PainPage.tsx` | `linkedPainId` **虽有 DTO 声明但现有组装代码未赋值**，不得作为深链依据；可复核 `linkedPrincipleId`/任务/候选等关系但不保证 artifact-version 关联；Pain 页不消费原则级 URL 深链与返回定位 |
| E14 | `ActivationPage.tsx` | 已有 `activationId` 深链与特定情境的“修改为可注入版本→新审批”流程；不应未经核对就作为待审 artifact 的正文编辑功能 |
| E15 | UIUX-001 的 SPEC 与实施验收记录 | 已有 Focus 阅读顺序、状态/receipt 语义、i18n、部分渐进披露、移动端导航；本轮不得重复建设。其实际 Owner 验收与运行部署仍需单独验证 |
| E16 | `EvidenceChainConsoleModel.ts` 生产查询 | pain_events 按时间倒序 **`LIMIT 100`**；仅在 `PainPage` 对现有响应做客户端 `linkedPrincipleId` 过滤会产生假阴性，**零匹配不证明无证据** |
| E17 | `ui/api.ts`、`ApprovalsConsoleModel.ts` | `reviewedArtifactId` 在 API helper 中受 `intentReviewed` 是否有值控制传输；后端对该字段的强校验为特定 prompt 替换复核，不是所有普通审批的通用原子版本锁。读取→写入间的 artifact 指针变化需专门核查 |
| E18 | `ApprovalsConsoleModel.approve()`、批准路由 | 对 prompt，审批**已持久化**后激活失败可能返回 HTTP 错误且 `approvalRolledBack:false`；UI 必须重新读取权威状态并区分审批结果和激活结果 |
| E19 | `tests/bdd/focus-page.steps.ts` | 名为“在 FocusPage 点击批准”的 BDD 步骤实际上直接 POST 单个审批 API；能证明 API 流程，不是分组按钮真实点击 E2E |
| E20 | 审计报告与运行证据 | Reality Audit 报告为只读审计，自述 `error:context` Pass 1 已运行、未执行 build/e2e/verify:merge；未完成真实浏览器、Owner 理解验收及安装运行版本核实 |

**禁止越界推论：** E2 不能证明所有存量数据均损坏；E6 不能证明系统没有行为证据；E10 证实存在**结构性隐式多目标提交路径**，不证明真实 Owner 曾误批准；E13 不能证明仅凭 `linkedPrincipleId` 能精确定位当前 artifact 版本；E16 的返回空集合不证明整个证据来源为空；E17 不能直接认定已存在生产竞态事故；E18 的 HTTP 失败不等于审批回滚；E15/E20 不证明当前安装版本已更新。

## 3. 范围、权威与禁止事项

### Included

- 治理焦点中原则待审卡、关联决策卡；原则列表、详情、生效页相同阅读/术语缺口。
- 与具体审批对象相关的规范性全文显示、只读身份投影及必要的版本/通道区分。
- 当前对象对应的行为证据定位、缺口语义、返回审查上下文。
- 已确认源码静态乱码、相关 EN/ZH 文案、必要的 validators/API/消费者同步。
- 行为回归、真实页面截图、Owner 理解验证及验收记录。

### Excluded

- 官网、安装器、Companion 原生壳、通用仪表盘、全站视觉重设计。
- 新摘要模型、自动翻译、原则生成流水线改造、自动拆分/改写/合并原则。
- 新数据库、存量迁移、新 Owner 政策、新审批权限、新决策状态机或新治理权威。
- 自动批准、批量决策能力、新后台服务、运行时开关和外部网络功能。
- ADR、`AGENTS.md`、私有设计/情绪价值指南变更。
- 写入 `~/.pd/runtime/`、OpenClaw 安装目录、真实 workspace 的 `.pd` / `.state`。

### 权威边界

1. 后端既有治理契约/合法动作/版本检查决定是否可批准、拒绝、替换、停用；UI 不建立第二权限判断者。
2. `approvalId` 是提交动作的具体审批记录身份，`artifactId` 对应被审查内容；`principleId` 是原则关联身份，**不能单独证明同组审批内容相同**。通道与版本/摘要只能取现有可验证事实，不能猜测。
3. 标题、解释、候选说明、规范性正文和证据是不同语义。派生字段只能由对应现有模型所有者提供，不成为新的持久真相。
4. **目标整改方案默认逐目标提交（建议 Q1-B，待 Owner 最终确认）**，每个 approval 对应独立的阅读内容与动作。现状“一次点击循环多个请求”不构成 Owner 授权的批量治理契约；不新增批量决策能力。若要保留聚合动作，必须另向 Owner 提交明确的批量语义、权限/部分成功/确认方案并获得授权。
5. 内容本身过度复杂是独立治理问题；本轮只改善其可读性与缺口披露，不修改该原则的含义。需要重写/拆分的内容登记后续 Owner 决策候选。

## 4. Reality Audit 结论、Owner 决策与实施准入（已完成审计，不重复全面审计）

### 4.1 审计记录与增量真实性检查

2026-10-13 本地 AI 完成只读 Reality Audit（主代理 + 2 子代理）；独立交叉核查复验 E2/E5/E6/E7/E10、Pain 无深链、`LIMIT 100`、批准失败语义、BDD 非 UI 点击。**报告是实施准入证据，不是测试通过、运行中部署证明或 Owner 验收。** 审计文件为独立报告，不把临时文件自动视为已提交仓库。

实施前只需执行**增量 Delta Reality Check**：读取最新 HEAD/目标 main/相关 diff，核对本 SPEC E1～E20 所依赖的生产代码、权威状态和测试是否变化；检查适用 ADR、`AGENTS.md`、私有情绪价值指南与 ERROR_PATTERN_INDEX。需要时局部复审，不重跑完整审计来代替实施验证。运行 `error:context` Pass 1/Pass 2（Pass 2 必须在实际 diff 后执行），记录命中及副作用。

### 4.2 Owner 决策卡（**以下是推荐方案，尚不是已批准的 Owner 裁决**）

| ID | 推荐选择 | 依据与约束 | 决策状态 |
|---|---|---|---|
| Q1 — 分组策略 | **B：逐 approval/逐目标提交** | 现有单卡调用全部 pending 无明确授权，BDD 实际证明的是 API 单条路径；保留同原则视觉聚合可以，但不得有隐式多目标动作 | **Pending Owner Decision** |
| Q2 — 全文来源 | **A（附条件）：现有分组模型增加 per-record 只读、结构化审查投影** | 从当前 artifact 真实字段派生，显式区分规范性文本/技术代码/片段和来源可信度；不能将原始 `contentJson` JSON 串直接当成可审正文，也不能把敏感字段原样暴露 | **Pending Owner Decision** |
| Q3 — 证据措辞 | **只声明“该原则的历史关联证据”** | `linkedPrincipleId` 不证明当前 artifact/version 直接来源；如需称“本次审批对应证据”，必须证明更强身份关系及查询覆盖 | **Pending Owner Decision** |
| Q4 — 真实缩放 | **人工真实浏览器 200%/400% 验收为主，自动化重排为辅** | 视口宽度/仿真不是实际浏览器缩放；无法完成须标 Unknown | **Pending Owner Decision** |
| Q5 — cancelled | **验证 cancelled 不得错误映射 pending** | 先定位现有状态契约及生产写入方；若需变更生命周期或公共枚举，单独报 Owner 决定范围 | **Pending Owner Decision** |

Owner 最终确认前不得把这些推荐标为 `Approved`。获得授权时在 SPEC/工单中填写决策人、日期、选项和证据，不允许开发 Agent 自行代 Owner 批准。

### 4.3 按分片准入

- **切片 1 — 安全阅读修复：CONDITIONAL GO。** 可在 Owner 明确授权后独立实施静态乱码、排版、准确数值标签、i18n、旧“编辑”称谓与不改变操作集合的缺口显示；不得借机改审批目标、权限和激活语义。
- **切片 2 — 逐目标审查与审批一致性：BLOCKED 至 Q1/Q2 获批且版本守卫契约查明。** 在不新增治理权威前提下保证“展示集合=可执行动作目标集合”，并正确表示已批准但激活失败；服务端缺少必要原子保护时**停止相关修改并提独立治理缺口，不由 UI 假装解决**。
- **切片 3 — 证据定位：BLOCKED 至 Q3 获批且查询窗口/覆盖问题解决或如实限定声明。** 不允许“先取最近 100 条再客户端过滤”被当作完整精确检索。服务端按真实 ID 的只读过滤/分页若确有必要，只能在既有读模型和路由中最小扩展并说明兼容/脱敏。

**实施停止线：** 无法取得对应 artifact 的完整权威规范性内容；需要猜测关联、对版本作不实断言；需要新增审批政策、通用摘要服务、持久状态或未经授权改变写入路径；API 失败状态无法区分已提交/未提交。阻塞分支不得以样式或测试名称掩盖。

## 5. 页面需求与验收标准

### R1 — 静态乱码修复与动态数据完整性

修复已确认会进入界面的损坏静态分隔符/静态文案，并保存为 UTF-8；在生产提取、HTTP 响应和浏览器显示边界核验，不以仅搜索源码取代验证。

对于动态数据疑似损坏，**原文逐字保留**。仅在有可靠来源/编码/记录异常证据时作“文字可能已损坏，含义需要核对”提示及追溯；**不能仅因出现 U+FFFD、特殊引号、emoji 或合法特殊字符便自动判定原始记录已损坏**。不能替换、删除、猜字修复或迁移存量数据。

**AC-R1：** `title+statement` 及 `principle+rule` **提取分支**都不再由源码注入替换字符；对真实生产可达的分支验证 HTTP 和渲染，对无真实生产写入方的 legacy/fixture 分支如实说明只验证提取函数与向后兼容，不能冒称当前生产数据路径。测试覆盖中文、英文、emoji、引号、换行、合法特殊字符及有证据损坏的原文；确认展示未改写真实值。确实需要恢复数据时独立开有来源证明的后续任务。

### R2 — 标题、说明、规范性全文及审批目标逐层对应

审查卡区分四层：**短标题/中性入口 → 有来源的易读说明/缺口 → 当前目标的完整审批内容 → 权威操作及后果**。标题和说明都不是规范性全文的替代品。

- 有真实短标题即展示；语义字段中即使名为 `title` 或 `learnedPrinciple`，也需核实它是否实际上是长正文。无可靠短标题用“待审原则”等中性名称，技术 ID 进详情；截断只作预览且全文可达。
- 可靠说明可来自现有 Owner narrative/语义投影的对应字段，注明它是说明及来源；没有则显示“暂无易读说明”，不能从标题、状态或已有示例自动编造。
- 说明尽可能涵盖“何时适用、准备改变什么、主要限制”，无法确认的部分明确“资料不足”。
- **“完整审批内容”必须来源于与当前 `artifactId` 对应的权威原始结构**。对每个 artifact kind 验证是否完整；rule 代码注释、philosopher 标题和 dreamer 首条建议不得未经证明就宣称是全文。仅能提取片段时标为“可见片段/完整内容暂不可确认”，保留来源与恢复指引；UI 不自行发明新的审批授权规则。
- 原始换行、空行、编号、特殊字符、顺序和必要的规范性约束不可丢；在当前审查流程以“阅读完整规则/审批内容”展开或默认展示，使用文本安全渲染。长内容不作为加粗 h1/h3。
- 对每个**待处理 record**，显示或可展开其真实 `approvalId`、`artifactId`、channel 及已有可验证版本标识，并可逐一核对该 record 的正文与后果。不得用第一条 artifact 的说明、预算、可撤销性代替同组所有对象。
- **逐目标提交（待 Q1 最终确认）：** 同一原则可以保留阅读分组，但必须逐 approval 分别呈现动作，不允许以组内第一条的候选描述、通道、可撤销性、预算或意图确认代表其他待决对象；禁止隐式循环所有 pending。若需批量行为，应另立治理决策而非纳入本 SPEC。
- 批准动作必须验证“审查时的 `approvalId` + `artifactId`（以及既有可信版本/摘要）”与最终提交时的权威记录相符。现有 `reviewedArtifactId` 仅特定分支可选传输/校验，**不构成普通审批通用版本锁**；核查 read→write 竞态和是否存在可复用的原子版本比较。若缺乏可证明的通用防护，明确暴露 Unknown 并停止需要该保证的分支，另提 Owner 治理决策；不得单靠 UI 提交前检查声称消除 TOCTOU。
- 刷新/过期/部分成功后不能沿用旧确认；revision intent 确认以每个真实版本为单位，不得在共享卡内重用；完整阅读不引入持久“已阅读”状态。

**AC-R2：** 10/500/2000 中文字符、无标题、无说明、复杂规则、原文特殊字符、同原则两个 artifact、相同 artifact 不同通道、同组混合状态、不同版本的预算/风险各有验证；“页面全文—提交 artifactId—实际处理记录”逐一相等；任一目标缺失/过期时不以其他目标覆盖；部分成功逐目标反馈；展开/收起不改变提交目标。应能核对所有待审对象的原文，而不只是第一条。

**AC-R2-Identity（P1）：** 采用真实生产路径的 A/B 双目标 fixture：同一 principleId 下，A=V1/prompt、B=V2/code_tool_hook。Owner 可识别两个版本与后果；处理 A 不得隐式处理 B（除非能提供既有契约支持且 Owner 能清楚看见的等价分组依据）；A 成功 B 失败不可报整组成功；重新加载后不使用过期版本确认；测试同一 `approvalId` 的 artifact 指针在阅读后、提交前发生可复现变化时的真实服务端保护/拒绝路径。若现有写入契约不能保证，报告阻塞，不发明仅前端乐观锁。

### R3 — 段落层次、响应式及文本安全

保留原始段落、换行、空行、编号、顺序；短标题可以加粗，长规则正文为普通字重。中文规则正文设计目标：字号不少于 15px、行高不少于 1.6；辅助说明不少于 13px（此为产品可读性目标，不误称 WCAG 的法定最小字号）。审查正文建议 36～48 全角字符行宽，宽屏可调整布局，但不拉满全文，不全局改 `PageShell` 宽度。

文本内容必须安全转义；不把原始内容作为不受控 HTML 注入。长 ID/路径/代码换行或局部滚动。复用既有主题、品牌、语义色和组件；按适用的 WCAG AA 检查正常正文对比度、关键控件边界、焦点可见性与键盘使用。

**AC-R3：** 在 1440×900、1280×720、390×844、**320px 宽**下验证；浅/深主题、200% 与支持场景下 400% **真实浏览器缩放**，覆盖可读性、布局重排、横向溢出、控件可用、键盘展开/关闭、焦点顺序与状态宣读。以窄视口模拟缩放只能标记为代理验证，不得声称真实缩放已完成。含空行、编号、HTML-like 字符、emoji、长路径样例按文本展示且不执行标记。

### R4 — 日常语言与事实状态分离

首层采用 Owner 能理解的状态和操作称谓；首次出现内部概念时解释真实意义。原始检查码、epoch、ID、预算、路由等进入“技术详情”，但不删除追溯材料或关键限制。建议静态用语如 Rollout → “执行结果评审”、RuleCode → “自动执行规则审查”，必须先核实所表示的真实决策，不能只按名称翻译。

状态继续严格区分：可注入预测、已记录投递、已记录应用/效果、未观察到、未知/降级。**批准、激活、可投递和已观察到改善绝非同义词。** 未找到数据不能自动说成 0；历史效果不能推断将来一定遵守。

既有静态文案、aria 名称及提示统一 i18n；原始原则、证据和未知后端枚举不擅自翻译。未知值先说“当前类型暂无法解释”，技术详情保留原值。

**AC-R4：** EN→ZH→EN 且刷新/返回后静态文案、辅助名称正确；已知检查项不以裸代码代替解释，未知项不消失；无投递/无效果/数据不可用时不出现肯定性误导；不复刻 UIUX-001 已建立的另一套状态语义。

### R5 — 审批数、行为证据、查询覆盖及精确定位

`group.records.length` 只代表**审批记录数量**，不能称为行为证据数。行为证据与 receipt 数只来自各自真实读模型并明确类型/查询范围/可用性；不得相加混称，不可用不等于 0。

**关联等级与现有事实：** `linkedPainId` 当前只有 DTO 声明、没有组装写入，不得作为深链依据；`linkedPrincipleId`/任务/候选关系需按现有 canonical/legacy 等真实来源区分。`principleId` 只可支持**该原则的历史关联证据**，不自动支持“本次待批准 artifact/version 的直接证据”。禁止标题相似性、时间推测、数组位置猜关联。多条关联逐一表示；版本级不可查时明确 Unknown。

**查询覆盖是硬门槛：** 当前 `EvidenceChainConsoleModel.getEvidenceChain()` 对 `pain_events` 的读取为 `ORDER BY created_at DESC LIMIT 100`。仅在 PainPage 对现有返回做客户端 `linkedPrincipleId` 过滤，最多得到“最近已返回记录中的匹配项”，**不能证明没有历史证据，也不能宣称完整链路/完整数量**。优先调查既有 receipts/evidence/lineage 读模型是否有可复用的精确身份查询；如无，允许在**既有 EvidenceChain 读模型及既有路由**中增加最小只读 ID 过滤/必要分页或覆盖标识，保留脱敏、输入校验、旧调用兼容，禁止新服务或不受限全量扫描。若只保留 `LIMIT 100`，必须明确显示“仅在当前返回窗口中未找到；更早记录未核实”，计数不可当总量。

从 Focus 进入 Pain 时，URL 参数必须被真实消费，并精确定位、展开/聚焦该对象；无关联、查询失败、数据降级、目标过期、窗口截断须分开说明。返回时保留审查 `approvalId`/对象锚点和合理阅读位置，原卡消失时回到列表并提示，不跳错另一原则。只使用已有脱敏读模型，不允许暴露原始 prompt、token、完整轨迹、绝对路径或堆栈。

**AC-R5：** 测试 A/B 标题相似身份不同且两者数据交错、多关联、无关联、API 失败、旧/过期、历史原则级与版本级不足；**新增至少 150 条 pain_events 的隔离 fixture**，目标原则关联发生在最近 100 条之外：不能显示肯定性“无证据”或假零计数。服务端精确查证时验证分页/覆盖/稳定排序与脱敏，不能把 `LIMIT` 去掉造成失控扫描。点击 A 不定位 B，往返恢复 A；总数、窗口数、未知分别准确标注。

### R6 — 按钮与真实操作、提交结果一致

要求提供已验证 `artifactId` 的原“编辑”操作改为“替换待审版本”或核实准确的称谓，解释真实输入来源、资格、目标与效果；不暗示直接写当前正文。`ActivationPage` 已有特定资格下的“创建修订→新审批”，不可扩展为所有待审 artifact 的任意正文编辑器。

批准、拒绝、替换、停用沿用现有权限/锁定/失败/版本契约。审批通过不保证投递、应用、效果或 Agent 遵守；停用不消除历史影响。不同 approval/channel 不得共享不真实的风险、预算、撤销承诺。关键限制在操作前可见。

**审批结果与激活结果必须分开**：`ApprovalsConsoleModel.approve()` 已有 prompt 审批成功写入，但激活失败且 `approvalRolledBack:false` 的路径，HTTP 可以返回失败。收到这种响应（或无法判定是否持久化）时应重新读取现有权威审批/激活状态，按事实显示：

| 权威结果 | Owner 说明边界 |
|---|---|
| 未提交、仍 pending | 本次没有批准成功，可按已有恢复入口继续 |
| 已 approved、激活成功 | 已记录批准及激活成功，不推断已经投递/遵守 |
| 已 approved、激活失败 | **批准已记录，但激活失败，需恢复**；不能提示“审批未成功” |
| 已 approved、激活被跳过 | 批准已记录，但本次未派发激活 |
| 读取失败或状态不明 | 状态暂不可确认；禁止重试/再次批准的误导性成功建议 |

不新增审批持久状态或另一套状态机，尽量使用现有响应码、`nextAction`、审批详情和激活读模型。若后端没有足够的可核实结果，停止声称完成该状态的完整处理，列为缺口。

**AC-R6：** 覆盖旧 artifact/锁定/权限拒绝/无效替换 ID/单目标成功与失败；另必须有“审批**已写入** + 激活失败/跳过”“API 500 + 再读确认”“多个 approval 结果不同”场景。前端不能只按 HTTP 成功/失败将所有对象分类；不把 `failedCount` 当作已回滚数；刷新后显示真实权威状态。

### R7 — 去除重复，保留必要的依据、风险与缺口

同一卡片主要规则正文只出现一次；“依据”应展示真正的事件/理由来源或可追溯链接，不把相同的候选描述再次贴上去冒充独立证据。没有理由则说尚缺，不凭叙述伪造证据。

风险、锁定、审批对象身份差异、修订确认及会影响批准的关键缺口，在操作前可见；技术代码、历史详情、原始明细可渐进披露。避免重新引入 UIUX-001 已解决的重复卡或第二摘要体系。

**AC-R7：** 3 张连续长卡片在桌面与手机上不会出现标题/说明/依据整段重复；关键阻塞、版本差异、撤销边界及证据缺口不因收起全文而隐形；详情仍有真实追溯信息。

## 6. 阅读示例与真实 Owner 理解验收

以下仅用于说明阅读结构，**不是要写入的 Owner 原则，也不代表真实事件**：

> 标题：先确认范围，再修改现有内容。  
> 易读说明：当你说“整理”或“优化”时，AI 先核对要改哪些内容；涉及删除或整体重写时先说明影响，并按已有规则取得确认。  
> 为什么提出：仅列出有来源的事件说明；没有来源明确缺失。  
> 完整审批内容：展开与该审批 `artifactId` 严格对应的、未经改写的规范性原文。  
> 操作：批准 / 替换待审版本 / 拒绝；说明本次作用于哪个对象以及实际后果。

验收数据应有：Owner 截图对应内容或脱敏等价内容、长规则、复杂编号、混合中英、缺失说明、损坏字符、长 ID、无证据、数据降级及同原则多版本/多通道。

请 Owner 在**不接受开发者口头解释**的条件下审查三条代表性原则，分别回答：

1. 这条准备改变什么行为？何时适用？主要限制是什么？
2. 为什么提出？哪些结论有证据、哪些只是说明或仍不知道？
3. 批准/替换/停用分别有什么后果？当前对应哪一份版本/通道？完整文本在哪里？

每条记录“能回答 / 不能回答 / 原文含义本身仍不清楚”，附对应截图与未解问题。AI User QA 可以辅助发现问题，但**不能替代真实 Owner 理解验收**。布局和测试通过但原文仍不理解时，不得称为整体体验成功；记录需内容治理的后续案例。

### 两个独立 Gate

- **Technical Merge Readiness：** R1～R7 技术正确性、现有治理语义、产品边界、行为回归、真实浏览器验证和 CI 达标；记录任何受阻项。它不要求伪造尚未得到的 Owner 主观反馈。
- **Owner Experience Acceptance：** 上述三条真实原则的理解结果经 Owner 明确复核；未开展时标记 **Pending Owner Acceptance**，不得写“全面验收完成”。

## 7. 最小实现映射（仅候选，不是预先指定架构）

| 现有位置（相对 `packages/pd-console/`） | 本轮责任及约束 |
|---|---|
| `src/server/models/ApprovalsGroupedConsoleModel.ts` | 修静态乱码；按每个 approval 的真实 artifact 内容结构作**只读、安全脱敏、带完整性/来源状态的派生投影**（Q2 待确认）；取消首条内容代表整个分组的用户语义 |
| `src/ui/pages/focus/focus-validation.ts`、`FocusPage.tsx` | 标题/全文分离、逐目标映射、准确计数、对应证据定位与返回、替换操作说明、部分结果反馈 |
| `src/ui/pages/focus/OwnerDecisionCard.tsx` | 检查码渐进披露，关键风险/合法操作继续沿用既有权威 |
| `src/ui/pages/principles/PrinciplesPage.tsx`、`PrincipleDetailPage.tsx` | 现有 Semantic Selector / Owner narrative 真实复用；正文移出大标题、避免重复、展示缺口 |
| `src/ui/pages/activation/ActivationPage.tsx` | 对投递、可注入、效果、未知作准确解释；复用已有版本修订流程时先核对资格与语义 |
| `src/server/models/EvidenceChainConsoleModel.ts`、既有 EvidenceChain 路由、`src/ui/pages/pain/PainPage.tsx` | 明确 `LIMIT 100` 覆盖，按已有关系做最小服务端精确查询/覆盖披露（确有必要时）；前端消费深链、展开定位、多关联/旧对象降级与返回；保留脱敏与旧 API 兼容 |
| `src/ui/i18n/en.json`、`zh-CN.json` | 静态文案及 aria 名称双语同步 |
| `src/ui/api.ts`、validators、`src/server/models/ApprovalsConsoleModel.ts`（审查现有守卫）及 tests | 查明 `reviewedArtifactId` 条件传输和审批 read→write 竞态；按真实 API 状态与再读结论反馈，不绕开现有写入事务。字段扩展须兼容；涉及写入语义变化时暂停并升级 Owner |

不要求拆大文件、通用摘要库、新页面框架、独立关联库或新的第二权限源。如确需跨边界只读字段，先证明已有合同不足，指出单一 owner、版本兼容、验证与回滚，并在 Complexity Delta 如实申报。

## 8. 实施后的验证与交付

**根据已完成 Reality Audit 与实施前增量核查形成最终定向测试计划。** 实施时：

1. 真实提取和 HTTP 边界验证乱码；生产 UI 渲染验证原文、层级、安全转义、审批目标与具体 artifact 一致。
2. 至少回归 `tests/ui/focus-page.test.ts`、`tests/ui/principle-review.test.ts`、`tests/models/principles-console-model.test.ts` 及相关 validators；根据真实调用链补具体模型与路由测试。
3. 回归 `tests/e2e/focus-approve-flow.spec.ts`、`focus-governance-clicks.spec.ts`、既有 BDD 与 activation/receipt 语义测试。**明确 BDD 当前步骤直接 POST API、未点击 Focus 按钮**；必须新增用真实浏览器点击卡片批准按钮、观察网络请求和提交目标的 E2E，不以 API BDD 替代。不得删除或降低既有断言。
4. 针对可复现的乱码、错误目标、全文不完整、证据串线提供整改前失败/整改后通过的行为证明；不能只查 CSS 类名或源码关键字。
5. 重点对抗 fixture：同原则 A/B 不同 artifact/channel；相似标题不同原则；单条批准、部分成功、旧版本及 TOCTOU 竞态；**审批已落库但激活失败**；证据窗口至少 150 条、旧关联在第 101 条之后；数据降级/过期。检查 UI 实际请求、服务端最终 artifact/approval 状态与所见内容一致。
6. 提供 Focus 长卡、原则列表、详情、激活与证据往返的前后截图；覆盖 1440/1280/390/320px、浅深主题、实际 200%/400% 缩放（无法跑则标 Unknown）、键盘展开/焦点及 EN→ZH→EN。
7. 基于隔离数据运行适用验证，拒绝在真实 Owner 工作区上为测试而批准/拒绝/停用。命令缺失、依赖、认证阻塞、跳过或未运行逐项报告：

```powershell
npm run error:context -- --paths packages/pd-console/src/ui/pages/focus packages/pd-console/src/server/models/ApprovalsGroupedConsoleModel.ts --signals readability i18n evidence lineage
npm run test --workspace=@principles/pd-console
npm run typecheck --workspace=@principles/pd-console
npm run build --workspace=@principles/pd-console
npm run test:e2e --workspace=@principles/pd-console
npm run error:context
npm run verify:merge
```

上列为**实施阶段**的验证列表，不是 Reality Audit 必须执行的破坏性/全量操作；测试前确认当前脚本及隔离条件。

PR 报告逐项填写 R1～R7：Satisfied / Not Applicable（有理由） / Incomplete，并区分证据等级、目标身份测试、查询窗口/覆盖、审批与激活最终状态、上线范围、截图、Unknown 与回滚。每切片单独报告 GO/NO-GO；任一 P1 未闭环不得宣称**整个 SPEC** Merge Ready；没有真实 Owner 理解反馈不得声称体验验收通过。未经 Owner 授权不得创建/合并 PR。

## 9. MVP、情绪价值和回滚

| 稳定问题 | 本轮回答 |
|---|---|
| `mvp-q-1-what-if-skip` | 长文、乱码、目标歧义和证据误导持续增加审查成本与误批准风险 |
| `mvp-q-2-how-observed` | 正文完整、目标严格对应、可定位证据、操作解释准确；真实页面和真实 Owner 理解反馈分别观察 |
| `mvp-q-3-how-disabled` | 不引入新开关；代码/构建回滚到已知版本，走既有发布/安装机制 |
| `mvp-q-4-emotional-value` | 减少读不懂、无法确认依据、担心误操作；增强可理解、可判断与控制感，实际效果依 Owner 反馈确认 |

没有数据迁移；只读解释不成为新事实或 Owner 政策。若添加派生响应字段须对旧消费者兼容、留有明确缺口降级；回滚不依赖逆向数据修复。不得手工修改已安装文件。

## 10. Complexity Delta（目标，实施 PR 如实更新）

```text
New durable source of truth: NO
New persisted schema/state: NO
New subsystem/service/background process: NO
New public abstraction/interface: CONDITIONAL YES（逐目标只读投影或 EvidenceChain 精确查询/覆盖字段如进入 HTTP 合同，按事实报告 YES；禁止写 NO 掩盖）
New runtime feature flag: NO
New cross-package dependency: NO
New host/platform-specific behavior: NO
New external/network capability: NO
```

若无法从现有投影获得准确的每目标规范性文本或 lineage，只能在现有模型责任所有者内提出最小派生合同；必须解释其必要性、所有消费者、兼容性、错误语义与回滚。UI 禁止私造关联数据库或治理状态源。

## 11. Unknown、分支停止条件与移交

### 尚待核实

- 本地 HEAD/main、截图所对应安装构建和 Owner 登录后的实际文字/版本是否一致。
- 各 artifact kind 可提取的规范性全文边界及短标题/Owner narrative/readability warning 的真实覆盖率。
- 同一原则多版本/多通道的真实 Owner 工作区发生频率未知；**源码已证实**当前循环提交多个 pending 的生产路径，且无明确分组授权契约。
- EvidenceChain 现有数据能否精确归属具体审批 artifact 版本；`LIMIT 100` 之外的历史证据当前不能凭客户端过滤穷尽；精确只读查询能力与覆盖统计仍需验证。
- 私有情绪价值指南及其它适用 ADR 的具体约束；真实 Owner 理解验收未开展。

### 必须暂停对应实施分支的条件

1. 无法证明每个被操作的 artifact 对应的完整审查内容，或分组展示不能覆盖被批准的实际目标。
2. 证据定位需要猜测 ID/标题/版本或会跳到无关对象。
3. 需要变更批准语义、权限、权威来源、持久状态或真实 Owner 数据来“完成 UI”；尤其是发现需要新增写端原子版本守卫时，先上报不静默扩展。
4. 需要新增生成/翻译流水线才能满足摘要要求，或准备将原文自动改写为新的原则。
5. 需要以删除断言、隐藏错误、假成功、假证据来宣布通过；或者把最近 100 条过滤为空说成全部历史无证据、把“激活失败”说成“批准失败”。

对阻塞分支报告：已确认事实 → 缺失的契约/数据 → 可行的最小选项 → 影响与建议 Owner 裁决；独立的无风险文字层级修复可在获准实施后另行推进。**v1.1 Reality Audit 已完成；后续按 v1.2 的增量复核和分片实施指令执行。SPEC 修订本身未授权代码修改、PR 或 Linear 更新。**

---

## 附：v1.1 → v1.2 修订索引（2026-10-13）

1. Reality Audit 由“待执行”更新为“已完成，CONDITIONAL GO”；固化本地审计与固定提交交叉核查证据、尚未验证的安装运行版本。
2. Q1～Q5 以**推荐选项、Pending Owner Decision**记录，不冒充已批准决议；默认建议 Q1-B 逐目标、Q2-A 有条件只读结构化投影、Q3 历史原则级、Q4 真缩放、Q5 cancelled 不误入 pending。
3. R2 增补 `reviewedArtifactId` 传输/校验条件与普通审批 read→write 版本竞态；禁止仅靠前端检查假装已有通用原子锁。
4. R5 增补 EvidenceChain `LIMIT 100` 假阴性，必须揭示范围或使用既有服务端精确只读查询；`linkedPainId` 声明但没有组装赋值，禁止作为深链锚点。
5. R6 增补“审批已持久化但激活失败/跳过”、HTTP 失败后权威再读、审批状态与激活结果分层说明。
6. R2/R6 验证增补真实 Focus 按钮点击 E2E；现有 BDD 直接 POST API，不能证明 UI 多目标安全。
7. 保留全文真实性、安全脱敏、Owner 治理授权、双 Gate、不可修改安装运行时及不新增第二真相源等既有边界。
