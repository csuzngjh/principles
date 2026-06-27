# Empathy Observer 成本提示 — 设计稿

**Date**: 2026-06-27
**Status**: Spec (pending owner approval)
**Scope**: 1 个前端组件 + 3 个 i18n key，零后端改动

---

## 1. 问题陈述

共情引擎的 `EmpathyObserver` 在关键词未命中时会异步调用 LLM 做深度分析（PR #1073 的 Pipeline 重构后）。每次调用是一次完整 LLM round trip（`startRun → pollRun → fetchOutput`），默认超时 120s、默认 model `anthropic/claude-3-5-sonnet`。

**当前痛点**：Owner 在 PD Web 控制台启用 `empathyObserver` agent 后，**不知道**这个开关背后有持续的 LLM 调用和 token 成本。LLM 消耗对 Owner 不可见。

---

## 2. 目标与非目标

**目标**：
- Owner 首次启用 `empathyObserver` 并打开控制台时，看到一条克制、可关闭的提示条
- 提示内容告知当前使用的 `provider/model` 及切换更便宜模型的途径
- 不增加信息噪音，不强制行动

**非目标**：
- 不改 `prompt.ts` env fallback 默认 model（Owner 选 B）
- 不新增 feature flag（信息性 UI，不引入新的功能子系统）
- 不新增模态对话框或独立 banner 组件体系
- 不做 token 预算硬限制
- 不做每次调用的实时 token 计数

---

## 3. 真实事实基础

调查过程中核实的关键事实：

### 3.1 触发位置

`empathyObserver` 已经是 `ControlCenterPage` 里 `configSummary.agents[]` 中的一个 agent row，拥有现成的 `<AgentRow>` 里的圆形 toggle 按钮（`ControlCenterPage.tsx:440-462`）。API `updateAgentBinding(agentName, runtimeProfileId, enabled)` 已存在且在用。

### 3.2 模型来源

后端 `pd-config-store.ts:122` 构造 `label` 时拼接 `pi-ai: ${profile.provider}/${profile.model}`，说明 `runtimeProfiles[]` 元素的 `provider` / `model` 字段是后端实际填充的（前端 `RedactedRuntimeProfileSummary` type 中这两个字段是 optional）。

### 3.3 i18n 模式

`zh-CN.json` 第 622 行 `pages.controlCenter.*` 有现成键模式（`eyebrow`、`title`、`subtitle`、`configReady` …）所有文案走 `useTranslation` + `t()` + 两个 locale 文件（`zh-CN.json` / `en.json`）。新文案必须走 i18n key。

### 3.4 视觉语言

ControlCenterPage 现有内容：
- `OverallStatusCard`：`bg-panel border border-line rounded-[6px] px-[18px] py-[14px]`
- Warnings 区视觉：`bg-surface/60 border border-amber/20 border-l-2 border-l-amber rounded-[6px] px-3 py-2`
- 现成按钮风格：`ControlCenterPage.tsx:447-449` 的 commit 按钮 `border border-gov bg-gov text-paper rounded-[3px] px-[14px] py-[6px]`

### 3.5 产品气质要求

`emotional-value.md` §4 明确："不追求热闹、高频提醒、花哨动画"，"少而关键的信息，帮助 Owner 进入慢思考状态"，产品气质接近 "Linear 专业克制 + Headspace 宁静感 + 工程治理系统的可信度"。

### 3.6 Decision Gate (PRODUCT_IDENTITY.md)

1. **改善治理循环哪一步**：透明度前置，Owner 启用 empathyObserver 前先得知成本含义
2. **owner-visible evidence**：UI inline 卡可见 `provider/model` 字符串
3. **disable/rollback/defer**：纯前端 localStorage 控制，清掉就重新出现，不动 observer runtime，不需 feature flag
4. **duplicates host capability**：否，empathy observer 是 PD 自有
5. **emotional value**：降低 *失控感*（owner 明确知道哪个 LLM 在被消耗），服务 *安心感*（提示文案不要求立即行动），符合 *注意力保护*（可"知道了"就关掉，不留长期噪音）

---

## 4. 设计

### 4.1 触发条件（双层 gate）

**Gate 1（父组件 `ControlCenterPage`）**：决定是否挂载 `<EmpathyObserverCostHint>`。仅当 `configData.agents` 中存在 `name === 'empathy_observer' && enabled === true` 的条目，且 `localStorage` 未标记 `pd.empathyObserver.costAck === 'true'` 时，才渲染该组件。

```ts
// 在 ControlCenterPage.tsx 的 render 中，OverallStatusCard 之后
const empathyAgent = configData.agents.find(a => a.name === 'empathy_observer' && a.enabled);
const showHint = empathyAgent
  && (typeof localStorage === 'undefined'
       || localStorage.getItem('pd.empathyObserver.costAck') !== 'true');
```

**Gate 2（`EmpathyObserverCostHint` 组件自身）**：维护 `visible` 内部状态，承载"知道了"按钮的 dismiss 行为（§4.4）。Gate 1 负责"该不该挂载"，Gate 2 负责"挂载后 dismiss 了就不再渲染"——一次写两次读，保证 dismiss 体验独立于父组件重渲染逻辑。

- agent 名：用 `enumLabel('featureId','empathy_observer',t)` 友好显示（现成 = "共情观察器"）
- "首次加载但已启用"的提示条件由 localStorage flag `pd.empathyObserver.costAck` 控制

### 4.2 视觉

复用 Warnings 那段的同类低调语言（不加新组件、不开 modal）：

```
位置：Section 1 (OverallStatusCard) 之后、Section 2 (Internal Agents) 之前

视觉：
┌─────────────────────────────────────────────────┐
│ ⚠ amber 左边框                                     │
│                                                  │
│ 共情观察器已启用 — 每次关键词未命中时会调用 LLM      │
│ 做深度分析（当前模型：anthropic/claude-3-5-sonnet） │
│                                                  │
│ 如需节省成本，在 workflows.yaml 的                │
│ pd-empathy-observer.policy.model 换更便宜模型。    │
│                                                  │
│                                       [ 知道了 ] │
└─────────────────────────────────────────────────┘

样式（复用现有 Warnings pattern）：
bg-surface/60 border border-line border-l-2 border-l-amber rounded-[6px] px-3 py-2
```

文案色彩分工：
- 主体：`text-ink-2 text-[14px] leading-relaxed`（与 OverallStatusCard 正文一致）
- 副文案（workflows.yaml 提示）：`text-ink-3 text-[12px] mt-1`
- "知道了" 按钮：仿 AgentRow 充电按钮 `border border-gov bg-gov text-paper rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium`

### 4.3 文案 i18n key

新增到 `zh-CN.json` / `en.json` 的 `pages.controlCenter` 下：

| key | zh-CN | en |
|---|---|---|
| `empathyCostHint.body` | `共情观察器已启用 — 每次关键词未命中时会调用 LLM 做深度分析（当前模型：{{provider}}/{{model}}）。` | `Empathy Observer is on — every unmatched message triggers an LLM call (current model: {{provider}}/{{model}}).` |
| `empathyCostHint.muted` | `如需节省成本，在 workflows.yaml 的 pd-empathy-observer.policy.model 换更便宜模型。` | `To reduce cost, switch pd-empathy-observer.policy.model in workflows.yaml to a cheaper model.` |
| `empathyCostHint.ack` | `知道了` | `Got it` |

provider/model 取不到（API 返回空 / 字段 undefined）时退化为 `t('empathyCostHint.body', { provider: '—', model: '—' })` 并显示，不阻塞渲染。

### 4.4 关闭行为

```ts
const handleAck = () => {
  try { localStorage.setItem('pd.empathyObserver.costAck', 'true'); } catch {}
  setVisible(false);
};
```

- 纯本地状态，不入数据库，不持久到 workspaces state
- 不做"每周一次"的强提醒周期（克制原则）
- localStorage 出错（隐私模式等）时按钮仍可见，next session 仍会出现 — fail-open

### 4.5 组件结构

新增一个文件：
- `packages/pd-console/src/ui/pages/control-center/EmpathyObserverCostHint.tsx`

接口：
```ts
interface Props {
  agent: RedactedAgentSummary;       // empathy_observer agent row
  profiles: RedactedRuntimeProfileSummary[];  // 用于取 provider/model
}
```

内部行为：
```ts
const profile = profiles.find(p => p.id === agent.runtimeProfileId);
const provider = profile?.provider ?? '—';
const model = profile?.model ?? '—';
const [visible, setVisible] = useState(() => {
  try { return localStorage.getItem('pd.empathyObserver.costAck') !== 'true'; }
  catch { return true; }
});
if (!visible) return null;
```

不修改后端任何代码、不修改 `prompt.ts`、不修改 `resolveEmpathyObserver`。

---

## 5. 错误处理

| 场景 | 行为 |
|---|---|
| `agents` 不含 `empathy_observer` | 不渲染提示 |
| `empathy_observer.enabled === false` | 不渲染提示（用户还没启用，"先告知"不是 PD 气质） |
| `agent.runtimeProfileId` 在 `profiles` 找不到 | 仍渲染，provider/model 用 `—` fallback |
| `localStorage` 抛错（隐私模式等） | fail-open：visible 默认 true，下次仍会显示 |
| i18n key 缺失 | 走 `enum-labels.ts` 已有三段 fallback 机制（i18n → local → raw）|

---

## 6. 测试计划

### Unit
- `EmpathyObserverCostHint` 渲染：agent.enabled=true 且 localStorage 未 ack → 渲染
- 不渲染：agent.enabled=false → return null
- 不渲染：localStorage 已 ack → return null
- provider/model 取不到时渲染 `—`

### Component
- 点击"知道了"按钮 → setVisible(false) + localStorage 被写入
- 重新挂载（localStorage 已 ack）→ 不渲染

### Integration（已有测试套）
- `configSummary.agents` 不含 empathy_observer 时 `<EmpathyObserverCostHint>` 不出现在 ControlCenterPage
- 含 empathy_observer 且 enabled=true 时出现在 OverallStatusCard 之下

---

## 7. MVP 三问自答

参照 AGENTS.md `mvp-q-*`：

**`mvp-q-1-what-if-skip`** — 30 天后 owner 仍会在启用 empathy 后不知有 continuous token cost，且不知道在哪里改。问题仍存在。

**`mvp-q-2-how-observed`** — 直接在 PD Web 控制台首页（ControlCenter）可见提示卡，看见即知。

**`mvp-q-3-how-disabled`** — 纯前端 UI，不引入运行时行为变化。出问题只需 PR revert 一个文件。无需 feature flag（符合 AGENTS.md "bug fixes / documentation alignment may proceed without inventing an unused flag file"）。

**`mvp-q-4-emotional-value`** — 降低 *失控感*（"我不知道有 LLM 在跑"），提升 *清醒感*（提示文案不要求立即行动，只说"在哪里自己改"），保护注意力（一次性可关）。把"被观察者的 token 静滴"转化为"已知的、可掌控的成本"。

---

## 8. ERR Checklist（必填）

- **ERR-001 / ERR-005 (as bypass)**：新增组件读 `agent.name` 等字段——这些字段已在 `ControlCenterPage.tsx` 的 `validateRedactedAgentSummary` 里经过 `Object.hasOwn` + `typeof` 校验后传入。组件不接收 untrusted 原始数据，无需重复校验。
- **ERR-009 / ERR-010 (fail loud)**：`provider/model` 取不到时用 `'—'` fallback 是显式降级，文案继续清晰。"不渲染"而非"报错崩溃"符合已有 ERR-002 degradation-with-reason 模式。
- **ERR-013 (untrusted key)**：localStorage 读取与写入用 try/catch 包裹，私有键不依赖 `in` 操作符查找 prototype。
- **ERR-014 / ERR-016 (safe serialization)**：本组件不做序列化。
- **ERR-015 / ERR-018 / ERR-019 (loop state)**：无循环。

---

## 9. Runtime Contract / CLI Gate / Feature Flag

- **Runtime Contract**：本组件不处理 untrusted raw JSON / LLM output / 同步 DB 行——直接消费 ControlCenterPage 已经过 type guard 的 `RedactedAgentSummary` / `RedactedRuntimeProfileSummary`。无 `rc-2-no-as-bypass` 和 `rc-5-Object.hasOwn` 风险。
- **CLI Gate**：不修改 `pd-cli/src/commands/**`，N/A。
- **Feature Flag 注册**：本变更不引入新的运行时子系统 / hook / writer / reader —— 只是一个个人前端 UI 组件，仅显示已有数据。AGENTS.md 规则中"bug fixes/evidence collection/documentation alignment"豁免项适用。无需在 `.pd/feature-flags.yaml` 注册（且该文件尚未随 PRI-239 存在）。

---

## 10. 反模式检查

- ❌ `antipattern-future-extensibility`（"为未来铺路"）— 不涉及。
- ❌ `antipattern-completeness`（"为完整性"）— 不涉及；这是面向已有的 empathy observer MVP-Core 的 Owner 透明度改进。
- ❌ `antipattern-review-missing`（"review 时觉得缺失"）— 不涉及。
- ❌ `antipattern-core-io` — 不涉及 principles-core，不涉及 I/O。
- ❌ `antipattern-new-research` — 不涉及。

---

## 11. 工作量与文件清单

新增文件:
- `packages/pd-console/src/ui/pages/control-center/EmpathyObserverCostHint.tsx` — ~50 行 React 组件
- `packages/pd-console/tests/ui/EmpathyObserverCostHint.test.tsx` — 与 §6 测试计划对应的 unit/component 测试

修改文件:
- `packages/pd-console/src/ui/pages/control-center/ControlCenterPage.tsx` — import + 条件渲染（~8 行加在 Section 1 之后）
- `packages/pd-console/src/ui/i18n/zh-CN.json` — 在 `pages.controlCenter` 下加 3 个 `empathyCostHint.*` key
- `packages/pd-console/src/ui/i18n/en.json` — 同步加 3 个 `empathyCostHint.*` key

预计工作量：1 天内（含写、本地验证、提交）

---

## 12. 残余风险

1. **provider/model 字段可能空**：Worker 因后端 redaction 政策可能在某些配置下被去除。已用 `'—'` fallback 处理。
2. **localStorage 不持久**：用户换设备 / 清缓存会重新看到。这个其实是 fail-open 的优势，不算风险。
3. **i18n key 缺失**：`react-i18next` 不会因缺失 key 报错，会把 key 本身当文案——视觉上不优雅但不损坏功能。需要在实现时确保同步加两份 locale。
4. **未取代真正 token cost 数据链路**——只告知"当前 model 是谁"，不展示"已花多少 token"。这由非目标 §2 明确划界。如果将来 owner 需要 active token 计数，那是下一阶段的独立 feature。