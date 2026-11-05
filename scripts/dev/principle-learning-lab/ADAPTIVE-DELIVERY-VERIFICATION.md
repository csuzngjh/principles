# Adaptive Activation 离线交付核验

## 隔离的本地传输探针

`probe-local-transport.mjs` 是显式运行的实验入口，不在测试或安装过程中自动启动真实宿主：

```powershell
node scripts/dev/principle-learning-lab/probe-local-transport.mjs --run --openclaw-cli <absolute-openclaw.mjs>
```

它在工作区 `.tmp/aa-local-transport/run-*` 保留独立用户目录、配置、state、原始请求和输出。仅配置回环假 provider，关闭插件和工具，不继承认证/代理环境。配置校验上限 25 秒，单次 agent exec 外层上限 60 秒；超时终止所启动进程树，并保持失败。禁止将宿主 JSON 的 ok 当成进程正常退出。成功要求退出码 0、唯一目标请求、user 消息包含固定非原则标记，以及结构化返回正确的固定回复。宿主可能添加时间/运行上下文，因此标记匹配不是整条 user 消息相等。

原始请求按接收到的字节留存并计算 SHA-256；它包含本机运行元数据，不加入版本库。标准输出只返回摘要和本地目录。运行本探针须有相应的隔离宿主调用授权；不连接付费模型、不写正式安装/治理。调用者须使用经核实的本机 OpenClaw CLI。它不建立操作系统网络隔离，也不授予任何真实调用或安装授权。

本探针证明的是回环请求与响应及正常退出。PD 插件被禁用，`pdPrincipleDelivery` 与 `behavioralImprovement` 始终为 `not_tested`，不能生成原则 confirmed 或覆盖率 D。`probe-local-transport.test.mjs` 使用假 CLI 验证隔离和实际 HTTP 字节捕获；这属于 fixture 测试，不作为真实宿主证据。

每次运行另外记录同一单调时钟原点下的请求收取、首个 stdout、完整结果 JSON、根进程 exit 和输出管道 close 时间。`deadlinePhase` 区分 before_request_capture、after_request_capture、after_result_output 和 waiting_for_output_pipes；它描述截止时的已观测阶段，不自动诊断死锁。外层 60 秒包含启动/准备、请求、输出及清理；内层 `--timeout 45` 不能视为整个 CLI 从启动到退出的保证。阶段记录不延长期限，也不把任何超时重新标为通过。

对应 PRI-1112 与 PRI-1109 的离线准备部分。脚本只读给定证据，不调用模型、不采集宿主、不修改治理或安装。既有 Receipt/Evidence 仍是运行事实的归属。

## 运行

在本工作区执行以下命令。

```powershell
node scripts/dev/principle-learning-lab/verify-adaptive-delivery.mjs --input <input.json> --trust <operator-trust.json>
node --test scripts/dev/principle-learning-lab/verify-adaptive-delivery.test.mjs scripts/dev/principle-learning-lab/lib/adaptive-delivery-record.test.mjs
```

标准输出为一个 JSON，只有及时送达确认时退出 0。缺证、fixture、迟到、错误参数等均退出 1，并用 reason 区分。退出 0 不表示授权、行为遵循、行为改善或 G1 通过。

## 输入与信任边界

input 含 expected、receipt、可选 requestCapture/actionCapture。expected 由本轮已冻结的场景/目标提供，不能从待验证的 capture 自动生成。目标正文摘要是最终编码后完整 directive 正文 UTF-8 SHA-256；捕获器须区分实际指令段和被引用/用户自述文本。不能拿标题或任意子串作为完整正文。原始捕获仅在受控文件中读取，输出只包含有限状态和引用。

expected 必填 hookInvocationId、requestId、workspaceId、sessionId、artifactId、activationId、contentSha256；config 包括 host、hostVersion、runtimeMode、pluginVersion、effectiveHookSetFingerprint、evidenceCoverage。旧输入缺少 workspaceId 时明确拒绝，不从路径或 Session 猜造绑定。缺项与 unknown 分开；coverage 仅取 complete、partial、unknown。现有原则资格和授权由前置 Reader/场景验证；本工具不重新授予权限。

receipt 为目标专属的四维状态记录，使用 §5.1 枚举和 journal 状态。仅 selected/returned 且 completed 的目标可与独立请求证据一致确认。普通 Native 回退不能代替目标 payload。字段规则由 lib/adaptive-delivery-record.mjs 唯一校验。

requestCapture 包含相同绑定字段与 config，并有 sourceId、reference、boundary、directiveBodies。boundary 必须是 final_model_request；prepared 输入保持未知。directiveBodies 由最终请求边界的受控观察者分离得到，按完整字节匹配，不能由受测 Agent 自报。工具比较所有绑定及配置快照，不把旧版本确认借给新请求。

actionCapture 包含相同绑定字段与 config、sourceId、reference，boundary 为 first_critical_action。requestCapture 和 actionCapture 的 order 为同一个受信顺序域中的 {domain, sequence}，sequence 为非负安全整数。请求严格早于首次行动才计及时；相同序号不构成先于，跨域或缺失顺序为未知。观察者负责证明这是首次关键行动，不能用事后纠正替换。

trust 是**操作者单独选定的受控观测清单**，不能由 input、Receipt、受测模型或本脚本自动生成并信任。它的 sources 数组中，每项为 sourceId、kind（request/action）、provenance、sha256。sha256 使用现有 challenge-freeze.mjs 的 hashOfCanonical 对整份 capture 计算。request 来源为 independent_request_boundary，action 来源为 independent_action_boundary。sourceId+kind 不能重复。fixture 只能产生 fixtureMatch，绝不会输出真实 confirmed。

本工具验证的是内容绑定及信任清单的一致性。它不能凭文件名、provenance 字符串或摘要证明提供者真正独立，也没有凭空建立签名基础设施。操作者必须依据既有证据访问政策选定观察者及清单；若信任来源未建立，结果最多为离线契约测试，不能上传成真实 L1 送达结论。两份由同一受测 Agent 自签的 JSON 不满足独立取证。

## 结论边界

delivery 与 timely 分开。配置 partial/unknown 原样报告，它不否定该次请求独立捕获到正文的事实，也不能被解释成完整配置验证或升级后的生产验收。若请求证据与 execution/payload 冲突，保留引用并返回 request_receipt_conflict，交原有对账处理，不强行凑状态。

本轮尚未接入真实请求 collector 和首次外答观测。mock CLI 测试仅用于验证规则；真实 C04/G1 仍待获准隔离运行与请求关联证据。行为评价继续归 Examiner，本工具始终输出 behavioralImprovement=not_evaluated。

## 配置身份与覆盖率汇总

lib/adaptive-config-identity.mjs 将上述六个字段投影为不引用原对象的快照，并复用实验室已有 canonical hash 生成身份。字段顺序无影响；任一值或来源覆盖变化都会改变摘要。partial/unknown 保留原义；缺字段、getter、非法枚举或未纳入契约的额外配置字段会拒绝。此函数只规范化给定事实，尚未实现宿主生效配置的自动采集，也不凭摘要证明来源完整。指纹来源仍按 PRI-1110 定位表由选定 Adapter 取证。

汇总入口在同一进程调用 verifyAdaptiveDelivery，保留工作区、Session、配置及请求绑定；不接受预先填好的 D 或 verifierResult。运行方式如下。

```powershell
node scripts/dev/principle-learning-lab/summarize-adaptive-coverage.mjs --input <study.json> --trust <operator-trust.json>
```

study.json 的 schemaVersion 为 aa-coverage-input.v1。顶层必填 windowId、workspaceId、上述六字段 config、enumeration（complete/sample/unknown）及 opportunities 数组。窗口及分类引用由现有审核/场景记录提供；本工具不证明窗口枚举完整或人工标签正确。

每条机会包含 opportunityId（没有可靠身份则为 null）、sessionId、classification（T/V/O 的 true/false/unknown 三态）、classificationReferences（每个已知分类的非空证据引用）、sameText（三态）和 checks。checks 是已有验证器的完整输入对象数组，共用单独提供的 trust。各 expected 必须匹配 study 的工作区/配置和机会 Session；跨 scope 输入会拒绝整次汇总，不静默丢弃。机会身份按 workspace、Session、opportunityId 组合；回调数不代替机会数。源系统仍须证明这些 ID 真实稳定及 checks 确实属于所列机会。

同一机会可有多个请求。相同调用重复输入只计一次；同一调用的输入或结果冲突，D 保持未知。分类冲突令整个机会未知，不投票或选择有利记录。无稳定机会身份的记录单列 unlinkedRecords，并撤回完整枚举主张。误触发或范围外机会的及时投递只进入 excludedTimelyDeliveries，不进 D；该项未进一步区分误触发/范围外原因。

输出包括各层 confirmed/unknown 计数、四个比率的 exact/lower_bound/not_applicable/unknown、newTimely、重复/冲突/fixture/未关联诊断和配置摘要。样本只报告 sample_only；T 不可枚举或有未关联记录时总体 D/T 保持未知，可另报 linkedSubsetRatios。D 已确认且 sameText=true 时 newTimely 不增加。原始正文和分类引用不默认回显，behavioralImprovement 始终未评价。

退出 0 只表示汇总输入有效，空窗口、未知和下界也可成功生成报告；它与单次及时送达验证 CLI 的退出含义不同。输入、scope 或分类矛盾退出 1 并给出结构化原因。

本轮使用 Node 内置测试验证配置身份、既有验证器、统计纯函数及两个 CLI。当前尚无生产读模型输入接线或真实行为结论。

## 本机宿主入口补查（2026-11-04）

OpenClaw 安装包 2026.10.10 的公共类型定义含 currentUserMessage/currentUserMessageId，但实际 producer 有模式差异。agent-harness-runtime-BeEWzwHa.mjs 的 resolveAgentHarnessBeforePromptBuildResult 从 currentUserMessage 对象取 content/idempotencyKey；agentsapi-attempt-DNXcbiXG.mjs 传入 admittedMessage 或字符串回退。没有 admitted identity 时仍不能假定该 ID 存在。

当前 embedded 的 attempt-system-prompt-prepare-BFRZxKas.mjs 使用 context-engine-maintenance-Cgkf_lx3.mjs::resolvePromptBuildHookResult，后者向 before_prompt_build 只传 prompt/messages。这是本机静态源码观察，未进行真实请求实验。不能将另一运行模式的类型或字段直接当作当前 embedded 已可用能力。
