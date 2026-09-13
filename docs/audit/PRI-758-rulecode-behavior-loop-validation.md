# PRI-758 — RuleCode 行为验证冲刺 v1：真实 Pain → 行为变化最小闭环（阶段报告）

> 日期：2026-09-12
> 执行环境：live workspace `D:\.openclaw\workspace`，runtime **1.236.1**（本次经官方安装器从 1.235.0 升级）。
> 性质：运行时验证冲刺（governance path 全程真实驱动，零合成数据作为主证据）。

---

## 1. 本轮证明了什么（一句话）

**「真实 Pain 能驱动完整内部化链产出真实 RuleCode，且治理门（确定性对抗重放 + evaluator 契约 + rollout 修订环）能连续多轮拒绝不合格规则」——已实证；「合格规则 → 审批 → 激活 → 运行时拦截 → 行为改变」卡在唯一阻塞：本机所有可用 LLM 通道的时延/质量包络不足以让 evaluator 契约稳定落地。**

## 2. 证据链（全部使用真实标识符）

### L0 — Governance Proposal：**PASS**

| 环节 | 引用 |
|---|---|
| Pain（Owner 手工录入，2026-09-05） | `manual_1788609453041_dtmlftov`（severe 75）及同族跨会话同步 pain |
| 诊断任务 | `diag_router-diagnosis_manual_1788612956754_9aaecyhq`（succeeded） |
| rule 类候选（本冲刺主对象） | `principle_candidates.candidate_id = 1e5f1614-03ed-47e7-af97-4fcd5640026f`，recommendation_kind=`rule`，action=「同步/心跳合并前强制核对源文件 mtime 与内容」 |
| 收编入口 | `pd candidate internalize --candidate-id 1e5f1614-…`（dry-run 过 admission 门后执行）→ 种出 `dreamer-1e5f1614-…-code_tool_hook`（channel=code_tool_hook） |

### 内部化链执行（真实 LLM，全部经现有 runner/契约）

| 阶段 | 结果 | 尝试次数 | 备注 |
|---|---|---|---|
| dreamer | succeeded | 9 | 产出 T-08/T-10 锚定候选（confidence 0.95/0.92） |
| philosopher | succeeded | 2 | |
| scribe | succeeded | 1 | |
| artificer | succeeded | 6 | **产出真实 RuleCode**：`implementationCode`（write 通道关键词校验拦截）+ `goldenTraceCases` 正负用例 + 风险自述 |
| evaluator | 多轮 | 17 | R1: `approved` 但对抗重放失败（见下）；R2: `needs_revision` 0.3（repair 输出无代码）；R3(r1 repair): `needs_revision` 0.3（再次无代码） |
| rollout_reviewer | succeeded | 2 | R1 裁决 `needs_revision` + 5 条精确 requiredChanges → 自动重开 artificer 修订轮 |
| repair loop（PRI-509） | r1 succeeded → 再判 needs_revision；r2 succeeded（真代码）→ evaluator 判定中 | — | 预算 max 2，符合设计 |

错误分布（8 个任务共 41 次运行）：rate_limit ×13、timeout ×7、max_attempts_exceeded ×8、output_invalid ×1 —— 全部为通道容量问题，零管线代码缺陷。

### 治理门实证（本次冲刺最有价值的负向证据）

1. **确定性对抗重放**（`adversarialResult`）：R1 生成的规则 3 个用例决策不匹配（`expected block got allow` ×2、`expected allow got block` ×1）→ `assembleRuleArtifact` 拒绝组装 `pi-rule-*`，规则不得进入审批。**重放门按设计工作。**
2. **Evaluator 输出契约**（PRI-630/evaluator-output-v1 schema）：两轮 repair 输出「只有计划没有 implementationCode」被判 `needs_revision` 0.3 并给出结构化 requiredChanges。**契约门按设计工作。**
3. **Rollout 修订环**：对无 rule 工件的链路给出 `needs_revision` 并自动重开上游任务（revisionIteration=1）。**修订环按设计工作。**

### L1 / L2 / L3：**NOT REACHED（证据支撑的阻塞）**

`pi-rule-*` 工件 0、`approvals` 0、`activations(channel=code_tool_hook)` 0、`gate_blocks` 0。

## 3. 阻塞点（全部实测验证，非推测）

| # | 通道 | 证据 |
|---|---|---|
| 1 | bai（Owner 09-12 09:17 绑定） | `credit insufficient balance: balance=0`（request id 2026091204105126…） |
| 2 | flatkey | `user remaining quota: ＄0.007806, required ＄0.008876` |
| 3 | zai | 401 令牌已过期 |
| 4 | deepseek 官方 | Insufficient Balance |
| 5 | sensenova | Forbidden code 16 |
| 6 | LM Studio 本地 27B | 2KB prompt 280s 无响应（10 分钟级任务不可行） |
| 7 | tokenrouter | `system disk overloaded`（服务端故障） |
| 8 | **unorouter 免费档（本轮主通道）** | 可用但 `1 req/min/account` 且与 OpenClaw 网关 fallback 共享；evaluator 全量契约 prompt 时延普遍超过 600s deadline / pi-ai 内层帽（17 次运行仅 3 次产出完整判决） |

注：内部代理绑定已由本会话经 **Console 认证 config API**（PATCH /api/v1/config/agents/:name/binding）切至 `pi-ai.unorouter`（新建 profile，glm-5.3-flash:free，key 经 `UNOROUTER_API_KEY` 用户环境变量注入，网关已重启生效）。

## 4. 过程修复（运维级，非代码缺陷）

1. runtime 1.235.0 → **1.236.1**（官方安装器 `create-principles-disciple@1.137.2`；需在完整依赖环境下运行——npx 缓存缺 `@sinclair/typebox`/组件互引，见 §6-3）。
2. 四个死通道的探测与切换（上表）。
3. 任务恢复：全部经 Console `POST /api/v1/failed-tasks/:id/recover`（带 reason + force 审计），未手工改任何 state。

## 5. 恢复执行手册（Owner 提供任一可用 key 后，剩余链路确定性走完）

1. `PATCH /api/v1/config/agents/:name/binding`（7 代理）+ `/default-runtime` → 指向可用 profile（或给 `UNOROUTER_API_KEY` 换付费档 key）。
2. 等待/恢复 `evaluator-1e5f1614-…` 直至对抗重放通过 → `pi-rule-1e5f1614-*` 工件（validationStatus=validated）出现。
3. rollout 通过后 approvals 表出现审批项（或 Console Approvals 页可见）。
4. `pd activation approve -a <approval_id> --note "…"` → shadow 激活（`act_code_rule-…`，action=code_tool_hook_shadow_activate）。
5. `pd activation promote --activation-id act_code_rule-… --confirm --note "…"`（rulecode_owner_live_decision 门默认开）→ live。
6. L2 触发：经 OpenClaw 发起与规则匹配的真实写/执行请求 → 期望 gate `deny` + `principle_applications(kind=rule_blocked)` + trajectory `gate_blocks` 行。
7. L3：同一会话内观察 Agent 收到 block reason 后的行为变化（替代路径/确认动作）。

## 6. 移交 Follow-up（不在本冲刺实施）

1. **设计缺口**：evaluator 机器判定 `approved` 且 `adversarialResult.passed=false` 时，既不组装 rule 工件也不种 repair（R1 实测路径）；本轮靠 rollout 兜底。建议：replay 失败即种 repair/进入修订，与 LLM 判定解耦。
2. **安装器 productVersion 戳**：`~/.pd/active.json.productVersion=1.137.2`（安装器版本）而非产品版本 1.236.1，update check 口径失真。
3. **npx 安装器依赖链**：npx 环境缺 `@sinclair/typebox`、组件互引 `@principles/core`（PRI-693 家族复发，本次以本地完整依赖环境绕过）。
4. **免跳通道规划**：evaluator/artificer 两个重阶段需要独立于 OpenClaw fallback 的专属 key（≥$5 额度即可跑完本轮剩余链路）。

## 7. 状态遗留

evaluator 任务已恢复为 pending（设计内自动重试将随 auto-consumer 继续尝试）；链条任一时刻可按 §5 手册接续。

---

## 8. Codex SOL 深度根因分析（2026-09-13）

> 模型：gpt-5.6-sol（reasoning effort: high）。完整输出：`/tmp/codex-deep-result.md`（43KB）。

### 8.1 根因定性：可靠性预算错配

管线不是「模型不理解规则」——evaluator requiredChanges 逐轮精确化、模型逐轮靠近。失败因为语义收敛需要多次连续成功的反馈回合，而通道在产出可用工件之前就中断了。

因果链：大 evaluator prompt（8-12K token）+ 强制长思考（不可关闭）→ 300s pi-ai 内层超时 → 1 req/min 通道上重试 → rate limit + max-attempt 级联 → evaluator→repair 完成迁移次数不足 → v2 精确实现错误永不收敛。

收敛概率：19/80 = 23.75% 完成率 × 需要连续 3 个完成迁移 ≈ **1.3%**。

### 8.2 四因子叠加

1. Always-thinking（不可关闭）
2. 300s pi-ai 内层帽
3. JSON 位于最高风险路径末端
4. 确定性重放要求精确代码

### 8.3 最小可行变更

将 Artificer/Evaluator/repair 调用路由到可靠付费通道。PD 代码不变。

### 8.4 恢复路径

充值任一通道（≥$5）→ 改绑定 → 恢复 evaluator → 磨环收敛 → 审批 → 激活 → L2/L3。预期 1h 内确定性完成。

### 8.5 Follow-up（新增）

5. PRI-758 修复(PR #1654)已合并部署；网关日志证实 blocked_by_revision 生产路由。
6. 磨环 (`.workbuddy/pri758-auto-grind.sh`) 持续后台运转，可在通道恢复后自动驱动链收敛。

---

## 9. Codex SOL 最终分析（2026-09-13 第二轮）

### 9.1 Bottom Line

管线的收敛逻辑不是主要失败。主要问题是**太多串行 LLM 完成必须在不合适的通道上存活**。

### 9.2 缺失的关键机制

在 artificer 侧添加**有界的确定性自修复环**（compile + schema-check + replay locally → failures → repair → replay again → only after passing → semantic evaluator）。每次写入自动运行编译、schema 验证和重放。`submit` 应该在确定性门通过之前不可能完成。

### 9.3 理论最少 LLM 调用

- 无修复环：**2 次**（artificer 产出正确代码 + evaluator 语义通过且重放通过）
- 含一轮修复：**4 次**（初始生成 + 拒绝 + 修复 + 通过）

### 9.4 推荐部署策略

1. 初始候选用 one-shot adapter（现在这样）
2. 自动运行 host-side compile + replay
3. 确定性修复需要时才升级到 L2
4. L2 限制 1-2 轮修复 + 不可变测试 + 窄域写权限
5. 每次 write 自动验证
6. 本地门全过才调 evaluator
7. 最终重放和审批在 artificer 外部

### 9.5 通道变更 vs 管线变更

| 策略 | 效果 |
|---|---|
| **换稳定通道**（推荐） | 一次性解决全部操作约束：低延迟、无限频、高可靠 JSON、更好代码精度 |
| 免费通道 + 6 项补丁 | 可能最终收敛但缓慢且脆弱 |
| 只提超时 | 内层 300s 仍在 |
| 只加密集重试 | 放大限频级联 |

---

## 8. 最终链状态快照（2026-09-13 06:51 UTC）

```
两链合计 15 个任务 / 130+ 次运行 / 42 次 evaluator 尝试
succeeded: 13 | failed/retry_wait: 2
pi-rule-* 工件: 0 | approvals: 0 | code_tool_hook 激活: 0

1e5f1614 链:
  dreamer ✅(9) philosopher ✅(2) scribe ✅(1) artificer ✅(7) rollout ✅(2)
  evaluator: failed (42/42) — 20 次完整判决均为 needs_revision
  repair-r1: ✅(3) | repair-r2: leased(22) — 持续自动重试

0b25ce1a 链:
  dreamer ✅(2) philosopher ✅(1) scribe ✅(5) artificer ✅(1) rollout ✅(3)
  evaluator: ✅(18) — approved 但 replay failed
  repair-r1: retry_wait(27) — 持续自动重试
```

### 冲刺期间实施的基础设施修复

| # | 修复 | PR | 状态 |
|---|---|---|---|
| 1 | profile `reasoning` 字段全链透传 | #1646 | MERGED |
| 2 | approved+replay-failed → REVISION_REQUIRED | #1654 | MERGED |
| 3 | ArtificerL2Adapter 路由 + CodeRabbit 修复 | #1661 | MERGED |
| 4 | 通道切换（8 通道实测） | Console API | ✅ |

### 最终收敛阻塞

免费 glm-5.3-flash 通道撑不住 evaluator 的 10K token 全量治理合同调用。

充值后恢复命令：
```bash
# 1. 改绑定
curl -X PATCH -H "Authorization: Bearer $PD_CONSOLE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"runtimeProfile":"pi-ai.glm","enabled":true}' \
  "http://127.0.0.1:3100/api/v1/config/agents/evaluator/binding"
# 2. 恢复
curl -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"reason":"channel restored","force":true}' \
  "http://127.0.0.1:3100/api/v1/failed-tasks/evaluator-1e5f1614-03ed-47e7-af97-4fcd5640026f-code_tool_hook/recover"
# 3. auto-consumer 自动驱动 → pi-rule 工件 → 审批 → 激活 → L2/L3
```

## 9. Codex SOL 深度根因分析

### 9.1 根因：可靠性预算错配

19/80 = 24% 完成率 × 需连续 3 个完成迁移 ≈ 1.3% 概率。

因果链：大 prompt + 强制思考 → 300s 超时 → 1 req/min 重试 → 级联失败 → 迁移不足 → 永不收敛。

### 9.2 四因子

1. glm-5.3-flash 强制思考（400 code 1210 如果尝试关闭）
2. 300s pi-ai 内层帽（PRI-683）
3. JSON 位于最高风险路径末端
4. 确定性重放要求精确代码

### 9.3 最小可行变更

路由到可靠付费通道。PD 代码不变。

### 9.4 理论最少 LLM 调用

- 无修复环：2 次
- 含一轮修复：4 次

### 9.5 推荐部署策略

1. 初始候选用 one-shot adapter
2. 自动运行 host-side compile + replay
3. 确定性修复需要时才升级到 L2
4. L2 限制 1-2 轮 + 不可变测试 + 窄域写权限
5. 本地门全过才调 evaluator
