# Adaptive Activation 离线交付核验

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

expected 必填 hookInvocationId、requestId、sessionId、artifactId、activationId、contentSha256；config 包括 host、hostVersion、runtimeMode、pluginVersion、effectiveHookSetFingerprint、evidenceCoverage。缺项与 unknown 分开；coverage 仅取 complete、partial、unknown。现有原则资格、工作区及授权由前置 Reader/场景验证；本工具不重新授予权限。

receipt 为目标专属的四维状态记录，使用 §5.1 枚举和 journal 状态。仅 selected/returned 且 completed 的目标可与独立请求证据一致确认。普通 Native 回退不能代替目标 payload。字段规则由 lib/adaptive-delivery-record.mjs 唯一校验。

requestCapture 包含相同绑定字段与 config，并有 sourceId、reference、boundary、directiveBodies。boundary 必须是 final_model_request；prepared 输入保持未知。directiveBodies 由最终请求边界的受控观察者分离得到，按完整字节匹配，不能由受测 Agent 自报。工具比较所有绑定及配置快照，不把旧版本确认借给新请求。

actionCapture 包含相同绑定字段与 config、sourceId、reference，boundary 为 first_critical_action。requestCapture 和 actionCapture 的 order 为同一个受信顺序域中的 {domain, sequence}，sequence 为非负安全整数。请求严格早于首次行动才计及时；相同序号不构成先于，跨域或缺失顺序为未知。观察者负责证明这是首次关键行动，不能用事后纠正替换。

trust 是**操作者单独选定的受控观测清单**，不能由 input、Receipt、受测模型或本脚本自动生成并信任。它的 sources 数组中，每项为 sourceId、kind（request/action）、provenance、sha256。sha256 使用现有 challenge-freeze.mjs 的 hashOfCanonical 对整份 capture 计算。request 来源为 independent_request_boundary，action 来源为 independent_action_boundary。sourceId+kind 不能重复。fixture 只能产生 fixtureMatch，绝不会输出真实 confirmed。

本工具验证的是内容绑定及信任清单的一致性。它不能凭文件名、provenance 字符串或摘要证明提供者真正独立，也没有凭空建立签名基础设施。操作者必须依据既有证据访问政策选定观察者及清单；若信任来源未建立，结果最多为离线契约测试，不能上传成真实 L1 送达结论。两份由同一受测 Agent 自签的 JSON 不满足独立取证。

## 结论边界

delivery 与 timely 分开。配置 partial/unknown 原样报告，它不否定该次请求独立捕获到正文的事实，也不能被解释成完整配置验证或升级后的生产验收。若请求证据与 execution/payload 冲突，保留引用并返回 request_receipt_conflict，交原有对账处理，不强行凑状态。

本轮尚未接入真实请求 collector 和首次外答观测。mock CLI 测试仅用于验证规则；真实 C04/G1 仍待获准隔离运行与请求关联证据。行为评价继续归 Examiner，本工具始终输出 behavioralImprovement=not_evaluated。
