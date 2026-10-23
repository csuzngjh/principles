# PRI-1019 实施与真实验收记录

日期：2026-10-23。依据：Owner 已批准 SPEC-RULECODE-CODEX-LOCAL-CLOSURE-001 v0.1。

## 结论

源码接线与真实生成已验证；原信号的正式用户级闭环尚未完成。不得将本报告解释为生产升级、原规则已可审批或 live 激活成功。

| 维度 | 核实结果 |
|---|---|
| SOURCE_VERIFIED | Owner 认证声明、单表 revision/CAS/撤回、正式 facts、生成能力、worker 接线、系统隔离与回归已实现 |
| REAL_GENERATION | 原信号成功 Scribe run3 + 真实 zai/glm-5.3-flash，最终 Artificer/Evaluator 均 succeeded，产出 validated rule |
| INDEPENDENT_REPLAY | 18 个合法上下文通过；7 个坏版本/字段/绑定上下文由正式 validator 拒绝；不是 25 条规则代码执行全过 |
| NATIVE_HOST_VERIFIED | PARTIAL：真实 Codex 隔离 HOME/cwd、手写 fixture 的 deny/allow/复合命令已验证；最终模型生成 V2 工件的完整原生 live 验收未完成 |
| INSTALLED_VERIFIED | 隔离官方 pd-setup 安装通过，已从安装位置实际 import 验证新能力；用户 canonical/private 生产安装未替换 |
| ORIGINAL_SIGNAL_REVIEW_READY | NO：两个生产 Artificer 任务仍 needs_human_review，不能用副本工件替代 |
| LIVE_ACTIVATED | NO：生产审批 7、激活 5，前后未新增审批/激活 |

## 改动及保证

- Console 复用服务端 Owner 身份；body 伪造身份被拒；只能选择已有 Codex 原生证据与项目轨迹共同证明的会话。
- 单一 append-only design_gate_declarations 权威，CAS 冲突不覆盖；SPEC 字节摘要变化拒绝旧决策更新；撤回仍可执行。
- 工具 facts 不从参数中获取。审批、无需审批、明确未批准与 unknown 分开；撤回无需审批声明不会残留豁免。
- 路径 realpath confinement；apply_patch 检查全部目标，无法解析不回退工具自称的路径。只读 shell 只认完整受限形式，复合命令无前缀豁免。
- `.` + execute 只治理该项目/会话发起的调用，不承诺沙箱化进程副作用，也不证明实现符合自然语言 SPEC。
- 生成时检查正式事实能力，不检查内部 PI 任务是否已获开发批准。前置门和 Runner 共用逻辑；Codex worker 注入同一 port。
- Evaluator 从真实 Scribe 条件签发 requiredFactKinds，模型不能自报该权威。事实 unknown/missing 的依赖规则由系统跳过并告警，健康兄弟规则继续执行。
- Artificer 明确宿主事实已决定适用范围，不得把原则缩为 git commit 字符串。独立确定性评审新增同一拒绝事实、不同命令的反例；模型自报 approved 也不能绕过。
- 展示去重同时覆盖 goldenTraceCases 与 ownerGoldenTraceCases；不修改存储材料和沙箱回放，不提高 50000 上限。

## 真实生成过程与证据边界

第一份真实代码生成耗时 555.5 秒，Evaluator 在模型调用前因重复材料超过 50000 字符而失败。修复 owner 样例镜像的展示去重后，复用原代码进行真实评估，评估器 approved；独立反例发现只拦 git commit，不能据此认定合格。

随后通过既有 Artificer 修订反馈提供具体失败输入。两次模型修订因额外自造样例不符合事实 schema 而被拒，未弱化校验。最终生成 49.5 秒、真实评估 45.0 秒，代码未被人工编辑。新增生产回归保证上述命令缩窄问题会在确定性评审被拒。

共 6 次实际模型调用；另有调用前长度拒绝，不计为模型调用。保留原 profile：zai/glm-5.3-flash、low、32000 tokens、600000ms，未提高预算。

最终代码 SHA-256：`1f7783cd9aefb6ba10063776abc136bc20639aee5a0aee3725458bb151d9acef`。

原 21 案并非全盲；部分案例早已反馈给模型，本轮不同命令反例也进入修订反馈。复用原 20 项冻结样例及原报告中的第 21 项复合命令，再加 4 项新情景，共 25 项：其中 18 个合法上下文做规则回放，7 个输入校验拒绝。早期辅助脚本把 unapproved 误匹配为 approved、抹平了事实差异，其结果已作废，不能引用旧 independent-replay.json 声称质量通过。

长期回归位于 host-runtime/tests/fixtures/pri1019-generated-design-gate.json：代码字节不变；命令、路径及引用已脱敏，明确为 counterfactual 测试，绝非真实历史 Owner 批准。始终放行/始终阻止负控均失败。

原始详细试验记录保留在本任务忽略目录 `.tmp/pri1019/formal-generation/`；不把原始轨迹、身份凭据或 auth.json 提交到仓库。

## 当前检查

- core：8651 passed；仓库既有 7 文件跳过、6 skipped、3 todo 如实保留。
- host-runtime：587 passed。
- codex-adapter：314 passed / 1 skipped。
- 新 Console 三文件：16 passed；Console typecheck/build 已验证。
- merge gate 在第一轮源码已 EXIT=0；最后质量修订后的最终 gate 以交付回执/CI 为准，不复用旧成功记录。
- 首轮双轴子代理审查与根代理生产路径复核已完成；后续真实试验修订由根代理复核及回归锁定，未声称获得第二次独立子代理评审。unknown 依赖规则隔离缺口已修并记录 ERR-102 recurrence。

## 原始候选与实际停点

只跟踪 `manual_1791868470372_8c47edyh`。生产两个 Artificer 原停点分别为 trusted_fact_provider_absent 与 execution_conditions_missing；未重报痛苦。

候选 52d98a96-65b9-4952-82c5-51ba2d853c53 为 consumed，ledgerEntryId 为空。不能仅据此判为数据损坏：官方 candidate repair 明确以 recommendation_kind=rule 拒绝把规则候选写入 Principle Ledger。修复命令并未补写原则，不可绕过其分类门禁。

隔离激活实验返回 activation_failed: invalid_artifact，审批回滚 pending。该隔离工件 source_principle_id 为 null，实验工作区又没有完整原则账本与治理身份血缘，因此此结果不能直接归因为生产安装缺陷。真实规则候选如何绑定所执行的已批准原则，仍需沿正式治理路径核实；禁止直接填主 prompt 原则 UUID 冒充关联，禁止自动作 reuse 决定。

正式 V2 shadow→live 当前门槛包含 observed>=20、matched>=3、neutralControl>=1、观察至少24小时。未运行该矩阵、未改时钟、未伪造 shadow 记录，也未降低门槛。Owner 对隔离测试的授权不代表可以绕过产品资格检查。

L07/L09/L10 的最终模型工件真实宿主矩阵、L11 的生产渠道实装与 L12 的原任务待审工件仍须完成。新代码须先经 PR/正常发版送达；本次只验证了隔离候选安装，不能声称已更新生产。

## Complexity Delta

New durable source of truth: YES — 仅 Owner 设计事实声明，现有原则 approvals/intent_decisions 不拥有该语义。复用 state.db，认证/CAS/撤回回归；停用目标规则停止消费。

New persisted schema/state: YES — 一个加法表及不可变 revision；不修改既有审批权威，保留历史，可回滚旧程序。

New public abstraction/interface: YES — 扩充现有 trusted-facts 与 RuleContext 契约，实际 core/host/adapter/Console consumers 已接线；无新泛化注册框架。

New host/platform-specific behavior: YES — Codex 原生身份/路径/工具事实投影。已有 host 关闭及逐规则停用可回滚。

New subsystem/service/background process: NO。New runtime feature flag: NO。New cross-package dependency: NO。New external/network capability: NO。

## 回滚与交付

只回滚本分支源码与通过官方渠道安装的候选；不删除生产声明、原痛苦、任务或审批历史。原生产安装尚未替换，当前不需要回滚生产运行时。加法 schema 旧程序可忽略；有问题的规则通过既有停用机制撤回。

Changeset 已包含 core/host-runtime/codex-adapter 及承载 Console 的 installer。合并、公共发布、signed channel、用户安装和规则激活是不同状态，均需单独给出证据。
