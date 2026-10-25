# PRI-1041 RuleCode 验证闭环修复回执

日期：2026-10-25。源码候选与隔离真实生成验收；不是生产发布或激活回执。

## 结论与影响

原痛苦材料在隔离一致副本中，经真实GLM L2生成、原Evaluator及独立系统验证，已产出validated RuleCode。最终代码未经手改：SHA256 `37fdf152c1ea541dbdd8098ce96cf50c4a62b9604104348a34d83d4ec1c68ae1`。独立冻结留出8/8通过，系统契约35/35通过，实际RuleHostWriter.canActivate返回ok=true。它不再只识别git提交，缺失/unknown不被当成明确拒绝。

历史3项保持原字段和标签，明确historical_evidence_only（无法直接回放），没有编造历史批准，也没有计为历史回放成功。允许其在独立契约验证完整通过后作为可审查工件，是本会话Owner明确委托技术细节后采用的方案；不替代Owner审批、原则身份或激活资格。

## 修复的真实连接缺口

- 必需验证由实际Scribe声明决定，不再由模型是否在样例里写出字段决定；不支持的必需事实显式停点，不能静默装配丢失。
- 同一资格/义务派生贯通Artificer Runner、L2 replay/submit、Evaluator、rule装配；不是只在末端加提示。
- 历史可回放、仅行为证据、损坏输入分开；系统反事实明确标记来源，不写回历史。required/executed/pass/fail/unavailable可查，skip不算pass。
- 模型自报passed不能取消系统验证；实际坏代码、alwaysallow/block、只认样例命令负控不能产生合格rule。
- 真正试跑暴露“模型approved且requiredChanges空，但确定性失败”会种出无法hydrate的修订metadata；修复由系统真实失败生成非空修订要求，保持严格parser，未放宽校验。
- 正确代码曾被评审错误要求改历史负例。修复prompt-only投影：历史证据移出可执行列表、保留原标签和来源；模型镜像不成为Owner权威。精确重复历史仍去重，不提高50000上限或裁核心原意。

## 真实模型过程

源：原52d Scribe run3与已登记Owner行为样例，原历史没有补造designGate。profile沿用 `zai/glm-5.3-flash / low / maxTokens32000 / timeout600000ms`。

首版L2代码约400.6秒，模型Evaluator approved，系统35项中3项失败，未产rule，验证了独立拒绝真实可达。随后发现并修复修订载荷问题；复用首版代码真实复评后进入既有修订链。真实L2修订约176.6秒产最终代码。评审一次缺修订ledger字段被schema拒绝并按既有重试反馈恢复；正确代码的35项系统验证已通过，但模型仍把历史标签当可执行要求。修复展示投影后，复用同一代码再次真实评估，约48.6秒approved并产validated rule；没有手改代码、改历史、提高模型预算或绕过失败。

最终工件：`pi-rule-evaluator-pri1041-recheck-1792906581276-run_evaluator-pri1041-recheck-1792906581276_1`。

实验日志记录7次真实Runtime启动，含两次L2代理运行；L2内部可能多轮模型/tool交互，不能把7声称为HTTP模型请求数。修订载荷失败那次在模型前拒绝。原证据pack实验前后摘要一致：`9eb6ba98e6428e45c2d9dce58f1c83dd5c09ac00944ef2de62124e5140527c5c`。

## 泛化与独立验收

独立代理先冻结五家族34案，fixture SHA256 `CAC5118996B5F646107BCAE7F94B84281FD3C70E25F2D10468A0D67F0603E1E6`；具体留出未进入生成/修订提示。

设计审批、先读后写、明确路径read禁令、无外部事实、未知必需事实分别通过真实Runner/Evaluator/装配consumer验收；只有模型边界用doubles，不能称为所有家族均已真实模型生成。合格正控能通过，常量/样例匹配/本次坏代码负控不能通过，未知契约零模型停点。没有把read永远放行、execute永远阻止推广到全部原则。

本次真实生成代码对应设计审批家族的8项冻结回放全部通过；其他家族以引擎边界与明确验收夹具证明，不冒充其他Owner原则或模型生成能力。系统35项是公开契约回归，不称未见测试。

## 检查与评审

- 最新core全包：442文件8701 passed；既有7文件跳过、6 skipped、3 todo保留。一次并行全跑出现无关性能测试5000ms超时，原断言未改，单独32项及后续全量均通过。
- 独立源码两轴审查：132项精准回归通过；随后展示投影delta独立复核27项通过，无已证实P0/P1或验收违约P2。
- 展示投影/adapter快照等158项通过，长重复历史仍低于50000；core typecheck通过。
- 修订模型approved+确定性失败→有效修订metadata→可解析Scribe的真实store回归4项通过。
- 最终mergegate与当前HEAD远程CI以交付记录为准，不复用旧通过冒充。

## 安装与宿主证据边界

官方隔离pd-setup以受支持source选项安装候选，并实际import验证。实际安装provider的11项技术投影通过，涵盖未登记、明确批准/否决、撤回、SPEC变化、会话/范围、参数伪造等；技术fixture身份不是生产Owner批准。

真实Codex0.164.0原生SessionStart/PreToolUse子进程已证明HOME/USERPROFILE/CODEX_HOME/cwd/PD_WORKSPACE隔离、调用实际私有候选adapter。Windows hook中带空格绝对可执行路径问题通过仅隔离配置使用bare node解决；未改用户生产配置。之后官方runtime init仅初始化隔离workspace。

未验证最终生成工件的原生“真实写入被阻止/获批后写入成功”矩阵。未执行正式Owner认证声明、最终工件shadow/live观察或生产激活，不把provider投影、沙箱回放、Hook加载冒充这些事实。隔离最终rule的sourcePrincipleId仍null：能过Writer技术门不等于能过Dispatcher原则身份/治理门，不能伪填主prompt原则UUID。

本回执不声称用户级原任务已恢复待审或生产运行时已升级；此次真实模型运行在副本中。原信号未重新提交，生产安装/配置/DB未直接修改，无新增生产审批或激活。

## Complexity Delta 与回滚

新durable truth、schema、服务、runtime flag、跨包依赖、外部能力均NO；扩充现有验证报告与L2内部上下文、系统派生展示字段YES，复杂度集中在一个私有验证模块，真实消费者均接线。没有新泛化事实平台或针对某痛苦ID/命令的生产特例。

回滚代码与官方安装版本，保留历史与治理状态；已有规则不被自动唤醒或激活，24小时shadow/live门槛不变。P-ERR-102已通过官方记录器登记声明义务不受被检模型控制的recurrence，handbook验证通过。
