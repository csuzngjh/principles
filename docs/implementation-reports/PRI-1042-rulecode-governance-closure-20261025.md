# PRI-1042 RuleCode 正式归属闭环实施报告

## 结论与边界

实现 Owner 已书面批准的 SPEC-RULECODE-GOVERNANCE-CLOSURE-003 A+B。已有原则 reuse 可被共用身份解析消费；直接 rule 候选可以单独关联正式原则，并自动启动一次受控修订。绑定、规则批准、shadow/live 与开发设计批准保持分离。

本轮没有改动安装目录或生产工作区，没有替原痛苦信号创建关联、批准规则或激活规则。工程测试通过不等于已安装或 Codex 原生 Hook 已执行新规则；PRI-1044 的 same-artifact native 验证仍须在正常交付后进行。PRI-1045 不在范围内。本轮生成链回归使用测试运行时与真实存储/验证器，不冒充新增真实 LLM 生成或长期行为效果。

## 实现与实际发现

1. Ledger 仍是唯一归属权威：追加 `ruleCandidateBindings` 决定历史，锁内版本/摘要校验、request 幂等、冲突拒绝、独立撤回。撤回不依赖候选/目标目前仍可用，不自动停用已有规则。
2. 唯一身份解析覆盖 derived、正式 reuse 与显式 Owner rule binding；复用既有 reuse 校验器，不把只有 candidateId 的损坏记录当成正式裁决。原候选 kind 不改变，不从相同 pain 或标题借身份。
3. Scribe 在无关联时零模型调用停在人工处置；系统写入身份回执，长调用前后身份变更拒绝提交。Artificer、Evaluator 与发布/审批再次读取当前关系；规则血缘从已验证 Scribe 确定性继承，不信模型自报身份。
4. Console 复用原认证，显示来源、诊断、目标原则版本与独立关联/撤回操作。`resumeOnce:true` 成功后自动续接，失败保留决定及旧工件；修订预算由原任务的执行回执保存，普通历史修订不误判为绑定预算耗尽。
5. 真实拆分诊断将候选写在 diag_router 子任务上：来源验证支持 router → succeeded diagnostician → pain，并检查该候选自己的 run/artifact 与有效输出。其他阶段及错误父血缘仍拒绝；包含修复前失败、修复后成功的同一正向测试。
6. 真实 SQLite 暴露旧工件 upsert 按 task/kind 替换历史。原表增加 `revision_epoch`，同轮保留幂等、跨轮保留旧行；当前输出列表仅投影最新轮次，旧审批/血缘继续通过原 artifactId 读取。修订输入再检查成功 resultRef，缺当前产物不读旧版。没有新增平行工件库。
7. CLI 原 backfill 改成只读核验：旧 null 工件不回填；必须走新 Scribe 修订。CLI 真实规则最终身份复验、删除真实血缘但保留 UUID/receipt 的负控同时成立。

## 验证记录

- core：8,729 passed；6 skipped、3 todo、7 skipped 文件为原配置中的可选/真实环境测试，未为本任务新增跳过。日志 `.tmp/pri1042/core-tests-delivery.log`。
- host-runtime：594 passed，0 skipped。日志 `.tmp/pri1042/host-tests-final.log`。
- pd-cli：2,091 passed、2 skipped（既有配置）。日志 `.tmp/pri1042/cli-tests-final.log`；五文件针对性 63 passed 包括真实规则最终解析与血缘负控。
- Console：2,949 passed、1 expected fail（既有预期失败），152 文件全部通过，日志 `.tmp/pri1042/console-tests-rerun.log`；首次最新全量曾有一个既有 HTTP 测试 `fetch failed: bad port`，保留失败日志 `.tmp/pri1042/console-tests-delivery.log`，未删除/跳过该测试。
- 最后补充的损坏 reuse 裁决负控及 split/迁移定点：3 文件 18 passed；不把只有 candidateId 的记录当成正式 Owner reuse。
- `verify:merge` 在提交前再次 PASS，日志 `.tmp/pri1042/verify-merge-precommit.log`。最后补充的旧 schema 只读检查、严格列表行验证有 2 文件 19 项定点回归，随后由正常 pre-push 门禁复验提交。构建与测试不同时清理共享 dist。曾并行构建导致 child-process 测试缺模块，已纠正执行顺序并完整重跑 core。
- 新增真实持久化回归：绑定/撤回/CAS/摘要、split 来源、独立双 SQLite 连接与重启、普通修订与绑定修复预算、旧 schema 迁移、旧审批引用保留、损坏元数据/epoch 回退零覆盖。
- 新增 Console 真实路径：认证拒绝零写入；关联一次即自动修订；真实 Scribe 新工件、旧工件不变、Artificer 读取新正文；无绑定零模型调用；OwnerDecision 与 grouped views 对 reuse、冲突、不可读、已撤回回执的一致解析。
- 原质量门禁、系统回放、Owner 行为样例包、V2 输入契约与 shadow/live 限制均保留。测试正控使用可执行原则，负控包括相同 pain 不推定归属；不是通过全部拒绝生成来验收。

## 独立复核与错误经验

分别完成 Spec 与 Standards 只读复核。Standards 的实质 P1（损坏元数据默认 epoch 0 覆盖历史）已修复并复核闭合；真实 SQLite 负控证明拒绝后旧工件不变。Spec 复核撤回了“新绑定应无限续预算”的误读，同时指出普通历史修订不能等同于本次绑定预算已耗尽；已用任务执行回执区分并回归。

两条可复用教训按官方 `error:record` 写入 P-ERR-002 / P-ERR-024 occurrences，未手工修改 ERR 权威。错误路由 plan 与真实 diff 两遍均执行。HIGH 项处理：EP-01 严格边界校验；EP-02 真消费者/最终血缘；EP-03 结构化拒绝；EP-04 认证与零写入；EP-05 当前轮次/执行回执；EP-06 原 CLI 输出契约；EP-09 真 SQLite schema/回放；EP-11 唯一 Ledger 锁及来源；EP-13 已批准 SPEC 与现有架构边界。未以新增子系统、flags 或通用 LLM 修复扩大范围。

## Complexity Delta 与回退

| 项目 | 结果 |
|---|---|
| New durable source of truth | NO；新增事实种类为 Owner 绑定，仍由原 Ledger 持有 |
| New persisted schema/state | YES；关联历史/派生 receipt/原任务预算回执/原工件表 epoch，分别由原所有者持有 |
| New subsystem/service/background process | NO |
| New public abstraction/interface | YES；窄身份解析、绑定复核/写入/一次修订 API，隐藏锁与血缘校验 |
| New runtime feature flag | NO |
| New cross-package dependency | NO |
| New host/platform-specific behavior | NO |
| New external/network capability | NO；沿原 Console 和模型路径 |

增加状态和接口是为了表达此前不存在的合法 Owner 关系并保存原治理工件，不能用原 reuse/activation 字段替代。回退可停止新入口、保留只读历史并使用兼容新 schema 的构建。形成多轮工件后，不能假称仅回退旧二进制即可继续写入，也不能删历史去恢复旧唯一键。测试覆盖迁移、再次打开、旧审批引用与拒绝 epoch 回退；本轮未在生产执行迁移。

Owner 可见价值：减少“明明生成了却无法审批”的不确定，说明为什么等待、关联后会发生什么，保留撤回和独立停用控制。发布与安装由现有 changeset/installer 流程承担，本轮不自行发布或合并。
