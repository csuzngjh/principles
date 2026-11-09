# PRI-1105 B 线实施卡 v0.1：交付轮省略无 Owner 批准的普通指令（R-SP-1）

状态：**待 Owner 书面批准（未编码）** · 冻结案例：`PD-AA-PRI-1105-B-TRIM-FROZEN-CASES-v0.1.md`（先于候选结果写定）· 缺口报告：`docs/implementation-reports/pri-1105-b-step1-gap-20261109.md`

## 1. 已复现的缺口（真实样本）

本机真实 OpenClaw 工作区现有 18 条现行 prompt 激活，其中 4 条**没有 Owner 批准行**，渲染为 `authority="system_policy"`。这 4 条来自 PRI-811 Phase B（2026-09-19）已由 Owner 治理决定关闭的自动激活路径（`ACTIVATION_CHANNELS.md`），属于存量。现行共享路由下（快照重放与 208/208 条真实注入事件逐条一致），模型感知预算和 FIFO 回合每轮都包含这 4 条，4000 预算轮转时一半回合包含。模型感知预算下它们占指令正文 9208 字符中的 1532 字符（16.6%）；4000 预算 FIFO 轮占 41.9%，7 条已注入内容里有 4 条属于此类，14 条 Owner 批准原则只装进 3 条。现有去重只按 `principleId` 去重证据数组，不处理这一类。同原则多版次、正文完全重复两类在真实样本中各为 0 组，不选。

## 2. 唯一规则与资格依据

**R-SP-1**：交付信号轮中，交付目标已在最终装配内（`target_present` / `prioritized`）时，省略 `authority === 'system_policy'` 的普通指令。**必保**：目标、`mandatoryPrincipleIds`、`authority === 'owner'`、授权未知（`undefined`）。依据：INV-05（system_policy 不得表示为 Owner 批准）；PRI-811 Phase B 已关闭该路径；同一提示中的治理段写明 “Only Owner-approved principles may influence or gate behavior”。授权事实取自本轮首次读取（`approvals` 表，`includeAuthority:true`），不新增读取。规则只**删减**，候选正文 ⊆ Native 正文，因此授权变化引起的竞态不可能导致注入。

## 3. 输入、输出与调用链（全部为现有生产路径）

```
hook:before_prompt_build → host-runtime beforePromptBuild（index.ts，转发新可选字段）
  → resolveAdaptivePriorityForHook（插件 index.ts：仅哨兵分支在映射开启时转发；受控准入分支永不转发）
  → buildActivePrinciplePromptContext（active-principle-prompt.ts：既有基线→授权复核→优先/在场→预算→渲染不变；
      仅在 target_present / prioritized 两个返回点，对最终 included 集删去可省项后用同一渲染器重渲染）
  → handleBeforePromptBuild（prompt.ts：终验/预算/截止回退恢复的是未裁剪的 nativeBaseline；journal 记录省略事实）
```

| 文件 | 改动 |
|---|---|
| `openclaw-plugin/src/hooks/adaptive-activation-config.ts` | 两种映射新增可选 `omitSystemPolicyOrdinary: boolean`；值存在但不是布尔 → 映射无效（失败关闭，与 PRI-1140 歧义规则一致） |
| `openclaw-plugin/src/index.ts` | 哨兵分支返回 `omitSystemPolicyOrdinary: true`；受控准入分支不返回 |
| `host-runtime/src/index.ts` | provider 结果类型、布尔校验与转发 |
| `host-runtime/src/active-principle-prompt.ts` | builder 可选输入；两个返回点做删减；`adaptivePacking` 增加 `omittedActivationIds` 与 `omission`（`trimmed`/`none_eligible`/`skipped:<原因>`）；`nativeBaseline` 不裁剪 |
| `openclaw-plugin/src/hooks/prompt.ts` | 仅当最终正文就是裁剪后正文时，journal 闭合记录和 `[PD:AA]` 日志写入省略集合；发生任何回退时写空集合（现有校验器允许额外的纯数据字段） |
| 测试 / harness | host-runtime 单测；插件配置单测；真实链路测试 T1–T6；`pri1105b-trim-replay.mjs` 增加候选臂；changeset（principles-disciple、create-principles-disciple、@principles/host-runtime：patch） |

## 4. 预计收益与开销（由 Native 基线逐块加和推算，非候选运行结果）

真实样本 principleId 路径：20 个交付轮合计 −8.77%，单轮 −8.8% 至 −41.9%，模型感知预算轮 −16.6%（9208→7676）。钉死路径合计 −14.03%。11 个 `would_displace` 轮按设计不省。开销只有内存过滤，加上对最终集合重渲染一次（每轮 ≤ 18 块），无 I/O、无模型调用。通过线：中位数增加 ≤ 2 ms；非交付轮零新增。

## 5. 失败处理

以下情况都**不省略**，输出与今天逐字节一致，原因写入 `omission`：开关缺省；非交付轮；受控准入；目标未在场（任何 `unavailable` 原因）；首次读取有告警（`skipped:reader_warnings`）；`mandatoryPrincipleIds` 非法；无可省项（`none_eligible`）。Hook 终验失败、截止、超预算、映射中途更换或交接缺失时，沿用现有回退文本。这些文本都取自未裁剪的 `nativeBaseline`：一般是 Native 去掉目标，超预算时是完整 Native。因此回退时不会保留任何省略。

## 6. 兼容性与回滚

钉死映射、principleId/additive 门槛、受控准入在开关缺省时字节不变（PRI-1140 17 例重放 + 既有特征化测试锁定）。PRI-1150 存在性期望由 `makeResult` 按最终集合重算，保持同源。停用：从映射配置删掉该字段（立即生效，无需代码）；回滚：revert PR。无新存储、无 schema 变更、无新 `features.*` 开关、无宿主补丁、无模型调用。

## 7. Complexity Delta

新事实源 NO · 新持久化 schema NO（journal 增加可选纯数据字段，校验器不变）· 新子系统 NO · 新公共抽象 NO（既有函数增加可选字段）· 新 `features.*` 开关 NO（既有映射配置增加可选字段，默认关）· 新跨包依赖 NO · 新宿主特定行为 NO · 新外部能力 NO。

## 8. 需要 Owner 决定的一件事

**A（本卡）**：批准 R-SP-1 作为首条删减策略，按冻结判定线做一轮离线验收后决定保留候选或保留 Native。**B（不写代码）**：直接在 Console 治理这 4 条存量激活（批准则变为 owner，停用则所有轮次都不再注入）。选 B 后，本工作区的 R-SP-1 收益归零，B 线结论为 `KEEP_NATIVE`。两者不互斥，但 B 会让 A 在本工作区失去对象。**建议：A**——保留存量供普通轮次使用，同时让交付轮只装配 Owner 批准的内容。若 Owner 本意是让这 4 条在所有轮次退出，应选 B。

## 9. 范围与结论上限

零模型调用、零宿主运行、不启用生产、不改 Runtime V2 治理状态。结论只覆盖：交付轮最终指令正文变短，且关键内容不丢失。不主张行为改善、送达确认（D 仍 unknown）或覆盖提升。后续候选（本卡不做）：每块重复的样板句（约 87 字符/块）；先删减再加入目标，用于恢复 `would_displace` 轮的覆盖（需另行授权挤出）；语义近重复无法用确定性规则处理，留作模型方案反例。
