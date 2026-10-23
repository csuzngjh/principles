# 原痛苦 RuleCode 人工补事实实验（2026-10-22）

结论：PASS — 隔离、人工补事实与实验契约条件下，真实 PD Artificer → Evaluator → 确定性沙箱链产出 validated RuleCode；外部执行用例 21/21 通过。不是生产宿主闭环或正式激活。

## 范围与授权

Owner 要求先手工补缺失数据、手动推动真实管道，用实验缩短 PR/发布周期。本实验使用原信号 manual_1791868470372_8c47edyh 的 SQLite 一致性副本及原始 Scribe run3，复用原血缘与已选择的 5371/5300/5368 工具样例。未重新提交痛苦；没有改产品源码、安装文件或生产数据库。实验文件统一位于主项目既有 .tmp/pri-1015-rulecode-recovery-20261021/facts-lab-20261022/。

## 基线与手工干预

- canonical 已安装 core 1.295.2；真实模型 zai/glm-5.3-flash、pd.default、reasoning low、maxTokens 32000；最终调用沿用配置 600000ms 期限，未增加 token 预算。
- 原生产生成前检查缺 trustedFacts；实验通过既有注入口提供明确标注为 EXPERIMENT ONLY 的 not_approved，不伪造真实 Owner 批准。
- 在测试 RuleContextV2 的额外字段 facts.designGate 中放入任务/设计/范围的当前与决定引用、批准状态、撤回标记。现有结构校验允许额外字段，这不是已发布的受支持产品字段，也不是新的生产事实来源。
- 仅在运行时请求副本的系统提示末尾补明实验字段契约。既有提示原文说外部事实不能由 evaluate 读取，与本实验字段不一致；附加说明明确覆盖这一条，其他防伪/验证要求保留。没有修改安装提示文件。
- 首版完整历史导致 Evaluator 在模型调用前触发 50000 字符序列化上限；后续实验样例只省略重复历史调用正文并标注 truncated，保留原参数、来源引用、窗口统计和新增测试事实；完整原证据另存。
- 把首版真实沙箱抓到的两条错误作为明确修订反馈。没有手改 PD 生成代码。

因此，证据支持的是“人工补事实 + 明确实验输入契约 + 有界历史展示 + 真实修订反馈后能跑通”，不能缩写成“只补一个批准字段，原样生产就已跑通”。

## 真实执行经过

1. 原提示不变、补入实验事实：前置门 executable；一次真实生成调用在试验 180 秒时限超时，无产物。这次不能用于判断代码质量或证明提示矛盾导致生成失败。
2. 补明实验事实契约、改用配置期限：Artificer 55.7 秒成功，首版外部 14 用例通过；Evaluator 在调用模型前因 prompt input exceeds 50000 characters 结束。更严格检查发现来源字段不验和 git status; git commit 前缀绕过，未宣称首版合格。
3. 缩短重复历史展示并提交上述真实失败反馈：Artificer 43.3 秒 succeeded；Evaluator 67.4 秒 succeeded；对抗回放 passed=true、零失败；一轮得到规则工件。总计约 111 秒，不包括前两次探索。

最终 ruleArtifactId：pi-rule-lab-facts-compact-1792661476482-evaluator-r1-mvjcdtai-run_lab-facts-compact-1792661476482-evaluator-r1-mvjcdtai_1

这里 loop.decision=approved 是 Evaluator 判定，不是 Owner 批准；没有写入任何生产审批或激活。

## 外部验证

生成后的代码经现有 production gateDeps/hardened VM 执行，不依赖模型自报 passed。21 项全部通过，覆盖：同一操作未批准阻止/已批准放行、工具参数自填批准不生效、改变提交文字、不同任务/设计版本/范围失配、撤回、unknown、事实缺失、无需批准、原调查/状态查询，以及复合命令绕过。

20 项在首版评判前冻结，复合命令为审查首版后新增的定点反例。来源字段与复合命令失败随后已反馈给修订模型，因此最终 21 项是外部执行的回归判定集，不能宣称 21 项全部是模型从未见过的独立留出样例。没有以有限用例证明所有代码语义或长期效果。

负控：always-allow 失败 4 项，always-block 失败 10 项（初始14案）；手写参考实现单独标注非PD生成，不能冒充最终产物。最终文件来自真实 persisted rule 工件，SHA256 47aad195de35f4290f42f92800a9035ed9c6a04344a13af1628614b482dc7a63。

## 生产与能力边界

生产 approvals 7→7、activations 5→5，两个原 Artificer 均保持 needs_human_review / attempt0。隔离副本未注册 worker、未调用治理审批或激活。

人工指定的 requiresApproval 和 task/spec/scope 对应关系是实验输入，不证明 PD/Codex 已能自动可靠生产它们。source 字符串不是身份认证；真正来源可信性必须由宿主输入边界保证。unknown/无效事实对应规则不提供拦截（allow/matched:false），不是已经获批，也不是暂停整个开发任务。

无需靠新PR来继续这种实验：复用隔离副本、输入夹具和直接执行的共享Runner即可。正式修复应基于本次已验证缺口局部处理事实输入契约/提示一致性和Evaluator输入展示预算，再单独验证真实宿主，不重复盲改模型或重建治理系统。

## 工件

- 生成代码：.tmp/pri-1015-rulecode-recovery-20261021/facts-lab-20261022/PD-GENERATED-VALIDATED-RULECODE.js
- 原始持久化工件：同名 .artifact.json
- 最终管道结果：result-compact.json
- 外部回放与真实任务/run结果：FINAL-INDEPENDENT-REPLAY.json
- 可重放无模型检查：node .tmp/pri-1015-rulecode-recovery-20261021/lab-finalize.mjs
- 实验主脚本：.tmp/pri-1015-rulecode-recovery-20261021/facts-lab.mjs（prepare 不调用模型；compact 会真实调用模型并产生费用）

## PD 实际生成的代码

以下逐字来自 persisted validated rule 工件，未手改：

```javascript
function evaluate(input, helpers) {
  var kind = input && input.action && input.action.canonicalKind;
  if (kind === 'read' || kind === 'search') {
    return { decision: 'allow', matched: false, reason: 'read/search actions are outside the design gate' };
  }
  var facts = input && input.context && input.context.facts;
  if (!input.context || !input.context.history || input.context.history.status !== 'available') {
    return { decision: 'allow', matched: false, reason: 'context unavailable' };
  }
  if (!facts || typeof facts !== 'object' || !facts.designGate || typeof facts.designGate !== 'object') {
    return { decision: 'allow', matched: false, reason: 'no trusted designGate fact provided; host isolates rule' };
  }
  var g = facts.designGate;
  if (g.version !== 1) {
    return { decision: 'allow', matched: false, reason: 'unsupported designGate version; treated as unverified' };
  }
  if (g.source !== 'EXPERIMENT_ONLY_OWNER_AUTHORIZED_FIXTURE') {
    return { decision: 'allow', matched: false, reason: 'untrusted designGate source; never claim approval from it' };
  }
  var truthy = function (v) { return typeof v === 'string' && v.length > 0; };
  if (typeof g.requiresApproval !== 'boolean' ||
      !truthy(g.taskRef) || !truthy(g.specDigest) || !truthy(g.scopeRef) ||
      !truthy(g.decisionTaskRef) || !truthy(g.decisionSpecDigest) || !truthy(g.decisionScopeRef) ||
      typeof g.revoked !== 'boolean' ||
      (g.resolution !== 'approved' && g.resolution !== 'not_approved' && g.resolution !== 'not_required' && g.resolution !== 'unknown')) {
    return { decision: 'allow', matched: false, reason: 'malformed designGate projection; treated as unverified' };
  }
  if (g.taskRef !== g.decisionTaskRef || g.specDigest !== g.decisionSpecDigest || g.scopeRef !== g.decisionScopeRef) {
    return { decision: 'allow', matched: false, reason: 'designGate decision does not match current task/spec/scope' };
  }
  if (!g.requiresApproval || g.resolution === 'not_required') {
    return { decision: 'allow', matched: false, reason: 'design approval not required for this action' };
  }
  if (g.resolution === 'approved' && !g.revoked) {
    return { decision: 'allow', matched: false, reason: 'design approval is valid and not revoked' };
  }
  if (g.resolution === 'not_approved' || g.revoked) {
    return { decision: 'block', matched: true, reason: 'Owner design approval required for this non-trivial change but is not approved or has been revoked' };
  }
  return { decision: 'allow', matched: false, reason: 'designGate resolution unknown; host isolates rule' };
}
```
