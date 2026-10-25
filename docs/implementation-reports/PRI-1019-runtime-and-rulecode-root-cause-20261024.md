# PRI-1019：旧代码残留与 RuleCode 误判根因调查

日期：2026-10-24（Asia/Shanghai）。性质：调查与设计建议；未实施下述代码变更。

## 结论

两个独立故障叠加：更新链没有把所有执行者切到新发布；切换后的真实生成链又用不完整且存在语义冲突的历史样例进行验收，产生了不合格规则，并将其标记为 validated。

不是“外部模型意见压过内部模型”：判据是既定原则与宿主事实契约，以及可执行反例。本次未批准或激活新工件。

## 一、旧代码残留

### R1：常驻 worker 不随安装发布变化交接

已验证：原 worker PID47368 始于10月22日，安装文件已在10月24日更新。恢复同一原任务仍出现 trusted_fact_provider_absent；重启后原任务越过此前置门并真实生成成功。

代码：`packages/pd-companion/src/main/main.ts` 的 watchInstalledRelease 针对托管 Console，交接分支未重建 workspace worker；worker supervision 在 app 启动时建立、退出时关闭。`src/lib/workspace-workers.ts` 的 sync 仅比较规范工作区集合，既有工作区存在就保留进程，不比较 releaseId/generation。

无实际子进程的生产模块实验：同一 workspace 连续 sync 两次，spawnCount 保持1。该实验验证 registry 边界，不冒充真实发布 E2E；实际旧进程与重启前后任务差异提供现场证据。

建议：复用安装权威 active.json 的发布身份与 Companion 现有进程所有权。成功安装/回滚后让它管理的 worker 有界交接到新发布；不杀外部进程，不按组件号或文件时间决定新旧。长任务如何安全排空须明确定义，不能直接 kill 正在调用模型的任务。

### R2：Codex 插件是另一条更新路径，固定值未跟随本次发版

主安装2.3.11为 core1.296.0 / host-runtime0.13.0 / adapter0.5.13；Codex principles 插件私有目录仍1.295.0 / 0.11.0 / 0.5.9。源码与缓存的 plugins/principles-disciple/runtime-version.json 也都是旧值。

pd-hook.cjs 优先从 PLUGIN_DATA/runtime/node_modules 解析实际 adapter，不会因 canonical runtime 被更新而自动改用 canonical。pd-setup 按固定值安装并要求 source 包版本匹配；重跑旧 setup 不等于升级到新能力。

已用 npm view 分别确认三个目标版本0.5.13、0.13.0、1.296.0均存在，不存在“还没发布所以只能固定旧包”的障碍。应选择经过本次能力验证的精确组合，不机械跟随 latest。

现有 runtime-pin-guard.test.ts 主要保护 host-runtime>=0.1.1 的 Owner 紧急控制底线；打包探针验证全局暂停、安全隔离和旧契约跳过，不能证明设计事实/V2能力。pd-status 主要比 adapter/host 与 pin 是否一致，且未在该分支比较 core；旧 pin 配旧安装也可显示 pinned match。官方 locator 另外报告两份 plugin data 目录歧义，这是诊断选择问题，不能直接断言两份都在执行或擅删旧目录。

建议：在发布链纳入本次需要的已发布 pin 组合、真实 npm 打包能力探针、插件缓存更新与 setup 后的实际 import/Hook 证明。将“主安装已更新”和“Codex 插件已加载”分开报告；实际运行身份不能只取磁盘 package.json。

### 操作纠正

上轮助手停止旧 worker 后，Companion 自动补拉；助手又手动启动PID45104，造成重复进程。已只撤掉助手额外启动的PID45104。后续现场只见一个该工作区 worker。正式恢复应由既有进程管理者执行，不能与其并行另建 daemon。任务租约不能代替正确的进程生命周期管理。

## 二、新 RuleCode 为什么不合格、内部为什么认可

### 现场证据

原 Artificer run4（2026-10-24T14:12:52.991Z至14:15:55.904Z）真实 succeeded；原 Evaluator run1（14:16:53.637Z至14:18:02.753Z）approved，并写出 adversarialResult.passed=true。

新代码SHA256：e41eb3eb7eee24427afb9b1720885a248e5d97ecfedacacba5148f061b27f964。

安装版独立回放：18合法场景13通过、5失败；7非法事实被validator拒绝。1项为明确未批准的其他受管操作漏拦，4项为 unknown/缺事实时错误block。这是代码本体回放；新宿主的前置隔离可避免 unknown 规则实际执行，不能把本体错误直接声称为已发生的生产误拦。

该 rule 工件 validation_status=validated，source_principle_id=null，contract正确标记Codex/V2/design_approval；该工件审批0、激活0，全库审批7、激活5。原则身份仍是独立未闭合项，不能伪填主 prompt 原则ID。

### R3：原意保留到 Scribe，但 Artificer 将其缩窄成 Git 提交

实际 Scribe run3 的原则与 intentContract 要求：非简单高成本变更编码前经 Owner 显式确认；executionConditions 声明 required design_approval。并非只在git commit/push检查。

实际新代码只识别commit/push。生成器自己的 summary/risks 解释为“无法观察复杂度，所以用提交作为拦截点”；评审把这个范围替换接受为表达能力限制。这是原意实现失败，不是 Owner 批准了范围变更。

宿主设计事实本来负责判断当前动作是否属于已登记范围，规则不必自己从命令猜复杂度。不能以“披露了局限”代替语义一致性。

### R4：历史负例与新事实契约存在冲突，尚未区分“行为证据”和“可执行回放输入”

实际Owner样例3项、模型golden样例5项均不带designGate。V2生成指令要求Owner负例保持block，所有字段和ruleContext必须原样保留；同时要求不得把缺失/unknown解释成明确未批准。

也就是说，系统要求模型在缺少决定性事实的历史负例上作确定性拒绝，却没有提供该拒绝所需的可信输入。模型选择以“unknown也block”满足历史负例，再用commit/push缩小误拦范围。这是可验证的合同冲突；不能据此推断模型具体注意力或思维过程。

不能直接给历史记录补一个虚构的审批事实。Owner标签证明“这个历史行为应纠正”，并不自动证明运行时曾具有某task/spec/scope绑定的审批声明。

建议：保留历史证据与Owner标签；明确其是否具备运行时回放所需事实。缺事实的历史案例须报告不可直接回放的覆盖缺口，不得偷偷改标签或伪造历史。另用明确标记的受控反事实场景检验声明的事实契约，或走正式事实补充途径。反事实不冒充历史，也不授权生产行为。

### R5：评审知识与独立反例都被“样例有没有字段”错误地控制

EvaluatorPromptBuilder.artifactHasDesignGate 仅检查模型goldenTraceCases中的字段，再决定是否加入设计事实语义附录；没有以Scribe的必需事实契约为准。

安装版无模型对照实验：保持原Scribe与意图不变，原样例不带字段时附录不存在；仅在内存反事实副本加字段，附录即出现。该副本未写入生产、未用于生成或审批。这证明依赖已声明，但专门评审规则仍可能不进入提示。

EvaluatorRunner的designScopeCases仅在Owner负例已经包含requiresApproval=true和not_approved事实时派生。本次数量0，所以关键命令变体反例被跳过。通过现有用例只证明命中那些例子，不能证明未执行的必需维度。

另已核实：codeReview维度字段在输出schema中可选，缺失不会直接拒绝；本次实际Evaluator未输出这些结构化维度。这是额外证据缺口，不表示增加字段就能保证语义正确。

建议：按上游声明的必需事实启用知识和确定性矩阵，而不是由生成产物是否主动写字段决定检查强度。缺必需验证应有结构化停点，不能validated。LLM只作语义判断，不能独立取消确定性义务。

### R6：此前试验成功没有覆盖真实旧材料缺字段的路径

此前合格实验与命令缩窄回归使用了含设计事实的测试样例，所以能触发反例。真实原信号包缺事实，走到另一个分支。修复了条件成立时的检查，却没有锁住条件缺失时不能冒充完整验证。

这解释了“已有回归与合格实验，原信号仍误判”，不能据此断定换模型或加token就能解决。当前没有完成模型间对照，不对模型强弱下确定结论。

## 三、最小修复方案（待设计确认，不在本轮编码）

先做交付闭环：复用release identity覆盖托管worker交接；明确活动任务排空/租约与重启上限；补本次已发布插件pins、缓存更新与实际加载能力检查。禁止改安装文件试验、删旧数据目录或无差别重启。

再做规则验证闭环：以Scribe声明和获批原则确定必需验证矩阵；分离历史标签证据与可执行事实案例；修正生成/评审合同冲突，保证unknown不是明确否决；独立验证批准/未批准/无需批准/unknown、撤回、写操作/执行操作/调查豁免、同事实不同命令及参数自报批准。缺必需矩阵或事实来源未覆盖时不得validated。

复用既有Artificer→Evaluator→修订，不新建代理/调度器/通用审批平台，不新增逐工具LLM调用，不提高模型预算。真实旧原信号作为主要验收材料，而非只用全字段人工夹具。

验收：

1. A发布运行中安装B，托管worker最终报告加载B；外部进程不被杀；活动任务无丢失/重复完成；失败有界可恢复。
2. 固定插件旧包可在交付检查中复现红灯；官方更新后真实Hook加载预期包并验证设计事实能力。
3. 以本次坏代码为负控：内部Evaluator必须拒绝或因缺必需材料明确停点，绝不能validated。
4. approved同动作放行、not_approved受管动作阻止、unknown隔离且可见、只读/无需审批放行；不同命令不能绕过已判定范围。
5. 原始历史缺字段路径、全字段路径都测；明确验证执行数、缺口和来源，不把SKIP算PASS。
6. 新代码真实生成、独立回放、真实Hook、安装交付、Owner审批、shadow/live资格分别取证；未经Owner最终治理不激活生产规则。

成本：工程回归与已安装包回放不需模型调用；最终原信号生成才使用现有profile预算。24小时shadow/live门槛保留，不改时钟、不伪造观测。

回滚：既有官方版本回滚及逐规则停用；声明和原信号/任务/审批历史保留。具体进程排空策略和历史案例不可回放的终态语义需在实施SPEC中明确，不能边写边定。
