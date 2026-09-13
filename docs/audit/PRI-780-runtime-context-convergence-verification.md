# PRI-780 Runtime Governance Context 收敛 — 验证报告

> 日期：2026-09-13 · 分支：`ai/PRI-780-runtime-governance-context-rulecontextv2` · SPEC v2（ADR 2026-06-28 amendment）

## 1. 范围与结论

PRI-780 将 `rulecode_context_v2` 收敛为默认治理上下文（default-ON）、删除 Artificer v1 生成分支（v2-only + BEP fail-loud）、为 Codex 落 structured-unsupported 声明。本报告汇总逐条 AC 证据与实机验证记录。

**结论：AC1–AC7 全部满足**；完整 LLM 生成环的 PRI-758 重跑在结构上停在 Owner-labelled BEP 门槛（SPEC Decision 3 的设计终点），机制已实机验证到该门槛，通道已恢复可复跑。

## 2. Acceptance Criteria 对照

| AC | 要求 | 证据 |
|---|---|---|
| AC1 | RuleHost 默认获得 `context.version=2` | flag registry `enabled: true`（`feature-flag-contract.ts`）；新增回归测试 "PRI-780 AC1: a config with NO feature overrides defaults ON and assembles context"（`gate-rule-context-v2.test.ts`，零配置 features → context 组装）；flag 传播测试（null config → enabled:true）；实机：真实 workspace config 无该 flag 条目 → `contextMode: "v2"` |
| AC2 | 历史规则迁移前后行为一致 | 存量 v1 工件评估路径未动（`rule-host.ts` 无 `requiresContextVersion` 分支保留）；`evaluator-out-of-scope-governance.test.ts` 改为直接 seed 存量 v1 工件后全部通过（证明评估侧 v1 兼容在收敛后仍成立）；全量 core 7821 绿 |
| AC3 | 新生成 RuleCode 必须 `requiresContextVersion=2` 或明确失败 | v2-only 输出契约（`validateV2OutputContract`）；runner 缺 pack 在 LLM 前显式抛错；CLI 缺 BEP → `code_rule_capability: OFF (behavior_examples_missing)`（实机输出见 §3.1）；kill switch → `rulecode_context_v2_disabled` 结构化 reason |
| AC4 | 不存在 v2 rule + context missing + silent execution | 双路径既有 fail-loud 保持：legacy `suspended_by_flag`、shared gate `rule_context_v2_unavailable` warning+skip；Codex 声明后 v2 规则在 Codex 确定性运行于 unavailable 契约（非静默）；新增 Codex 生产级测试断言 flag-off 时结构化 warning 存在 |
| AC5 | Console/CLI 可观察 contextVersion=2 | CLI dry-run 输出 `contextMode: "v2"`（实机证据 §3.1/§3.2）；v2 激活默认不再显示 `suspended_by_flag`（flag 默认 on）；`pd runtime features` 默认输出 `enabled: true` |
| AC6 | Codex 支持或结构化 unsupported | Option B（**rev 2 语义**，Codex review round 2 P1 后修订）：Codex 传入**无** provider——v2 规则在 Codex 保持挂起（绝不 context-blind 执行），共享 gate 的 `rule_context_v2_unavailable` 结构化警告经 pd-hook `annotateContextWarnings` 追加显式宿主注记（`codex_runtime_context_unsupported: … v2 rules stay suspended`）后到达 Codex stderr；生产级测试断言：v2 规则（会无条件 block 的实现）在 flag on/off 两态下均被放行（=挂起）且 stderr 含两层结构化警告 |
| AC7 | Reality Evidence：trajectory→assembler→RuleHostInput→decision | ① committed：`gate-rule-context-v2.vm-e2e.test.ts` 用**真实 TrajectoryDatabase**（生产 schema、`recordToolCall` 写入）→ assembler → v2 规则 VM 执行 → block/allow 决策；② committed：`cross-package-acceptance.test.ts` 全链（pain→v2 工件→审批→激活→shadow→live block）；③ 实机：真实 workspace dry-run（§3） |

## 3. 实机验证记录（真实 workspace，零 LLM 消耗）

Workspace：`D:\pd-labs\pri653-e1\ws\main`（PRI-653 实验遗留真实工作区：真实 `.pd/state.db`、`.state/trajectory.db` 80 行真实工具调用、config **不含** `rulecode_context_v2` 条目 → 命中新默认）。CLI：本分支构建的 `pd-cli dist`。

### 3.1 缺 BEP → 显式拒绝（AC3 fail-loud 实机证据）

```
$ pd runtime internalization run-rulehost -w <ws> --pain-id manual_1788488518040_7vcuslxs \
    --channel code_tool_hook --dry-run --json
{ "status": "dry_run", "readinessStatus": "ready", "contextMode": "v2",
  "codeRuleCapability": { "enabled": false,
    "disabledReason": "behavior_examples_missing; nextAction: provide reliable Owner-labelled tool call IDs with --behavior-examples" },
  "behaviorExamples": { "status": "missing" },
  "agentProfiles": { dreamer/philosopher/scribe/artificer/evaluator: "pi-ai.llamacpp" } }
```

关键点：真实 config 未配置该 flag → 默认 ON 生效（AC1）；五 agent 真实解析；生成契约已是 v2-only；缺 Owner BEP → 能力显式 OFF + nextAction，**未降级生成 action-only 规则**。

### 3.2 Owner 标注 BEP → 能力恢复（Owner 门槛机制证据）

用真实 trajectory 工具调用 ID（负样本 id=8 `read/failure`，正样本 id=1,2）构造 `behavior-examples-verify.json`（保留在该 workspace 供 Owner 复跑）：

```
$ pd runtime internalization run-rulehost -w <ws> --pain-id … --behavior-examples behavior-examples-verify.json --dry-run --json
{ "status": "dry_run", "contextMode": "v2",
  "codeRuleCapability": { "enabled": true },
  "behaviorExamples": { "path": "…\\behavior-examples-verify.json", "status": "provided" } }
```

### 3.3 真实 assembler 链

`buildProductionRuleContext` 消费真实 `TrajectoryDatabase.getRuleHostContextRows` 的机器验证由 `gate-rule-context-v2.e2e.test.ts`（G/H/I/J：recordToolCall → before_tool_call → facts 断言）与 `vm-e2e`（到决策）覆盖并将在 CI 持续运行。

## 4. PRI-758 重跑状态

- 通道已恢复：unorouter `api.unorouter.com` 200、253 模型（2026-09-13 探测）。
- 结构性停点：收敛后 LLM 生成环到达 artificer 需要 **Owner-labelled BEP**（SPEC Decision 3），继续推进需要 Owner 从真实 pain 的 trajectory 中标注负/正样本并通过 `--behavior-examples` 提供 —— 这不是缺陷，是本 SPEC 的设计终点。
- 恢复操作：① Owner 标注 BEP（可参考 §3.2 文件）；② `run-rulehost --confirm` 走完生成/评审；③ 审批 → 激活 → live gate 决策（`cross-package-acceptance.test.ts` 已机器验证该后段全链）。

## 5. 测试结果汇总

- principles-core 全量：7821 passed（含迁移后 artificer/adversarial/evaluator 套件 + PRI-780 B2 runner 级缺 pack 前置失败测试）
- openclaw-plugin 全量：2200 passed（2 个 EPERM 临时目录清理 flake 单独验证为环境性：单文件运行通过、stash 后基线复现同错）
- pd-cli 全量：1708+ passed（复跑 0 失败；一次并行 flake）
- **pd-console：activations-console-model 28 passed**（含 B1 迁移的 2 个 kill-switch 测试与 B3 fail-closed 显示回归）
- host-runtime 全量：**308 passed**（合并 main@fe8f8da05 后，含 #1663 新增 receipt-runid 套件；合并前基线为 302）
- codex-adapter：220+ passed（workspace-worker 1 个 EPERM flake，stash 后基线复现同错，环境性）
- `npm run verify:merge`：**EXIT=0**（在合并 main@fe8f8da05 后的最终状态上运行）

`workspace-worker.test.ts` / `principle-application-ledger.steps.test.ts` 的 Windows temp-dir sqlite 锁 EPERM 为**预存环境问题**（证据：stash 全部改动后仍以同样方式失败）。

## 5.1 评审修复轮（2026-09-13，PR #1665 review）

| 项 | 修复 |
|---|---|
| B1 | pd-console 2 个 flag-off 测试改为显式 kill-switch config（`enableV2FlagViaConfig(false)` helper，同步修正 flag-ON 测试的过期注释） |
| B2 | 新增 runner 级测试：缺 pack 在 `invokeRuntime`（LLM 前）失败 + `startRun` 未被调用（无 token 消耗）——覆盖 codecov patch 缺失行 |
| B3 | `computeFlagsFromLoadResult`（pd-cli 与 pd-console 两份）在 config 加载失败时对 fail-closed 门控 flag（`rulecode_context_v2`）强制 disabled + 可观测 warning——显示侧与执行侧（gate ok:false → context undefined → v2 skip）语义对齐；新增 console 回归测试（config 损坏 → suspended_by_flag，绝不 active） |
| M2+M6 | dry-run `capabilityStatus` 改从 EFFECTIVE capability 派生（kill-switch 显示 `OFF (rulecode_context_v2_disabled…)`，不再显示 ON + 误导 nextAction）；`behaviorExamplesReason` 不再被静默清除（behaviorExamples 字段保持 `unreliable` 观测性） |
| M3 | `docs/audit/governance-runtime-map.md` flag 状态行同步（该 flag 移入"Quiet / 默认开（PRI-780 毕业）"） |
| M4 | ADR References 的 Plan 死链删除（该 plan 文件从未提交入库，两处路径均为死链；留历史注记） |
| M5 | 过期注释清理：runtime-activation.test.ts、artificer-runner.ts（"v1/v2 mode"→"v2-only"）、console 测试默认值注释 |
| M8 | `external-review-p0-regressions.test.ts` 的 P0_TEST_PACK 各 case 补 ruleContext（消除 v1 形态 fixture 埋雷） |
| M1 | **决策：保持现行为并记录**——`--confirm` + 缺 BEP 时 CLI 在任何 LLM 消耗前关闭 code-rule capability，管线以 text_principle_only 完成，拒绝原因（`behavior_examples_missing` + nextAction）在 capabilityStatus/codeRuleCapability 字段显式可见。不采用"仅在 dry-run 关闭、confirm 走管线 guard"方案：那会先烧 dreamer/philosopher/scribe 三段 LLM 再失败。文本原则不是低能力规则（非 v1 降级产物），且拒绝结构化可见——符合 ADR A.2.4"缺 BEP = 显式失败、禁止静默降级为低能力规则"的字面与意图。 |
| **Codex R2-P1** | **撤销 unavailable 姿态声明，改为挂起语义**（对 head 的 Codex 复审提出，采纳）：原实现给 v2 规则注入 truthy unavailable context，使"unavailable → allow"契约成为唯一的（prompt 级、非机械强制的）防线——持久化 v2 规则可在 Codex 上 context-blind deny 先前被挂起的调用，零 operator 警告。修订：pd-hook 不再传 provider（gate 结构化 skip 保持），新增 `annotateContextWarnings` 在 stderr 警告上追加 `codex_runtime_context_unsupported` 显式注记（ticket option B 字面：明确 unsupported + 结构化 warning）；生产级测试反转为"挂起 + 双层警告"断言；ADR A.3 重写记录设计变更及理由。 |
| **Codex R2-P2** | 文本 dry-run 的 Next 行接入有效能力：`formatDryRunOutput` 新增 `capabilityEnabled` 入参——capability 关闭时显示 `Next: fix the code-rule capability issue above; --confirm runs text-principle-only internalization.`，不再误导性宣称 "pass --confirm to actually run the pipeline"；补 kill-switch 文本分支回归断言。 |
| **CodeRabbit 场外 Minor** | playbook 附录 B 第 524 行"默认开启 v2（必须显式开启）"改为"默认开启；显式 `enabled: false` 是迁移期熔断"，消除与 §1.2/§13 的矛盾。 |

## 6. 遗留与后续

- 消费环（auto-consumer）中的 artificer 任务在无 Owner BEP 时将 fail-loud（重试后 needs_human_review）——设计行为；若噪音过大，后续可加 consumer 侧 pre-dispatch BEP 门（follow-up 候选，未纳入本 PR）。
- Codex 真实 context provider（Option A）需要 Codex 侧会话工具调用历史数据源，超出本 SPEC 范围。
