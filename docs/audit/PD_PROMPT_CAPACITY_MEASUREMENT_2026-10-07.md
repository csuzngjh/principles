# PD 提示词容量测量报告（PD_PROMPT_CAPACITY_V1 Phase C / AC-13）

生成时间：2026-10-08T02:41:57.015Z　测量入口：`packages/pd-cli/scripts/prompt-capacity-measurement.mjs`（可复现；合成样本 + 临时受控工作区 + 真实生产构建器）。

预算 = 2000 UTF-16 字符（`String.prototype.length`），**不是模型 token**。PD token 成本 = null（无 tokenizer/模型绑定；整请求 usage 不可归属为 PD 输出）。

## 场景对照（40 轮）

轮转行使用连续 round keys 做受控模拟；这些轮次不代表真实用户 turn。列表与共享路由的对照使用相同长度、顺序和文本的候选集。

| 场景 | 路由 | 自报 | 候选 | 平均注入条数 | 列表口径字符 | 完整注入块字符 | 模板开销 | 超长 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| small-4/list/selfReport=false | 列表(轮转) | false | 4 | 4 | 336 | 1518 | 1182 | 0 |
| small-4/shared/selfReport=false | 共享 | false | 4 | 4(FIFO) / 4(强制轮转模拟均值) | –(按完整块计费) | 1518 | 0(口径即完整块) | 0 |
| small-4/list/selfReport=true | 列表(轮转) | true | 4 | 4 | 336 | 1873 | 1537 | 0 |
| small-4/shared/selfReport=true | 共享 | true | 4 | 4(FIFO) / 4(强制轮转模拟均值) | –(按完整块计费) | 1873 | 0(口径即完整块) | 0 |
| small-4/list-fifo-degraded | 列表(FIFO降级,轮次丢失) | – | 4 | 4(固定前缀,无轮转) | 336 | n/a | n/a | 0 |
| mid-12/list/selfReport=false | 列表(轮转) | false | 12 | 9 | 1855 | 3812 | 1957 | 0 |
| mid-12/shared/selfReport=false | 共享 | false | 12 | 6(FIFO) / 4.5(强制轮转模拟均值) | –(按完整块计费) | 1980 | 0(口径即完整块) | 0 |
| mid-12/list/selfReport=true | 列表(轮转) | true | 12 | 9 | 1855 | 4167 | 2312 | 0 |
| mid-12/shared/selfReport=true | 共享 | true | 12 | 4(FIFO) / 4(强制轮转模拟均值) | –(按完整块计费) | 1873 | 0(口径即完整块) | 0 |
| mid-12/list-fifo-degraded | 列表(FIFO降级,轮次丢失) | – | 12 | 9(固定前缀,无轮转) | 1855 | n/a | n/a | 0 |
| growth-40/list/selfReport=false | 列表(轮转) | false | 40 | 18.05 | 1888 | 5248 | 3360 | 8 |
| growth-40/shared/selfReport=false | 共享 | false | 40 | 6(FIFO) / 5(强制轮转模拟均值) | –(按完整块计费) | 1980 | 0(口径即完整块) | 8 |
| growth-40/list/selfReport=true | 列表(轮转) | true | 40 | 18.05 | 1888 | 5603 | 3715 | 8 |
| growth-40/shared/selfReport=true | 共享 | true | 40 | 4(FIFO) / 4(强制轮转模拟均值) | –(按完整块计费) | 1873 | 0(口径即完整块) | 8 |
| growth-40/list-fifo-degraded | 列表(FIFO降级,轮次丢失) | – | 40 | 24(固定前缀,无轮转) | 1856 | n/a | n/a | 8 |

要点：
- 列表路由按选中行计费，共享路由按完整注入块计费——同一候选集合的“占用”两个数字差异即模板开销（包装+自报脚注），不能混称。
- `list-fifo-degraded` = 轮次来源丢失（会话重启/无 user_turn）时插件的真实降级路径：FIFO 前缀打包，尾部候选结构性饥饿——这就是 AC-03 要求区分“轮转机会”与“FIFO 不承诺”的实证。
- 超长候选（2100 字符正文）在两种路由下都不可单独装入，与轮转无关（AC-02/AC-05 实证）。

## 受控共享路径 + 事件证据（AC-12 接线证明）

```json
{
  "promptBuildsDriven": 5,
  "eventsEmitted": 5,
  "promptBuildsWithInjection": 5,
  "evidenceRows": 6,
  "evidenceAllRunBound": false,
  "evidenceAllHostBound": true,
  "evidenceAllEventBound": true,
  "runIdentityFixture": "controlled measurement has no host run id; missing stays unknown",
  "evidenceNote": "absence from rows means UNKNOWN (no logs), never zero; self-report is a separate signal and is not compliance evidence; rows never merge workspaces"
}
```

## 预算候选对照（AC-13；同一数据集的受控模拟）

```json
{
  "scenario": "controlled simulation only: same persisted 16 candidates (14 × 60 chars, 2 × 1200 chars), same FIFO order, 40 forced round keys",
  "listRouteAvgInjected": 11.5,
  "sharedForcedRotationAvgInjected": 5.5,
  "sharedFifoInjected": 6
}
```

结论（本任务固定决策，未发起迁移确认）：
- 保持两条路由各自的 2000 计费口径、serializer 与选择器不变。
- 受控模拟中完整渲染口径平均注入 5.5 条，列表口径平均 11.5 条；两条路使用相同 16 个持久化候选，forced round keys 是模拟输入，不代表真实用户轮次。
- 模板收益：共享口径把包装/脚注计入预算，计量更诚实，但等价于隐性降预算；回退成本：路由口径迁移影响所有已激活原则的装入性判定，需要独立迁移任务与真实行为数据。
- 未验证行为改善：本报告只有注入/字符事实；模型遵守率、历史真实注入率、最佳预算均未知（unknown），不得以“平均选中更多/更少”当作行为改善。

