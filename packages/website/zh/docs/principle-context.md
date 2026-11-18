# Principle Context（原则上下文）

Principle Context 是一份轻量、可选、**只读**的长期背景文件，由你手动维护，帮助 PD 在真实工作场景中选择更合适的原则。物理文件是 PD 工作区中的 `memory/okr/CURRENT_FOCUS.md` —— 整个文件就是上下文；PD 绝不写入、压缩或改写它。

## PD 如何使用它

- 只有在你显式授权外传（见下）后，PD 才会**读取**该文件（每次 Adaptive 选择至多读取一次）。
- 规范化后的内容随 Adaptive Decisions 请求发送到你配置的 `adaptiveActivation.endpoint` —— 它不会进入宿主系统提示词、日志、遥测或任何本地持久化存储。
- 文件缺失、超限或不可读时，选择流程照常无上下文运行，其他行为不变。

## 配置

| 键 | 类型 | 默认值 | 含义 |
|-----|------|---------|-----|
| `adaptiveActivation.sendPrincipleContext` | boolean | `false` | Principle Context 的显式外传授权 |

```yaml
adaptiveActivation:
  endpoint: https://your-decisions-endpoint/v1/score
  model: your-decision-model
  apiKeyEnv: YOUR_DECISION_API_KEY
  sendPrincipleContext: true   # 默认 false；请谨慎显式开启
```

设为 `false`（或删除该键）后，下一轮起 PD **零读取、零发送**，上下文严格留在本地。关闭该键不会关闭 Adaptive 激活本身。

## 数据外传披露（开启前请阅读）

1. **默认不外传**：除非显式设置 `sendPrincipleContext: true`（且宿主 Adaptive 开关开启），上下文不会发送给任何外部服务。
2. **需要显式授权**：只有把该键设为 `true` 才构成授权。
3. **发送内容**：外部 Provider 收到的是 Decisions 请求 `state` 字段内的规范化上下文正文（≤ 4,000 UTF-16 code units）。
4. **本地不落盘正文**：PD 不把上下文正文写入日志、遥测、Trace、Journal、job/result 载荷或错误报告。
5. **PD 不替外部担保**：PD 无法保证外部 Provider 不记录请求内容。
6. **政策由 Provider 决定**：端点运营方如何处理、保留和使用数据由其服务条款决定；开启后不要假设数据不会离开你的机器。
7. **撤销的时序边界**：改回 `false`（或关闭宿主 Adaptive 开关）只阻止**后续**请求，无法追回已发送或在途的请求。

## 各宿主可见范围

- **OpenClaw**：上下文按 agent 工作区隔离（每个 agent 一份文件）。
- **Codex**：上下文跟随你的用户级/项目级 PD 工作区解析结果。
- **WorkBuddy**：PD 工作区是**用户级共享治理工作区** —— 同一份 Principle Context 对你的全部项目可见，不是项目级私有。
