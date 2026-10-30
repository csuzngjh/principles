# SPEC-RULECODE-HOST-PROMOTION-001 v0.1

- 日期：2026-10-28
- 状态：待 Owner 设计批准；本文不是规则上线授权。
- 源码基线：30ea308766e4917ef0e632f1bca5e86a3eda1c14。
- 目标：让通过质量验证的 RuleCode，在具有可验证能力的实际宿主上完成影子观察、Owner 上线决定、真实拦放和紧急恢复。
- 实施分段：A 修正共享宿主识别；B 完成 Codex 闭环；C 完成 WorkBuddy 闭环。各段独立验收，禁止把 B 的成功写成 C 已完成。

## 1. 调查结论与证据边界

### 1.1 已验证事实

1. 正式安装的 Codex 插件 0.2.10 使用 adapter 0.6.0、host-runtime 0.14.1、core 1.297.4；官方状态检查通过。
2. 原 pain `manual_1791868470372_8c47edyh` 的候选 `52d98a96-65b9-4952-82c5-51ba2d853c53` 已在正式工作区完成 Scribe run_5、Artificer run_5、Evaluator run_3、Rollout Reviewer run_3。
3. 新代码 SHA256 `7a6aac5e76ece4404d6cf8113e4080365468cfd4ff44014089fd088d271bc3d3`，系统确定性回放 79/79，外部独立回放 65/65。两组不能相加宣称 144 个独立案例。
4. Owner 明确授权后，通过 Web Console 批准正式工件，审批于 2026-10-28T12:05:46.232Z 变为 approved，进入 shadow；尚未晋升 live。
5. 已安装 `resolvePromotionHostLiveness()` 对该工作区实际返回 `promotion_host_unsupported`，不是对模型生成质量的拒绝。
6. `packages/host-runtime/src/host-liveness-contract.ts` 只有 OpenClaw 能力契约；成功结果类型也只允许 openclaw。其实现以是否出现 codex 分流，没有明确处理 WorkBuddy 与其他未知宿主；WorkBuddy 可能落入 OpenClaw 默认分支。
7. `packages/codex-adapter/src/pd-hook.ts` 已传入 Codex RuleContext provider，并记录规则评估事件。
8. `packages/workbuddy-adapter/src/pd-hook.ts` 已调用共享生产 runtime、编码工具拒绝、记录 `rulehost_evaluated`，但未传入 V2 RuleContext provider。不能把“有事件写入”说成“已具备完整影子上线能力”，也不能说 WorkBuddy 完全没有这些接线。
9. Console `ActivationsConsoleModel` 已消费宿主解析、共享上线检查、影子摘要、Owner 决策和激活安全状态。应补连接，不能另建审批台。
10. 正式工作区当次只读查询 `design_gate_declarations` 为 0。新规则依赖真实设计事实；未知时中性放行，不能用批准规则本身替代开发设计批准。

### 1.2 尚未证明

本轮没有重做 OpenClaw 本机完整上线验收；已有代码支持不等于本机无故障。Codex/WorkBuddy 的 native deny、影子样本、带外暂停及恢复尚未形成完整同工件证据。上述能力必须实测后才可声明支持，不得靠配置布尔值认证。

## 2. 范围与非目标

复用 RuleHost、RuleContextV2、HostLivenessContract、现有宿主声明、影子事件、PromotionReadinessReader、OwnerDecisionService、安全控制存储、Console 及 installer。

不重新生成已验证规则来掩盖宿主问题；不扩建开发审批平台；不新增 facts kind；不伪造 Owner 决定；不改生成模型、预算、50k 限制或质量阈值；不自动批准、晋升、停用其他原则。安装目录与生产数据库禁止直接编辑。

## 3. 目标生产链

真实宿主 PreToolUse → adapter 解码和真实工具语义 → 可信工作区/会话/项目范围 → 宿主 RuleContext → 共享 RuleHost → shadow 记录“本会阻止/放行”但不阻止执行 → 带真实宿主标识的事件 → Console 按同工件、同 activation、同目标宿主汇总 → 编译/回放/中性探针/安全控制/影子阈值检查 → Owner Web Console 显式晋升 → live 决策由 adapter 实际编码 → 宿主执行或拒绝 → 原始轨迹与事件交叉验证。

输入权威：宿主身份来自已验证宿主声明和持久证据；规则来自不可变工件；审批来自既有治理记录；设计批准来自既有 design gate 声明。命令文本、模型声明、测试夹具均不是生产批准权威。

## 4. A：宿主解析与能力权威

1. 替换“非 Codex 即 OpenClaw”的分流。明确处理 openclaw/codex/workbuddy/未知/多宿主。
2. 保持现有纯历史空工作区 OpenClaw 兼容语义，仅限确无其他宿主声明和证据；不得扩大到已出现 WorkBuddy 的工作区。
3. 有非 OpenClaw 证据而对应声明缺失、损坏或读取失败时，结构化拒绝；不得默认回退。
4. 多宿主工作区本次仍拒绝歧义，不自动按顺序选宿主，不新建多宿主路由平台。
5. 宿主工具语义声明仅证明工具映射，不能自动证明影子、带外控制或 live 支持。
6. 能力契约保留现有边界，由对应 adapter/host-runtime 的实现与测试提供证据。增加 Codex/WorkBuddy 实现时扩展现有结果联合类型，不引入第二份持久能力账本或通用插件注册框架。
7. Console 与生产 gate 使用一致宿主解释；错误提供 reason、hostKinds、nextAction，不能把全部派生失败描述为若干互不相关故障。

## 5. B：Codex 上线闭环

### B1 能力清单与实际工具入口

核对真实 Codex 事件名称、工具别名、参数、session/tool call 标识、拒绝输出编码及宿主是否遵循拒绝。既有 Bash/apply_patch 映射不能凭记忆当作当前宿主完整覆盖；未验证别名明确 unsupported，不悄悄放行后声称覆盖。

确认状态查询、规则停用、全局暂停、Owner Console 是真实可用控制入口。修正探针必须调用实际存在的命令与参数，不能沿用过时示例。保护能力按实际动作识别，不因全部经 Bash 而豁免所有 Bash。

### B2 可信上下文与设计事实

复用 Codex provider。验证当前会话、项目、cutoff、工具 ID、fact 来源、版本、任务/SPEC摘要/范围绑定、撤销状态；错误或不可用时遵循现有 V2 暂停与中性降级契约并留下原因。

设计声明只使用已存在的官方认证入口。针对受控测试明确记录测试任务、SPEC摘要和范围，批准/未批准/无需批准/未知分别真实登记；禁止把用户“批准规则”转换成任意开发任务 approved，禁止改历史案例标签或生产 SQL 补事实。

### B3 影子与 live

影子事件必须含可校验 activation、artifact digest、宿主、会话、工具、决策、模式、时间及去重依据。优先复用现有事件字段；缺少必要字段时做最小兼容扩展并验证全部消费者。

不能用 OpenClaw 样本满足 Codex 上线阈值，不能混用旧规则或旧 digest。样本不足、去重失败、事件损坏和来源不可用分别可见，不能把 unavailable 记成 0 或通过。阈值沿用现有实现，不在本文发明或降低。

live 前共享检查必须覆盖真实生产编译器、工具语义、V2上下文、候选加既有 live 规则组合、中性探针、紧急控制及证据新鲜度。Owner 确认与最终写入间再次校验摘要和控制版本，材料变化拒绝提交。

### B4 紧急恢复

通过现有 Console/官方运维入口验证全局暂停、单规则停用、异常隔离。即使候选为恶意全拦规则、provider失败或普通命令受阻，带外控制仍可用。不得用修改 DB 或安装文件作为恢复方案。隔离后不得自动回到 live。

## 6. C：WorkBuddy 增量补齐

先验证其真实 Hook 事件/拒绝语义与既有评估事件，不复制 Codex transcript ingestion 或假定相同 session/cutoff 语义。

在共享 RuleContext 契约内接入基于 WorkBuddy 真实可观测数据的 provider。缺历史或可信设计事实的规则明确暂停，不借用 Codex 数据。若现有数据不足，先输出精确 unsupported 原因及缺失字段；C 不得声明完成，A/B 可独立交付。

随后满足与 B 相同的证据、组合检查、Owner 晋升、熔断恢复标准，并以真实 WorkBuddy 宿主独立验收。不创建新的批准事实来源；复用既有 design gate 机制时必须先验证其项目/会话绑定是否适用。

## 7. 验收矩阵（不可用单测替代 native 项）

| ID | 必须验证的行为 |
| --- | --- |
| H01 | OpenClaw、Codex、WorkBuddy、空历史、未知、多宿主逐一正确解析 |
| H02 | WorkBuddy-only 不得取得 OpenClaw 能力；声明丢失/损坏仍不能绕过 |
| H03 | 源码和安装版实际包、私有插件 pin、实际加载模块分别核对 |
| H04 | 正常 shadow 本会拦截时，宿主实际仍执行无害测试动作，事件正确归因 |
| H05 | 旧工件/其他宿主/重复/损坏/过期样本不能凑足上线资格 |
| H06 | 只读查询、输出文件、组合命令、脚本执行、apply_patch 在真实工具输入下分类正确 |
| H07 | 同一动作在 not_approved 下阻止，在 approved/not_required 下放行 |
| H08 | unknown、缺事实、撤销、绑定不符和 provider 异常符合既有契约且可观察 |
| H09 | 被拒绝的无害写入没有发生：用文件或 Git 状态独立核查，不只看模型说被阻止 |
| H10 | 单规则、与既有 live 组合、中性控制探针均通过；不能只测空规则集 |
| H11 | 全拦规则与错误规则不能锁死官方带外暂停/停用/审阅；隔离不自动复活 |
| H12 | Owner 晋升前后发生 digest/controlVersion 变化，提交拒绝且无错误变更 |
| H13 | 未批准工件仍不能 live；历史批准不得迁移给新工件；shadow批准不伪装live批准 |
| H14 | OpenClaw 生产路径回归通过；本轮未做本机native时明确未验收 |
| H15 | Codex native全部通过与WorkBuddy native全部通过分开出结论 |
| H16 | 原52d新工件获得同digest完整证据；规则无须针对本痛苦加特例 |
| H17 | 增加至少一个不同原则的通用验证，证明共享机制不依赖design_approval专用代码 |
| H18 | 正式晋升后无害读/写受控验收与紧急停用均完成；未获当次治理授权只停在可审阅入口 |

每项记录 commit、工作树、包版本、实际加载路径、宿主版本、工作区、artifact/digest、activation、事实来源、原始事件位置、预期与实际。合成回放、真实生成、native执行分层，成功失败和超时全保留。

## 8. 实施与测试顺序

先复现 H02（红证据）及当前 Codex unsupported；再实施 A，补共享生产入口与 Console 消费者回归。B 按身份解析→能力验证→shadow→官方上线资格→native拦放→紧急恢复串行推进；C复用共享机制但独立取证。

必测：host-runtime、codex-adapter、workbuddy-adapter、core activation、Console相关测试、OpenClaw回归及仓库合并门禁。执行 error:context 两遍，并按实际差异处理错误模式。不得因CI绿把未执行native验收改为PASS。

真实调用链使用已批准工件，不增加生成模型调用；成本主要为本地测试和受控宿主测试。宿主测试使用临时隔离项目与明确的子进程HOME/工作区断言，禁止让试验命令触及用户项目；禁止靠无限循环生成样本凑指标。

## 9. 发布、失败与回滚

源码合并、产品发布、canonical安装、各宿主私有运行时升级、实际加载、Owner决策、native效果是七个独立状态。通过既有 installer/updater 交付；禁止手改安装包或pins。保留当前shadow与全部审批历史；恢复必须用官方有限操作。

能力不足时返回明确拒绝和下一动作，保留规则及证据；不得强制晋升。代码回滚采用revert，规则风险用现有停用/暂停/隔离机制；不删除治理数据，不自动恢复live。

## 10. 完成标准与复杂度

A完成不等于B/C完成；B/C必须各自H03—H18适用项native通过才可称宿主闭环。原pain“真正可用”还要求同工件在正式目标宿主完成真实拦放，不能只给pending审批或模型approved。

预期 Complexity Delta：新持久事实权威NO；新子系统NO；新后台进程NO；新feature flag NO；新外部网络能力NO。现有HostLivenessContract的宿主实现和provider接线YES（真实宿主差异，需要隐藏各自输入/输出与恢复复杂度）；公共类型/事件字段可能最小兼容扩展，实施前列明消费者与验证，不得顺势建registry。

Owner价值：已通过验证的规则能明确知道是否可上线、为何不能上线、如何恢复，减少反复更新仍不可用的挫败感。当前批准仅允许设计评审；未经书面设计批准不开始实施，不自动合并或治理晋升。

## 11. 二次源码复核补充（R1，2026-10-28，优先于前文笼统表述）

### 11.1 必须保留的现有运行语义

`production-rulehost-gate.ts` 已存在 PRI-1019 的精确例外：仅依赖 design_approval、上下文已通过相应校验且 designGate 事实可行动（resolution 非 unknown）的规则，即使 history unavailable 也可执行。新增宿主 provider 时必须保留这个例外，不能把“缺历史一律暂停”当作统一修复；同时不可把例外扩大为任意上下文错误均可执行。H08 增加：新会话首次受管写入 + 无历史 + 可信 not_approved 应被阻止；同条件 unknown 中性；依赖历史的其他规则仍暂停。对抛异常、无效返回、绑定错误分别验证，不混为一种不可用。

### 11.2 上线检查当前证明强度

`openclaw-promotion-checks.ts` 的 runtime_compatibility 主要验证契约形状；emergency_controls 当前由契约存在与 safetyControlsEnabled 组合得出。契约中写 supportsShadowEvidence=true 不证明实际事件链路健康。实施不可仅添加新常量令现有检查变绿：必须把现有执行检查与实际宿主证据正确接到 readiness；保持既有阈值、快照及 Owner 决策权威，不另建能力数据库。恢复探针必须证明带外路径真实可用并覆盖组合规则；不能只验证被测规则对一段命令字符串返回 allow。

### 11.3 WorkBuddy 完整性要求

除 provider 接线外，必须核查 Evaluator 系统签发的 ruleHostInputContract.hostKinds 与生产 gate 的资格核验是否对 WorkBuddy 一致，不能复制仅 Codex 的分支后自动执行历史 V2 工件。H13增加 WorkBuddy 跨宿主旧工件拒绝、审批摘要绑定与新工件重新验证案例。

### 11.4 事实与未知的边界

WorkBuddy encoder 有 deny 输出实现，不代表真实客户端必然执行 deny；事件记录存在，不代表 native 影子样本已采集。WorkBuddy-only 回落 OpenClaw 是已验证控制流风险，尚未声明在用户 WorkBuddy 生产库实际发生。未知宿主 provenance 在已知宿主筛选处可能被过滤，实施必须结合当前声明校验路径核查，不能把未验证的未知宿主攻击声称已复现。

本次为静态复核与此前运行证据交叉校验，未重新执行两组质量回放，未运行 OpenClaw/WorkBuddy native；旧证据不迁移为新基线验收。文档工作树未bootstrap，仅供文档交付，不宣称工程测试READY。
