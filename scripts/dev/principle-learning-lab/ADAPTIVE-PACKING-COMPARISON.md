# AA 单目标装配离线比较准备

对应PRI-1108的实验准备，基线accc988f7。入口lib/adaptive-packing-comparison.mjs，协议为本地函数参数；不是生产选择器，也未接入prompt hook。

输入为调用者已从现有Reader取得的候选、精确Artifact/Activation目标、选择预算、可用于原则正文的最终预算及可选轮次。复用现有trimToBudget、XML escape和renderer。先算原Native；目标完整指令已出现则字节原样复用，addedTarget=false。否则目标优先，其他候选保留原轮转相对次序；最终完整正文或容量检查失败返回原Native，成功记录挤出的activation。返回preparationOnly=true及delivery=not_tested，不创建授权或送达事实。

最终预算必须由宿主扣除其他上下文后提供，不能直接用短列表选择预算替代。helper没有模拟真实size guard、当前用户身份、撤销/工件修订重验或回执；它的结果不能作为运行期授权、注入或行为收益。

只读当前激活快照18条，目标匹配1条。固定选择预算4000，枚举18种轮转起点：13种Native已有目标。剩余5种在最终正文预算4000时全部回退；在最终正文可用11000且背景占用为零的对照中全部补入。现有resolveTotalInjectionBudgetChars(4000)=11000是原则加背景的总量，实际可用余额未知，因此后一结果仅是零背景上界，不是实际宿主通过。原始快照和两组结果仅留.tmp/aa-native-baseline，不提交治理正文。

验证：新增5项装配比较测试，覆盖新增/挤出、Native原样复用、列表成本和指令成本差异、缺目标/放不下回退、重复身份与非法预算。连同现有工具共66项测试通过，0失败/取消/跳过。

后续正常入口验收仍需真实用户信号身份、Reader资格与临返回重验、背景占用和最终size guard、独立请求确认。PRI-1108整票不因这些离线结果关闭；不把实验helper引入生产核心出口。
