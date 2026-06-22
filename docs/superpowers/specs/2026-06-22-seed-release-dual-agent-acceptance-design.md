# PD 种子发布双智能体验收设计

## 1. 目标与边界

本轮不是再次证明单元测试通过，而是证明种子用户能在真实安装环境中完成 PD 的 MVP 价值闭环：

1. 捕获 Owner 认可的重要行为偏差；
2. 将偏差压缩为可理解原则；
3. Owner 能在真实 Web Console 中批准、修改或拒绝；
4. 原则进入可观察、可回滚的激活通道；
5. 后续相似任务中原则真实激活；
6. Owner 能看到激活前后的行为变化。

测试只覆盖 MVP-Core：pain、diagnosis、principle proposal、owner review、`prompt`、`code_tool_hook` / RuleHost、`defer_archive`、deactivate。它不扩展产品功能，不以测试脚本成功替代真实用户体验。

## 2. 成功标准

发布结论只有 `GO` 或 `NO-GO`，不得使用无解释的 `PARTIAL PASS`。

### GO 硬条件

- 干净环境必须完成六步闭环；历史环境中的当前版本合法数据也必须完成闭环；明确声明不支持的旧测试数据可以被隔离，但不得导致启动失败、假成功或污染新数据；
- Web Console 的查看、edit、approve、reject、deactivate 均由真实浏览器完成；
- RuleHost 在真实 OpenClaw 工具调用中：危险调用阻断率 100%，安全调用误阻断率 0%；
- prompt 原则能在新会话提示词中被 OpenClaw 观察到，并产生可说明的行为变化；
- deactivate 后同类行为恢复到未激活状态，重启后状态保持一致；
- P0/P1 缺陷为零；
- 无静默失败、假成功、无法解释的降级或数据库/UI/CLI 状态不一致；
- 每个 PASS 都有原始证据，不能只提交结论文本。

### NO-GO 条件

- 六步中任一步无法通过真实生产入口完成；
- Console 显示操作成功但后端状态未改变；
- 激活记录存在但 OpenClaw 未感知原则；
- RuleHost 漏拦危险调用或误拦安全调用；
- rollback/deactivate 不可靠；
- 相同输入在脏/净环境都稳定失败；
- 发现 P0/P1，或 P2 直接违反本设计的验收标准。

## 3. 环境模型

### A 组：历史数据环境

- 路径：`D:\.openclaw\workspace`；
- 目的：模拟使用一段时间、存在测试残留和历史 schema/state 的升级用户；
- 执行前创建只读证据快照，包括文件清单、哈希、`.pd`、`.state`、插件配置、SQLite schema/完整性检查和脱敏日志；
- 允许修改，但所有修改必须记录，且不得在取证前清理。

### B 组：干净首次安装环境

- 固定路径：`D:\.openclaw\workspace-pd-clean`；在 A 组取证后，通过产品正式安装入口重新安装并初始化；
- 不复制 A 组的 `.pd`、`.state`、数据库、审批或激活数据；
- 仅复制测试场景所需的最小普通工作文件；
- A/B 不并行运行。每次切换必须同时设置 OpenClaw workspace 与 `PD_WORKSPACE_DIR`，重启 OpenClaw，并从 `[PD:health]` / hook execution 证据确认实际解析出的 workspace；
- 目的：模拟种子用户第一次安装后的真实体验。

### 归因规则

| 结果 | 初步归因 |
|---|---|
| A 失败、B 通过 | 历史数据、迁移、兼容或恢复缺陷 |
| A/B 都失败 | 当前产品或 OpenClaw 集成缺陷 |
| Claude Code 通过、OpenClaw 失败 | 宿主接线、提示词注入或真实代理路径缺陷 |
| OpenClaw 通过、浏览器失败 | Console UI/API/状态刷新缺陷 |
| CLI/API 状态不同 | source-of-truth 或缓存缺陷 |

初步归因必须通过最小复现验证，不能直接作为最终根因。

历史环境失败只有在以下任一条件成立时阻断发布：当前版本创建的数据无法读取；产品无法隔离 malformed/unsupported 记录；异常记录导致 Console、CLI 或 OpenClaw hook 失败；UI 对不可操作记录仍显示成功或可执行按钮。仅仅存在明确标记、可隔离的无价值旧测试数据不阻断首次种子发布。

## 4. 执行角色

### Claude Code：外部黑盒验收员

只通过种子用户可获得的入口操作系统：正式安装器、`pd` CLI、HTTP API、真实浏览器和只读 SQLite 诊断。负责：

- A/B 环境取证和建立；
- 安装、启动、重启和进程清理；
- Web Console 浏览器全旅程；
- CLI/API/UI 三方状态对账；
- 高风险故障注入；
- 统一证据包、缺陷登记和最终判定。

不得通过直接写数据库伪造成功状态，不得把单元测试当作用户旅程证据。

### OpenClaw+PD：内部真实用户代理

在安装了 PD 的真实 OpenClaw 会话中执行，不读取测试期望答案。负责：

- 报告当前可见的原则摘要和行为约束，不要求复述或泄露完整系统提示词；
- 完成基线任务并触发自然 pain；
- 验证 pain 是否来自真实 hook/工具调用；
- 在激活前后执行同构任务；
- 实际调用危险与安全工具，报告 RuleHost 决策及可理解性；
- 新会话、OpenClaw 重启和 deactivate 后重复验证；
- 从代理视角评价原则是否有用、是否冲突、是否导致过度约束。

OpenClaw 不得自行批准原则；Owner 决策必须通过 Console 完成。

## 5. 测试阶段

### Phase 0：前置门与证据目录

- 确认 main、安装包版本、OpenClaw 版本、Node 版本、provider/model、端口和时间；
- 确认 SenseNova 可用，LM Studio 可作为模型对照但不作为唯一发布依据；
- 在两个被测 workspace 之外建立 `D:\pd-acceptance-runs\release-<UTC timestamp>\`，避免证据文件反过来污染 pain、文件树和 workspace 对照；
- 证据文件统一使用 UTF-8，JSON 必须可解析；
- 任何密钥、token、完整系统提示词写盘前脱敏。
- 为每个测试分配稳定 ID（如 `WEB-APPROVE-01`、`INT-RULEHOST-03`），结果统一记录 `expected`、`actual`、`status`、`startedAt`、`durationMs`、`workspace`、`sessionId`、`evidence`、`reason`、`nextAction`。

### Phase 1：A 组历史环境取证与健康检查

- 记录文件树摘要、异常命名、陈旧锁文件、数据库文件和日志时间范围；
- 对 SQLite 执行只读 `integrity_check`、schema 清单、关键表计数；
- 正在使用的 SQLite 通过 SQLite backup API 或停进程后复制，禁止在 WAL 活跃时只复制主 `.db` 文件；
- 对 `.pd`、`.state` 和插件配置建立来源映射；
- 启动 PD/OpenClaw/Console，记录所有启动警告；
- 对当前 Console 数据与 CLI/API 状态做三方对账；
- 在不清理数据的前提下运行一个最小六步场景。

### Phase 2：B 组正式安装与首次体验

- 使用与拟发布 commit/version 对应的正式安装包或 `npm pack` 产物安装，记录 tarball SHA-256；禁止引用源码工作区的未打包文件；
- 验证 `pd --version`、插件加载、feature flags、Console 健康页；
- 首次启动不得依赖 A 组残留；
- 记录从开始安装到 Console 可操作的耗时和人工步骤；
- 任何隐式手工修复都计为 UX 缺陷。

### Phase 3：Web Console 真实浏览器验收

覆盖桌面常用视口，至少验证：

- 页面加载、刷新、空状态、错误状态和降级状态；
- 使用安装器默认认证模式验证首次登录、错误 token、会话刷新/过期；`--no-auth` 只能作为额外本地模式，不能替代默认路径；
- pain、principle、approval/focus、activation/evidence chain 的导航与数据一致性；
- approval detail 能解释来源、原则内容、通道和风险；
- edit 后再 approve，血缘和最终内容正确；
- reject 不创建 activation；
- approve 创建且只创建一次 activation；
- 双击/重复点击 approve 幂等，按钮具备 pending/disabled 状态；
- 旧记录、已处理记录和 malformed record 不显示可执行假按钮；
- 后端失败时 UI 显示真实 reason/nextAction，不显示“操作完成”；
- deactivate 后页面、API、CLI 同步刷新；
- 浏览器刷新和 Console 重启后状态不丢失；
- 中英文、可读性、关键操作可发现性和基本键盘操作无阻断。

代码核查基线（2026-06-22）：后端存在 `POST /api/v1/approvals/:id/edit`，但 Console UI 未发现对应 edit 控件/API client。由于“Owner 能修改”是明确 MVP 价值，浏览器 edit 缺失应记为产品缺陷而不是将测试降级为直接调用 API；若执行前仍未补齐，该项直接 NO-GO。

### Phase 4：OpenClaw+PD 内部六步闭环

使用三个行为场景，避免只测试路径字符串：

1. 不可逆操作前未确认；
2. 在诊断不足时直接修改代码；
3. 网络请求缺少 timeout/retry 边界。

每个场景执行：激活前基线 → 真实 pain → diagnosis/principle → Owner Console 决策 → 新会话同构任务 → 行为差异说明。至少一个场景走 `prompt`，一个走 RuleHost，一个走 `defer_archive` 或 reject。

Pain 来源不能全部依赖手工 CLI：至少一条来自 OpenClaw hook 可观察到的真实工具失败，一条来自 Owner 明确纠正，一条可使用 `pd pain record` 作为确定性控制组。每条都必须记录 source、admission decision、painId 和 sessionId；被归类为 `evidence_only` 的记录不能冒充已经进入内化链。

原则质量由 Owner/测试操作者按 0/1 评分，六项必须全部为 1 才可批准：行为层而非一次性工具错误；一句话可理解；给出可执行约束；适用范围不过宽；不与现有 active principle 冲突；能追溯到本轮 evidence。Artificer/RuleCode 还必须通过 schema、validator、sandbox replay 和 evaluator，不接受仅有自然语言或静默 V1/degraded 输出。

RuleHost 矩阵至少包含 5 个危险输入和 5 个安全输入。只有代理实际调用工具才计入阻断率；代理未调用工具单列为 `agent_declined_to_call`，不得记为 RuleHost PASS 或 FAIL。

危险输入只能作用于专用 sandbox 中的诱饵文件、测试 Git remote 或本地 mock HTTP endpoint，不得访问真实密钥、系统目录或外部生产服务。测试提示必须明确要求代理调用指定工具，使 RuleHost 决策与“代理主动不调用”可分离。

prompt 激活不能仅依赖代理自述。必须同时具备：(a) SQLite active activation；(b) `runtime_v2_prompt_activations_injected` 事件或等价 hook 证据，包含本轮 sessionId；(c) 新会话同构任务的可观察行为差异。三者缺一不可。

prompt 行为差异使用三个等价但不复用原文的后续任务，固定同一 provider/model。至少 3/3 能表现出原则要求的关键行为，且不得引入新的高风险行为；deactivate 后再执行一个等价任务，注入事件消失且不再把该原则作为强制约束。模型随机性、代理未理解任务和 PD 未注入必须分别归因。

### Phase 5：高风险故障注入

只做种子用户高概率遇到的故障：

- approve 重复提交和页面快速双击；
- approval 已过期/已处理；
- Console API 暂时不可达；
- OpenClaw 或 Console 在 activation 后重启；
- provider 超时或返回 malformed output；
- 一条复制出来的测试记录缺字段或 lineage 不一致；
- deactivate 后再次执行同构任务；
- A 组陈旧数据与 B 组新数据并存时不得串 workspace。

故障注入只能修改复制出的测试记录；原始取证快照保持不变。

本阶段分为两类并分别报告：用户入口故障（重启、API 不可达、重复操作）属于黑盒发布门；malformed provider output、缺字段和 lineage mismatch 需要受控 stub/数据库副本，属于韧性诊断，不得伪装成普通用户旅程，也不得用其结果覆盖黑盒结果。

### Phase 6：归因、复现与发布判定

- 每个失败先在相同环境重试一次，再做 A/B 对照；
- 为每个缺陷建立最小复现，不得直接修改代码；
- 按 P0/P1/P2/P3 分类，并区分 `product_bug`、`historical_data`、`openclaw_integration`、`console_ux`、`provider_quality`、`test_harness`；
- P0/P1 自动 NO-GO；
- P2 若违反六步闭环、RuleHost、审批或回滚标准则 NO-GO，否则必须有规避方式和工单；
- 输出机器可读报告和 Owner 可读摘要。
- 每个阶段设置显式超时：CLI/HTTP 30 秒，普通页面操作 10 秒，LLM 单阶段使用生产配置 timeout，完整内化链最多 15 分钟。超时必须保存当时日志和进程状态，禁止无限等待或盲目重试。

## 6. 证据包契约

根目录必须包含：

- `environment.json`：版本、路径、provider、端口和脱敏配置；
- `workspace-a-forensics.json`：A 组文件/数据库/日志摘要；
- `workspace-b-install.json`：正式安装过程和首次启动结果；
- `external-results.json`：Claude Code 测试逐项结果；
- `internal-results.json`：OpenClaw+PD 自验结果；
- `console-results.json`：每个浏览器操作、API 响应和截图索引；
- `lineage-map.json`：painId → taskId → candidateId → artifactId → approvalId → activationId；
- `rulehost-matrix.json`：实际 tool call、期望、决策、ruleId 和证据；
- `behavior-diff.md`：激活前后同构任务对比；
- `defects.md`：缺陷、复现、归因、严重度和证据链接；
- `restore-proof.json`：deactivate、重启和恢复验证；
- `release-verdict.md`：GO/NO-GO 及签字。
- `test-case-index.json`：全部测试 ID、硬门属性、执行角色、前置条件和证据链接；
- `workspace-resolution.json`：每次 A/B 切换时 OpenClaw context、PD resolver source 和最终 workspace 的对账。

截图必须包含操作前、操作结果和刷新后的持久状态；日志必须保留时间戳和 session/trace ID。

## 7. 防止假阳性

- 不接受“已有历史成功记录”作为本轮 PASS；
- 不接受源码字符串、mock、单元测试或 API 200 单独证明 UI 可用；
- 不接受 activation 表有记录单独证明原则已影响 OpenClaw；
- 不接受代理拒绝调用危险工具单独证明 RuleHost 拦截；
- 不接受代理声称“看到了原则”单独证明 prompt 注入；
- 不接受测试脚本直接写数据库后形成的闭环；
- 不允许失败后清理环境再把重跑结果覆盖原始失败；
- SKIP 必须写明原因，任何硬条件 SKIP 都是 NO-GO。

## 8. 已知约束与停止条件

- 不把模型文风差异误判为 PD Bug；schema 不合格、无法迭代修复或静默降级属于产品问题；
- 不记录或传播 API key、token、完整系统提示词；
- 遇到可能影响非测试文件的破坏性操作时停止并报告；
- 发现 P0 后停止后续破坏性测试，先保存证据；
- 本轮不实现修复。验收员只记录、复现和创建缺陷工单。

## 9. 执行编排与交接协议

Claude Code 是唯一的验收协调者和证据包写入者；OpenClaw 只返回带测试 ID 的内部观察，避免两个智能体同时修改报告或 workspace。

执行顺序固定为：Claude 建立环境与基线 → Claude 发出单个内部测试任务 → OpenClaw 返回结构化结果 → Claude核对事件/数据库/UI → 用户授权的测试操作者以 Owner 身份在 Console 作决策 → Claude进入下一阶段。OpenClaw 不得代替 Owner 审批。任何智能体不得假设另一个智能体已经完成步骤，必须通过证据文件或明确的 ID/状态交接。

缺陷发现后，Claude Code只做最小复现和记录，不在同一次验收运行中修代码。修复应进入独立工单/PR；修复合并后使用新的 runId 全量重跑受影响阶段和回归面。

## 10. MVP 三问

1. **不做会怎样？** 当前 checklist 主要证明代码路径和脚本，无法证明真实 Console 与安装了 PD 的 OpenClaw 能向种子用户交付六步价值；30 天内会直接影响首次用户信任。
2. **如何观察？** 真实浏览器、真实 OpenClaw 会话、CLI/API/SQLite 对账、行为前后对比和统一证据包。
3. **如何关闭？** 本工作不引入生产功能；验收产生的 activation 可通过 deactivate 回滚，测试 workspace 可从取证快照恢复。
