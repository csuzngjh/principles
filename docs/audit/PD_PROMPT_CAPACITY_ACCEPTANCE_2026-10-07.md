# PD 提示词容量与生效反馈 — 2026-10-08 修复复验

任务 PRI-951 / PR #1958。原评审 head `789bf618` 的“全绿即完整”结论已被生产身份与恢复路径负例推翻；以下以修复后的实际测试边界为准。默认双路由 2000、serializer、selector 和轮转策略保持原样。

| ID | 结果与实际证据 |
| --- | --- |
| AC-01 | 宿主开关矩阵、Codex 恒共享、未知/歧义宿主与显式目标：`host-runtime/tests/prompt-injection-route-and-deliverability.test.ts`；显式 target 不依赖无关宿主读取成功。 |
| AC-02 | `truncated=false` 的独立超长、批准拒绝、激活行正面单项判定：golden / governance-approve / injection-status 测试。 |
| AC-03 | FIFO 无自动轮到保证；轮转仅作有条件机会：投影、审批文案与相同候选测量。 |
| AC-04 | 生产构建器 golden 保持完整字符串、选择集合、顺序及算术相等。 |
| AC-05 | 临界长度、XML、emoji、长标题、自报开关：真实 serializer 与 UTF-16 计量；不等同模型 token。 |
| AC-06 | 坏配置/禁用 prompt 明确 unconfirmed；缺 DB/解析失败/诊断上限保持可见未知，不由缺字段推出正常或零遵守。 |
| AC-07 | 真实 HTTP 与 Commander parser 拒绝零 mutation；写入批准后的故障保留 approved 和旧 live，恢复重新跑当前容量门。CLI 不把 service.ok 的 refused decision 当成功。 |
| AC-08 | 提交重新读取工件、路由和配置；已批准重试遇新坏配置拒绝且不撤销原批准。意图确认绑定 reviewedArtifactId。 |
| AC-09 | 总需求超载而单项可交付仍按既有激活合同处理，无新增总量准入门。 |
| AC-10 | Scribe 保留最短充分约束、唯一 statement 和原意图字段。触发丢失/动作反转/例外丢失负例显示旧新对照，未确认保持 pending，Owner 可拒绝。语义一致性由 Owner 审阅判断，结构 validator 不冒充语义证明。 |
| AC-11 | 真实旧 `act_prompt_UUID` → 新工件版本身份：HTTP→dispatcher→SQLite→reader。故障保旧、同ID拒绝、已知跨原则拒绝、错误目标/回放身份拒绝、历史同ID精确绑定、缺supersede决策拒绝；v1→v2→v3真实CLI重试只保留最近版live与原批准者。 |
| AC-12 | 实际 producer 发 hostKind/eventId；同run不同构建、跨宿主/工作区不混合。旧事件来源unknown；无日志不代表零次。缺perHostFits显示未确认。 |
| AC-13 | 同一16候选受控复跑：列表平均11.5、共享完整渲染强制轮转平均5.5；原13.05→5.5不公平对比撤销。SPEC旧7.95→2.4是另一快照，不混用。合成run和强制round明确为模拟，PD tokens=null。 |

## 本次根因与错误经验

- ERR-116：测试手写不同ID掩盖默认Writer同原则ID冲突。activation_id并非唯一，不一定覆盖历史；原新旧两行可能一起停用。正式writer重建本次复发，生产身份HTTP及legacy alias回归保护。
- ERR-024：下层恢复存在而公开完成服务提前短路；已通过service→dispatcher→store核验。CLI orchestration ok 与实际 activation success 分开。
- Error Context Pass1/Pass2：HIGH EP-03失败不得变成功、EP-02生产接线、EP-04真实parser分别以HTTP/SQLite故障和Commander矩阵验证。EP-07 lineage由已有工件/store验证，无第二事实源。

## 验证记录

每次命令真实退出码与最终全量结果记录在本任务交付报告和PR描述；旧 `97814bcf` 的 merge gate 记录仅为历史基线，不冒充本次修复证据。

独立 Spec 审查发现的完成早退已修并复审无新blocker；Standards 批量审阅确认复用问题修复后复审。最终结论以当前head与CI为准。

## Complexity Delta

新事实权威 NO；新持久schema/状态 NO；新子系统/后台 NO；新公共合同 YES（既有诊断、替换、审阅工件绑定和重试参数的增量扩展）；新flag NO；新跨包依赖 NO；新宿主行为 YES（SPEC授权写入前容量拒绝及真实事件身份）；新外部网络能力 NO。

既有store负责替换事务和历史，host-runtime负责路由/容量，审批队列保留Owner决定。增量字段隐藏路由差异与恢复目标绑定，不添加store/service/DDL。回退代码时保留不可变工件、批准和supersede历史；不做治理数据删除或批量迁移。

真实历史注入率、模型遵守率和最优预算仍未验证，不能由受控字符测量推出行为收益。
