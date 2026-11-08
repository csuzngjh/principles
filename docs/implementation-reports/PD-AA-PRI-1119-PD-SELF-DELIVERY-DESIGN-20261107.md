# PRI-1119 PD 自有取证路径设计 v2（合并版：shared route 并入 + 异步防错配）

- 文档 ID：`pd-aa-pri-1119-pd-self-delivery-design-20261107`
- 版本：v2（2026-11-07；**合并版**——把 SHARED-ROUTE-INCREMENT-CARD 并入 Path A，替代原 v1 §3 与独立增量卡；v1 能力矩阵 §1/§2 继续有效）
- 状态：**待 Owner 书面明确批准**（观察边界变更 + 新增 PD 事件 + host-runtime 接口增量；方向认可不等于本设计批准；批准前不编码）
- 前提更新：**PRI-1137 已合并（main `6278ec382`）**——插件本地激活读取路线（dedupedV2）退役，shared route 成为 PD 自有 host-runtime 的**唯一**普通装配入口。这使 shared route 纳入从"可选增量"变为 **Path A 的必要条件**：没有 host-runtime 侧逐原则冻结正文，插件在默认路径上没有任何 per-principle 期望可观察。
- 本轮已核实的生产事实：`openclaw.json` 中 `plugins.entries.principles-disciple.hooks.allowConversationAccess` **已经为 `true`**（只读核查 2026-11-07；`before_prompt_build` 在生产 8 天持续触发即为旁证）。

## 0. v1 → v2 变更摘要

| # | v1 | v2 |
|---|---|---|
| 1 | shared route 列为"待批增量卡"（独立文档） | **并入本设计**（§2）：host-runtime `ActivePrinciplePromptResult` 增加冻结字段——PD 自有接口，完全在 PD 仓库内 |
| 2 | 异步绑定简述 | **完整防错配规则**（§4）：有界不可变快照队列、官方事件可验证关联事实的诚实清单、多快照歧义裁决、禁止取最新/FIFO/时间接近/正文合并 |
| 3 | "检查器移植" | **最小化**（§5）：Path A 输入是单条宿主装配文本，不移植 transport 检查器的部件/多消息机制 |
| 4 | 配置代价"一行" | **生产已授权**（只读核查）——零配置变更；缺授权时的不可用报告与回滚规则（§7） |
| 5 | 依赖 `injectedExpectations` hook-result 字段（官方会丢弃） | **Path A 不依赖该字段**：冻结登记走 PD 内存注册表；该字段仅保留给可选上游 wire 贡献，不得成为 Path A 生效条件 |

## 1. 官方宿主能力矩阵

见 v1 §1（继续有效）：`llm_input` 事件字段（完整装配后 systemPromptText + prompt + 隔离 historyMessages + runId/sessionId/provider/model）、context_assembled 阶段派发、**异步（void + catch，无完成回执）**、incognito 不派发、需 `allowConversationAccess`。`onPayload` 插件不可达；`wrapStreamFn` 按 provider 归属作用域（不可透明包装他人 provider）。**官方事件提供的可验证关联依据 = `runId` + `sessionId`（+ provider/model 描述字段）；没有任何字段能把回调绑定到 run 内某一次具体装配。**

## 2. 两条入口的冻结（shared 并入 + plugin-local 现状）

### 2.1 生产者（PD 自有 host-runtime，`packages/host-runtime/src/active-principle-prompt.ts`）

`buildActivePrinciplePromptContext` 在渲染完成后、返回前，把逐原则冻结快照放入返回值：

```ts
interface ActivePrinciplePromptResult {
  // 既有字段不变（additionalContext/principleIds/activationIds/artifactIds/budget/truncated/...）
  injectedExpectations?: { activationId: string; bodyText: string; bodyChars: number; bodyComplete: boolean }[];
  injectedExpectationsOverflow?: number;  // 装配期截断/省略的原则数（可见事实）
}
```

- `bodyText` = 该原则渲染进 `additionalContext` 的**实际转义文本**（与渲染同源同一次，不二次读取）；
- `bodyComplete` = 该文本包含于 `additionalContext` 的包含判定（截断→false）；
- `revision` 在此层不可得 → **不携带**，消费侧记 `unknown`（不制造版本）；
- 上限 64 条 + 溢出计数（与既有契约一致）；
- **完全在 PD 仓库内**（host-runtime 是 PD 包），无官方宿主接口变更。

### 2.2 插件消费者（`packages/openclaw-plugin/src/hooks/prompt.ts`，两条入口同一消费点）

- **shared 入口（默认/唯一普通路径）**：`sharedActivePrinciplePrompt.injectedExpectations`（若存在）→ 作为 `preEscaped` rendered 候选传入既有 `buildInjectedExpectations`；`packing.targetBody` 仍为 target 候选（`preEscaped: true`）。最终 guard、授权重验、deadline 与预算回退**之后**的现有校准逻辑（bodyComplete 降级/整条排除）原样生效。
- **plugin-local 入口（PRI-1137 后仅存于测试/无 shared 结果的防御分支）**：无 shared 冻结字段时 `rendered` 为空——插件**不**反向解析 `additionalContext`、不事后读库；只能产出 target 候选（若 adaptive engaged）。
- shared 字段缺省（旧 host-runtime 构建/字段缺失）→ 该次装配无可观察期望 → 登记 `expectations: [], source: "shared_field_absent"`（诚实缺失，非 0 注入）。
- hook-result 的 `injectedExpectations` 输出字段（发往官方宿主的部分）**保留但不再是 Path A 生效条件**——官方宿主丢弃它不影响本设计任何环节。

## 3. Path A 数据流（合并后）

```
host-runtime buildActivePrinciplePromptContext
  └─ 冻结 injectedExpectations（逐原则，渲染同源）
     → ActivePrinciplePromptResult（PD 内部返回链）
       → 插件 before_prompt_build
         ├─ guard/重验/回退校准（既有逻辑）→ presenceExpectations（三值分类）
         └─ 写入装配快照登记表（内存，runId+sessionId 键）
            ↓
（宿主派发 llm_input，异步，无绑定字段）
            ↓
PD llm_input handler（runId+sessionId 查登记表 → §4 关联裁决 → 有界检查 → PD 事件）
```

## 4. 异步观察防错配（关联裁决）

### 4.1 登记表

- 键：`runId + sessionId`（两钩子共有的全部官方身份）；值：**不可变快照的有界 FIFO 队列**（每键最多 8 条，超出丢最旧并计 `evictedCount`；TTL 30 分钟）。
- 快照：`{ assemblySeq（PD 内每键单调）, frozenAt, expectations, overflowCount, source }`——产生后不可变；**consume-on-read 禁止**（同装配的重试会合法地再次派发 llm_input）。
- 清理：仅 TTL 过期与容量淘汰；run 结束无回调（hook 未派发/incognito）→ 自然过期，无泄漏（上限封顶）。

### 4.2 官方事件可验证关联事实（诚实清单）

`runId`、`sessionId`、`provider`、`model`。**没有**：装配序号、message/request id、attempt id、时间戳（事件本身不带可靠时序标记）。因此**任何把回调唯一绑定到某次装配的方案都是虚构**。

### 4.3 裁决规则（每次回调）

| 活跃快照数 | 行为 |
|---|---|
| 0（键不存在） | 事件 `checked=false, reason=missing_expectations`（该 run 无 PD 装配记录；≠"未注入原则"） |
| 0（键存在但全部过期） | `unknown:expectations_expired`（与缺失区分） |
| 恰好 1 | 绑定该快照检查；事件标 `binding: "unique"` |
| >1 | 对每个候选分别运行检查：**全部候选对每条期望结论一致** → 输出该结论并标 `binding: "all_candidates_agree"`（事实：结论稳定）；任一不一致 → **`unknown:ambiguous_binding`**（附候选数） |

**禁止**（全部不采用）：取最新快照；默认 FIFO 首条；按 frozenAt 时间接近度选择；PD 给快照编号后声称宿主事件携带了它；正文相同即合并不同 revision 的装配事实（每快照独立携带身份与 revision=unknown，永不按正文归并）。

**区分**：缺失（键不存在）≠ 过期（TTL）≠ 淘汰（容量，计 evictedCount）≠ 未注入（快照存在但 expectations 为空 → `checked=false, reason=empty_snapshot`）。溢出（host-runtime 装配期省略）→ `expectationsOverflow` 透传。

### 4.4 乱序/重复/晚到/重试

排序从不被假设：乱序回调与正常回调走同一裁决；重复回调幂等重评（每次派发是独立事实，事件可重复）；晚到（TTL 后）→ `expectations_expired`。**不宣称观察先于提交**：llm_input 派发点在装配后、提交前，但异步派发不构成同步时序证明——事件边界固定为下述观察面。

## 5. 最小检查器（Path A 专用，不移植 transport 检查器）

输入：`systemPrompt: string`（单条宿主装配文本）+ 期望集。保留：完整正文精确包含（位置=system prompt 本身）；三值 `full_hit / checked_missing / unknown`；空体→`invalid_body`、`bodyComplete=false`→`assembly_truncated`、超限→`*_over_limit`、异常→`check_failed`（不阻断宿主回调）。**不引入**：parts 展平、多消息/错误角色扫描（llm_input 的 systemPrompt 是单字符串；`prompt`/`historyMessages` 本轮不扫——记录为覆盖限制）。边界常量：期望 ≤64、单 body ≤64KiB、累计扫描 ≤32MiB、事件输出 ≤16KiB（均实测复核）。

观察边界常量：`boundary: "post_assembly_system_prompt_via_llm_input"`。**不判 D/confirmed/timely；不声称实际请求、网络送达或模型遵循。**

## 6. 事件契约（PD 自有，`runtime_v2_prompt_presence_observed`）

```jsonc
{ runId, sessionId, provider, model,
  boundary: "post_assembly_system_prompt_via_llm_input",
  binding: "unique" | "all_candidates_agree" | "ambiguous",
  liveSnapshots: number, assemblySeqCandidates?: number[],
  checked: boolean, reason?: string,
  results?: [{ activationId, revision: "unknown", outcome, reason?, actualBodyChars }],
  expectationsOverflow?: number, evictedCount?: number }
```

正文、凭证、装配文本永不入事件/日志/异常（rc-8 有界序列化）；遥测 union 门禁按仓库规则同步。

## 7. 权限与回滚

- **现状（只读核查 2026-11-07）**：生产 `openclaw.json` 的 PD 条目 `hooks.allowConversationAccess` **已为 true**；`before_prompt_build` 生产持续触发为旁证。→ **llm_input 无需任何配置变更**（同一授权清单覆盖）。
- **已授权时**：无重复配置。
- **未授权环境**：宿主不派发 llm_input → handler 不执行 → PD 报告方式=注册时（`api.on` 不可用时）或首次装配时写一条诊断事件 `presence_source_unavailable(reason=conversation_access_not_granted)`——不静默、不把缺失解释为"未注入"。
- **回滚**：revert PD 即移除 handler 与登记表（内存态）；`allowConversationAccess` **恢复运行前值**（若本轮未曾改动则保持现状）——不作为清理动作一律删除；该授权扩大的是**本插件条目**的会话内容读取面（宿主文档明示这是信任授予而非沙箱），不得描述为"无副作用"。
- 授权对既有功能的影响：`llm_output` 与 `llm_input` 同在该授权清单下。**更正（Owner 第八轮指令 §四）**：PD 插件**已经注册并运行 `llm_output`**（`src/index.ts` hook:llm_output，PRI-755 接收链）——v2 §7 此前"PD 不注册 llm_output"为错误陈述。Path A 在其旁新增 `llm_input` 注册，不改动 `llm_output` 的任何行为；授权是插件条目级的，其他插件的授权互不影响。回滚=恢复运行前配置值，不一律删除；该授权不描述为"无副作用"。

## 8. 测试矩阵（批准后实施验收）

shared 与（防御分支）plugin-local 真实装配入口；完整保留/重复转义/截断/撤销/回退（既有 599 套件延续）；llm_input 注册→正式 handler→事件写入生产链（模拟宿主事件、走正式注册与消费路径，不手拼关联结果）；同 run 多次装配、旧回调晚到、逆序回调、重复回调；相同正文不同 revision 歧义；跨 run/session 隔离；TTL/容量淘汰/溢出/缺失/过期区分；未授权与 incognito 覆盖限制；检查失败不阻断且留诊断；正文不落盘不进日志；性能与事件字节数实测（新增结论必测）。

## 9. 实施卡（一次批准）

| 层 | 内容 | 文件 |
|---|---|---|
| L1 设计 | 本文档 v2 | — |
| L2 host-runtime 冻结字段 | `active-principle-prompt.ts`（§2.1）+ 单测 | PD 仓内 |
| L3 插件登记表+裁决 | `hooks/presence-registry.ts`（新）+ `hooks/llm-input-presence.ts`（新 handler）+ 最小检查器 + index.ts 注册 + 事件类型 + 遥测 union 同步 | PD 仓内 |
| L4 测试与验收 | §8 全矩阵 + 性能/字节实测 | PD 仓内 |
| L5 回滚验证 | revert 演练 + 授权缺失报告路径 | — |

成本：host-runtime ~30 行 + 插件 handler/登记/检查器 ~数百行（含测试）；运行时=每次 llm_input 一次有界字符串扫描（µs–ms 级，实测后如实记录）；无 I/O、无网络、无宿主改动。回滚=revert PD；无持久迁移。

## 10. 已验证 / 推断 / unknown

- **已验证**：llm_input 契约与派发条件；allowConversationAccess 生产已授权；runId+sessionId 双钩子共有；PRI-1137 后 shared 为唯一普通入口；官方事件无装配级绑定字段。
- **推断（标注）**：llm_input 对工具循环/重试的触发频次（源码判读，运行时确认列入 L4 后的隔离验证）；同 run 长生命周期下队列深度分布（上限 8 为初始值，实测后可调）。
- **unknown（如实保留）**：wire 级正文证据（未修改宿主不可得，D=unknown）；llm_input 在宿主 2026.11.2+ 的契约稳定性；incognito 与 cron 会话的实际派发覆盖率。
