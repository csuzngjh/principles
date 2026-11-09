# PRI-1140 最小 Adaptive Activation 实施卡 v0.1

状态：**已批准（Owner 2026-11-09，附补充条件，见 §11；批准记录 Linear 评论 `9f0e1bcc`）** · 冻结案例清单：`PD-AA-PRI-1140-FROZEN-CASES-v0.1.md`（先于本卡任何候选结果写定）

## 1. 可复现缺口（已按当前代码核实）

交付验收场景中，AA 映射把目标钉死为 `(artifactId, activationId)`（`adaptive-activation-config.ts:24-27`，`resolveAdaptivePriorityForHook` 原样透传）。治理侧既有的 Owner 修订流（`prompt-replacement.ts`）会生成**新 artifact + 新 activation 并停用旧激活**（同 `sourcePrincipleId`）。修订一落地，钉死身份在 `filterPromptActivations`（只取 `deactivatedAt===null`）中消失 → `buildActivePrinciplePromptContext` 判 `target_unavailable`（active-principle-prompt.ts:534）→ **后续每一轮交付验收都静默退回 Native，直到 Owner 手工改插件配置**。干预恰好在治理正常工作时系统性失效。可离线复现：夹具库构造修订前后两个状态即可复现该判定。

## 2. 真实调用链（全部为现有生产路径，候选项只动「选哪一条」）

```
hook:before_prompt_build (openclaw-plugin/src/index.ts:462)
  → sharedHostRuntime.dispatchBeforePromptBuild → host-runtime/src/index.ts:302 beforePromptBuild
      → roundKeyProvider = prepareOpenClawPromptRound（信号收集+轮次，不改）
      → adaptivePriorityProvider = resolveAdaptivePriorityForHook（index.ts:237，改）
      → buildActivePrinciplePromptContext（active-principle-prompt.ts:338，不改：基线→授权复核→prioritized→预算→渲染）
  → beforePromptBuild 回调 = handleBeforePromptBuild（hooks/prompt.ts:534，小改：映射身份比较与 journal 目标）
  → additionalContext 返回宿主
```

## 3. 最小改动

| 文件 | 改动 |
|---|---|
| `host-runtime/src/active-principle-prompt.ts` | 新增导出 `resolveCurrentAuthorizedActivationByPrincipleId({workspaceDir, principleId})`：复用既有 `readPromptActivationCandidates`（readonly + noBusyWait + includeAuthority），按 `principleId` 过滤现行激活；0 条→`principle_not_currently_authorized`，≥2 条→`ambiguous_current_activations`，reader 告警非空→`candidates_unavailable`；恰 1 条→返回其 `(artifactId, activationId)`。不创建授权、不写库 |
| `openclaw-plugin/src/hooks/adaptive-activation-config.ts` | 映射身份二选一：现有 `(artifactId, activationId)`（语义不变）或新增 `principleId`。workspace 作用域、`expiresAt`、`softTimeoutMs` 校验不变 |
| `openclaw-plugin/src/index.ts`（`resolveAdaptivePriorityForHook`） | sentinel 分支：principleId 映射→解析成功才返回优先级（解析结果按 `hookInvocationId` 记忆一次供 hook 消费）；解析失败→undefined（结构化 warn 记原因）。受控准入分支不变（其 manifest 契约钉死 artifact 身份） |
| `openclaw-plugin/src/hooks/prompt.ts` | principleId 映射时，:556 的中途换映射比较与 journal 目标改用已解析身份；取不到→按既有「换映射」语义回退 native baseline |
| 测试 | host-runtime 解析单测（0/1/≥2/告警/停用版次）；插件 config/provider 单测（二选一校验、sentinel 门、受控准入拒绝 principleId 映射）；既有 prioritized 特征化测试保持全绿（钉死路径字节不变） |

共享装配入口 `buildActivePrinciplePromptContext` **零改动**；钉死映射路径字节不变。

## 4. 可用事前信号（不新增推断）

首行 sentinel `[PD-AA:delivery-review:v1]`（验收任务模板带入）、受控准入（不变）、trigger/session 身份、workspace 作用域的显式映射（含过期时间）。**不做**关键词/语义推断（C01：正常任务按原 Native）；sentinel 缺失、非首行、agent-to-agent、minimal trigger → 原样 Native。

## 5. 裁剪边界与依据

第一版**不新增任何裁剪机制**。候选仅继承既有 prioritized 装配的裁剪语义：仅当预算算术强制时挤出普通（非必需）候选，`mandatoryPrincipleIds` 保留、`displacedActivationIds` 逐例落盘（active-principle-prompt.ts:586-597）。生产现状：OpenClaw 调用方不传必需清单（空集），卡片如实记录、不扩权。场景无关裁剪无既有依据，不做。

## 6. 失败回退与回滚

- **回退**（全部落到原 Native，原因外显）：信号不成立（现状）；解析 0 条/≥2 条/读取告警；下游既有守卫不变——`authority_unavailable`、`target_authority_changed`、`target_changed`（授权重验）、`target_ambiguous`、`target_does_not_fit`、`mandatory_constraint_displaced`、`deadline`、预算与去重全部沿用。回退原因经既有 `shared_priority_unavailable`/journal 通道记录。
- **回滚**：映射不带 `principleId` = 今日行为（字节不变，特征化测试锁定）；停用 = 从映射配置删去 `principleId` 或回滚代码。无新开关、无新存储、无 schema 变更（Complexity Delta 全 NO）。

## 7. 验收通过线（冻结案例 16 例，判定线见清单 §4）

1. 定向回归：host-runtime/plugin 既有 AA 套件 + 新增单测全绿；钉死路径特征化字节不变。CI required 门禁绿。
2. 比较判定：16 例中无「未授权注入 / 必需内容丢失 / 关键机会退化」；A4 类关键覆盖改善（Native 系统性错过 → 候选送达）；A1/A2/A5/A6/D1/D2/B/C/E/F 类持平（预期逐字节一致，A6 仅报告字段不同）；A7 两臂均安全（Native 基线减目标、候选完整基线），差异如实计量。
3. 成本口径：非交付轮零新增读取（信号门先于解析）；交付轮至多一次 readonly 解析，chars（判定货币）与 `floor(chars/4)` token 估算（仅参考）逐例报告；选择耗时 hrtime 墙钟。
4. 任一失败判据命中 → 保留 Native，候选不进 PR 主线（只留证据与复盘）。

## 8. 已有案例整理

`PD-AA-EVAL-CASES-DRAFT-v0.1.md` 8 例 fixture 的映射：F-04→A2（同文）、F-03→B1（原本做对）、F-01→A4 的机会结构；F-02/F-05/F-06/F-07/F-08 属行为层，不在装配重放可判定范围。PRI-1152 R1/R2 为受控准入真实运行，历史背景。真实案例 0 条，与本草案结论一致。

## 9. 范围与结论上限

零真实模型调用；不启用生产；不改 Runtime V2 治理；G1/C04/G2 与 Examiner 行为评价保留原边界；PRI-1122 两阶段方案不在本票。达标→候选保留供接入评审；持平/证据不足→保留 Native。单模型/两阶段比较仅当出现可复现语义缺口时另行提案。

## 10. 错误模式路由（Pass 1，已并入验收计划）

EP-12（HIGH）：本票对宿主管理路径**零新增写入**——解析只读（readonly + noBusyWait），journal 仍走既有 `recordAdaptiveDelivery`；diff 中不得出现新的宿主路径写。EP-02：生产入口证据 = 共享运行时真实链路（provider 为具名生产函数）+ 特征化锁定钉死路径。EP-03：全部降级带结构化 reason + nextAction，无空 catch、无吞码。EP-07：解析记忆缓存用有界 `Map`（按 `hookInvocationId` 键、TTL+容量上限，沿用 `rememberAdaptiveConfigIdentity` 形态），身份比较取完整解析对，不用截断投影。

## 11. 补充条件（Owner，2026-11-09，本轮验收依据）

Owner 原文逐字记录于 Linear 评论 `9f0e1bcc`。工程解读与落地方式（与本卡 §3 最小改动合并执行）：

| # | 补充条件（摘要） | 落地 |
|---|---|---|
| 1 | 验收目标 = 换版后，带明确交付信号的请求仍能优先装配唯一、当前已授权版本，无需手工更新映射 | principleId 解析每请求执行；解析+授权复核+在场判定+journal 记录构成恢复的干预链 |
| 2 | 保留旧固定 ID 路径及受控准入语义 | 钉死映射路径与受控准入分支代码不变；特征化测试字节锁定（含挤出语义） |
| 3 | **新 principleId 路径需要挤出原 Native 已装配内容才能放入目标 → 保留原 Native 并记录原因** | 共享装配入口新增可选 `additiveOnly` 门槛（仅 principleId 路径启用）：目标不在原 Native 装配内时仍做 prioritized 重排计算，但仅当重排结果 ⊇ 原 Native 装配集才采用；否则回退原 Native，结构化 reason 记录并将「将被挤出的激活」写入报告。派生事实（诚实边界）：在现行 greedy fair-rotation 下，目标被基线因预算落下时重排必然挤出（头寸证明，见比较报告），故该门槛在预算不足域结构性地回退；目标已在基线内时走既有 `target_present` 同文路径（SPEC §2），不重排、零位移 |
| 4 | 补预算不足反例 | 新增案例 A8：预算不足以可加方式容纳目标 → 新路径回退原 Native + reason；同夹具下旧钉死路径仍按既有挤出语义工作（旧路径兼容性对照） |
| 5 | 选中后目标在最终装配前被撤销或替换 → 本轮回退 Native，下轮重新解析 | 既有授权复核/`target_changed` 守卫沿用（回退安全基线，不含被撤销正文）；解析按每请求执行、无跨轮缓存（TTL 有界、仅本轮 hookInvocationId），下一请求自然重解析。补撤销反例测试 |
| 6 | 补真实装配链回归 | 集成回归：真实 `SqliteConnection`/stores 夹具 → provider 决策 → `buildActivePrinciplePromptContext` 全链断言（EP-02 生产路径证据） |
| 7 | 沿用冻结 16 例，一轮结束即决定保留或放弃；A4 必须展示旧映射换版后失效、新映射经同一装配链恢复目标；核对授权、非目标轮次、旧路径兼容性 | 16 例 + A8 = 17 例一轮跑完；A4 记录旧臂 `target_unavailable`（干预死亡）与新臂（解析成功+授权验证+在场/回退记录，干预存活）的对照；报告如实说明无挤出规则下「恢复」的边界（见上 #3 派生事实）；A4 同时断言授权核对新臂通过、非目标轮次零新增读取、旧路径字节不变 |
| 8 | 报告实际字符变化及解析开销 | 逐例 chars 差异表 + 解析/装配墙钟 |
| 9 | **验收结论限定为换版后的干预连续性** | 本轮结论只主张：换版后干预是否连续、是否零回归、成本有界。不主张行为改善、覆盖扩张或送达效果 |
| 10 | 零模型调用、零生产启用；交回 PR、测试与 CI、逐例结果、保留或放弃决定 | 全程离线；PR 不改生产默认行为（无映射配置时行为不变） |

判定基准更新：本轮保留/放弃以补充条件为准——**换版后干预连续性恢复 + 17 例无「未授权注入/必需内容丢失/关键机会退化」+ 非交付轮零新增开销 → 保留候选供接入评审**；否则保留 Native。原冻结清单 §4.2 的「覆盖改善/开销下降」判据被本条取代（ Owner 指令，日期化记录于清单 §7）。
