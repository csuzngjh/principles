# SPEC-RULECODE-CODEX-LOCAL-CLOSURE-001 v0.1

日期：2026-10-22。状态：Owner 已于本会话 2026-10-22 批准实施；不代表已发布或生产规则激活授权。

目标：把人工补事实实验变成可在本地 Codex 使用的受控能力。工程完成必须包含真实宿主的阻止与放行，不能以生成成功、单测、合并或安装完成代替。

## 1. 实验证据与不能迁移的结论

依据 `docs/implementation-reports/PRI-1018-rulecode-facts-experiment-20261022.md`：原痛苦 `manual_1791868470372_8c47edyh` 的原始 Scribe run3，在一致性副本中使用真实 zai/glm-5.3-flash，经共享 ArtificerRunner/EvaluatorRunner 和 production gateDeps 生成 validated rule。最终一次生成与评审约111秒，21项外部回归执行通过。

实验同时做了四类干预：注入模拟事实来源、增加测试事实字段、在请求副本中补明读取契约、缩短重复历史展示。修订反馈使用真实失败案例。两个已反馈的反例不再算未见测试。实验没有验证真实人类身份来源、实际宿主事实生产、生产Hook拦截或持续效果。

不能直接安装实验代码：其中的 `EXPERIMENT_ONLY_OWNER_AUTHORIZED_FIXTURE` 不是生产身份认证。

## 2. 当前实现核查

| 已存在 | 责任与缺口 |
|---|---|
| `ArtificerTrustedFactsPort` | 当前按内部PI taskId查询事实。没有生产实现；生成任务ID不能冒充被治理开发任务的身份 |
| Artificer前置门及Runner防御镜像 | 已有意图/来源/事实依赖检查。两入口必须保持一致，不删掉防伪检查 |
| RuleContextV2 | 当前主要是近期工具历史和读写统计，没有正式设计批准事实 |
| Console Owner身份核验 | 现有Owner裁决路由使用服务端认证上下文与凭据身份，可复用；请求body中的owner字段不是身份 |
| approvals、intent_decisions | 分别拥有原则/工件治理与intentTension裁决，不能解释成开发设计批准 |
| Evaluator和确定性沙箱 | 已有独立代码回放及修订；无需重建验证器。当前序列化上限50000字符，完整重复历史会在调用模型前失败 |
| Codex真实Hook与安装渠道 | 已有原生session/turn/tool输入与逐工件V2资格检查。canonical和plugin-private必须分别验实装加载能力 |

## 3. 方案选择

1. 推荐：Owner显式事实声明 + 既有治理身份 + 既有宿主事实接线。先人工登记批准状态，不增加逐工具LLM判断。来源、范围和撤回均可审计。
2. 不采用：由模型从普通聊天里的“同意”自动生成批准。它不能独立确定批准对象、范围、版本或发言来源。
3. 不采用：继续固定测试布尔值或直接把实验规则装入生产。它无法提供真实治理保证。

第一版只支持Owner明确登记的本地Codex工作范围。不自动覆盖未登记任务、不自动识别全部复杂开发。不得将有限范围试点报告为全局审批纪律已被强制执行。

## 4. 事实来源：一个小范围的Owner声明入口

复用Console认证、Owner身份核验、请求验证、过期快照冲突及审计机制，新增一种用途明确的声明：该任务的这份设计是否批准、当前范围是否要求批准。它是Owner对事实的显式声明，不负责执行任务、编排代理或自动评判设计。

声明至少绑定：

- 服务端推导的ownerId/credentialId与决定时间；客户端不得自填身份。
- governance workspace和实际项目workspace的规范路径；两者不得混用。
- 当前Codex宿主session引用；由已观察到的宿主事件选择，不由tool params宣称。
- SPEC路径及服务端计算的内容摘要、Owner明确确认的操作范围、声明版本。
- `approved / not_approved / not_required`，以及撤回/替代关系。

Owner声明中的范围必须明确哪些操作受管。文件路径范围只代表Owner授权的可机读操作范围，不证明文件里的任意实现都符合SPEC的自然语言语义。界面必须让Owner看清这一区别；不得宣传自动证明代码实现忠于设计。

第一版采用显式登记的专用开发会话/任务范围。切换任务不得静默继承旧声明；不能可靠绑定时为unknown。未登记的任务不是not_approved。已登记范围中的“未批准”必须来自明确的Owner声明或该范围明示的权威完整性规则，不能从任意数据库缺行推出。

持久化只有一份Owner声明权威。现有表语义不合适时，允许新增一个专用、加法迁移的声明表；不得塞入intent_decisions、原则approvals或原始轨迹来回避语义。复用同一state.db、现有生命周期与存储约束，不引入第二数据库、后台同步服务或通用审批框架。

普通工具执行/生成模型不能自行创建或批准声明。普通聊天、命令字符串、可编辑JSON、单纯的source字符串和哈希均不能充当人类认证。信任范围沿用现有本机Owner治理凭据模型，不声称能抵御拥有Owner凭据和本机管理权限的对手。

## 5. 区分生成能力和运行时事实

生成检查应该问“正式宿主是否支持并验证这种事实契约”，不是“生成规则的这一刻某项开发是否已获批准”。允许规则描述未批准时阻止，不能要求所有训练情景先获批准。

沿现有trusted-facts seam明确拆分：

1. 生成阶段读取可信宿主的能力声明：支持的事实类型、schema版本、实际来源、可用状态与输入位置。内在PI taskId只用于生成血缘，不能替代原生开发任务ID。无真实来源能力仍保持明确unsupported，不为假装成功注入测试provider。
2. 每次PreToolUse根据当前原生session、项目、SPEC摘要和操作范围，从同一Owner声明权威解析当次事实，注入正式RuleContext字段。

不创建泛化fact registry。扩充现有端口和宿主上下文即可。Artificer前置门与Runner镜像采用同一能力核验逻辑。

## 6. 正式输入与判断语义

将实验设计批准字段提升为明确、带版本的契约。正式名字/位置统一为 `input.context.facts.designGate`；移除对试验来源字符串的依赖。字段包括sourceRef、声明revision、workspace/session/SPEC/scope绑定、resolution、有效性与失效原因；类型与元素运行时验证，未知/冲突不能用as断言放过。

事实由宿主读取并冻结后注入，绝不从params拷贝。生成、Evaluator回放和生产Hook消费同一schema/投影逻辑；缺字段不得由模型补齐成approved。

| 当次解析结果 | 行为 |
|---|---|
| 可靠只读/调查，或Owner明确not_required | 本原则放行，不覆盖其他规则 |
| 受管操作、匹配的有效approved | 本原则放行，不覆盖其他规则 |
| 受管操作、权威not_approved或明确撤回 | 阻止，给出对应设计/范围与下一步 |
| 无来源、无绑定、损坏、SPEC变化或无法核实范围 | 隔离依赖该事实的规则并显式记录未覆盖；不等于获批，不静默声称治理成功 |

不能凭命令以git status开头就证明整个调用只读。read/search使用可信宿主语义；execute只接受可证明的完整只读调用，复合命令不得按前缀豁免。第一版不能可靠判定的动作明确保留覆盖边界，不引入通用shell分析平台或逐调用模型。

失效核验每次读取最新声明；SPEC变更、撤回、任务/项目改变均使旧匹配失效。缓存必须有可验证revision失效，不能让已撤回批准继续放行。

## 7. 提示与证据展示的最小修复

- Artificer、Evaluator提示一致说明designGate的正式字段、来源与四态，删除“已接入却不能读取”的冲突描述；保留禁止自填批准、防伪与原意一致性要求。
- 原始Owner证据完整保存，golden trace的权威内容不重写、不冒充历史真实批准。
- 只对模型展示做有界投影/去重，明确缩略和截断；确定性沙箱仍读取完整原始用例。不能直接清空持久化历史、提高全局50000上限或仅截字符串尾部。
- 原始样例没有当时批准事实时标明缺失；counterfactual测试样例另有来源标记。不能为了让原负例变为block而伪造历史声明。
- 保留既有有界修订；失败反馈包含真实caseId、输入事实差异、预期/实际及来源，不再次盲重试。

## 8. 本地验收：全部通过才可称本地可用

| 编号 | 必须取得的证据 |
|---|---|
| L01 | 实验21案转为有区分力的回归；保留始终放行/始终阻止负控；新增未经生成模型见过的判定集 |
| L02 | 非Owner、body冒充身份、params自填批准、测试source标签均不能获得正式声明权限 |
| L03 | 生成时无需真实开发已获批准；真实能力存在即可生成，缺能力明确停止；前置门/Runner一致 |
| L04 | 真实GLM通过原信号材料生成，真实Evaluator与确定性回放通过，产生可审阅工件；不是模型自报passed |
| L05 | 超长真实材料完整留存，评审请求在预算内，完整沙箱用例仍参与；缺核心原意不得静默裁剪 |
| L06 | 在隔离HOME与专用验证workspace中，启动真实Codex，验证Hook子进程实际解析到隔离位置后才执行测试动作 |
| L07 | 正式Owner声明API登记“未批准”，目标工具真实被阻止，验证文件未被写入；同一动作获匹配批准后真实执行并核对文件内容 |
| L08 | 普通调查、状态查询、已有批准范围内开发放行；复合命令、自填标记不能绕过 |
| L09 | 撤回、SPEC变化、跨项目/跨会话、坏schema、来源故障分别实测；unknown显示未覆盖，不冒充阻止或批准 |
| L10 | 缺逐工件资格的历史V2规则不被全局唤醒；shadow不影响工具执行，live另有正式治理记录 |
| L11 | 通过正规installer/setup交付候选，核实canonical与实际Hook私有包的版本、来源及真实能力；不只看版本文字 |
| L12 | 用户级工作区中的原始两个任务经官方有界恢复到真实待审工件；保留历史，不重新报痛苦，不以隔离副本成功冒充生产恢复 |

专用隔离验证规则可以在Owner批准本SPEC时一并授权通过正式API走测试审批/激活，授权仅覆盖隔离workspace，不覆盖用户生产规则。正式用户级RuleCode审阅/激活依旧是最后一个明确治理动作；修复代理不得自行批准真实新规则。

最终交付必须分开列出 SOURCE_VERIFIED / NATIVE_HOST_VERIFIED / INSTALLED_VERIFIED / ORIGINAL_SIGNAL_REVIEW_READY / LIVE_ACTIVATED。缺任一事实不得用笼统“完成”覆盖。

## 9. 调用链、成本与交付顺序

Owner事实登记 → 单一声明store → 生成能力核验/正式事实schema → Artificer → Evaluator+完整回放 → Owner规则治理 → Codex PreToolUse实时事实解析 → 现有RuleHost执行 → 可查事件。

每次工具检查不增加LLM调用；沿现有本地SQLite读与Hook期限。实际生成仍用原profile预算和既有修订上限。开发中先复用本次隔离实验验证，再集中一个实现PR，不为每次试验走发布流程；实现通过后一次候选交付，测试失败在候选环境修正。

不改ZCode，不新增调度器，不将PD改成通用开发任务执行系统，不自动抽取聊天批准。安装目录只有正规installer/setup写入。

## 10. Complexity Delta与回滚

| 项目 | 结果 | 必要性与验证/回滚 |
|---|---|---|
| New durable source of truth | YES | 仅缺失的Owner设计事实声明；现有原则批准/intentTension不拥有它。一个权威，无平行账本；认证/幂等/撤回回归；停用目标规则即可停用消费 |
| New persisted schema/state | YES | 必需的声明与revision/撤回；若现有合适store可承载，实施可减为NO，但不得滥用其他语义。加法迁移，旧版可读 |
| New subsystem/service/background process | NO | 复用Console、state.db与现有Hook |
| New public abstraction/interface | YES | 现有跨包事实端口/RuleContext正式扩充，封装来源/失效复杂度；无泛化框架；生产consumer测试 |
| New runtime feature flag | NO | 复用host.codex、逐规则资格/停用与shadow/live |
| New cross-package dependency | NO | 沿原core/host-runtime/adapter/console依赖方向 |
| New host/platform-specific behavior | YES | Codex原生身份绑定与逐次事实注入；真实隔离Hook验证；原宿主关闭与规则停用可回滚 |
| New external/network capability | NO | 原模型调用与安装通道不扩展 |

回滚优先逐规则停用；有问题的来源只影响依赖该事实的规则，其他规则保留原行为。保留所有声明、原任务和审计历史。工程不擅自弱化AGENTS或旧SPEC边界：本设计获批准后，才对原质量SPEC的B1–B3限制增加这一个显式Owner声明来源；其余规则维持。

情绪价值：将反复猜测与更新的成本变成一次可查事实登记和真实工具证据。避免每次编辑都请求确认；也不以未知状态伪造安心感。

## 11. Owner需确认的唯一设计选择

采用第一版人工Owner事实声明入口，限定到明确登记的本地Codex范围；允许上述小型持久化与正式上下文接线，并允许仅隔离验证workspace通过正式API测试审批/激活。确认后实现、回归、候选安装与隔离真实宿主验证连续完成；真实用户级规则激活不包含在这项工程批准里。
