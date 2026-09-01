# PRI-642 Pain Evidence Ingress — End-to-End Execution Prompt

你是 PRI-642 的唯一实现代理。持续工作直到本指令的完成条件全部满足，或遇到无法通过仓库、测试、运行时和官方资料解决的真实外部阻塞。不要把阶段性绿灯、部分迁移或仅通过单元测试报告为完成。

## 目标

完整实现并验证：

`D:\Code\principles-PRI-642-pain-ingress-contract\docs\superpowers\specs\2026-09-01-pain-evidence-ingress-contract-spec.md`

必须完成 SPEC rev 2 的 Scope A（PRI-642 闭环）以及 Scope B（系统性收敛）。Scope A 先独立变绿；Scope B 不得反向扩大或阻塞 Scope A。Codex 是否迁移由 B4 parity gate 决定：如果保持现有 Codex 深模块作为 peer adapter 更安全，这也是合规结果，但必须有冻结 fixture 和消费者测试证据。

## 工作区与权限

- 专用 worktree：`D:\Code\principles-PRI-642-pain-ingress-contract`
- 分支：`ai/PRI-642-pain-ingress-contract`
- 该 worktree 内现有未跟踪 SPEC 和本执行指令属于本任务，必须保留并纳入实现提交。
- 从现在起你是该 worktree 的唯一 writer。不要在 `D:\Code\principles` 主检出区写入。
- 不使用 stash、`git reset --hard`、`git clean`、`git restore .` 或其他会破坏未知工作的命令。
- 可以创建小粒度 checkpoint commits。不要 push、创建 PR、自动合并或修改 main，除非 Owner 另行明确要求。

开始前完整阅读 worktree 内 `AGENTS.md`。它高于本指令；若冲突，明确报告并遵循 `AGENTS.md`。

## 冻结决策

以下决策已通过评审，不重新发明：

1. Scope A 先闭环官方 OpenClaw 手动 pain 路径；全 emitter 收敛随后进行。
2. `/pd-pain` 是现有可取得可信 `SessionAwareCommandContext.sessionId` 的主机入口，必须复用并补齐真实 evidence。
3. 当前 `buildTrajectoryEvidence` 数组 API 被多个自动 emitter 消费。Scope A 新增 typed acquisition API，并保留数组 compatibility wrapper；Scope B 按 emitter family 迁移后才允许删除 wrapper。
4. 新写入不得把 `cli`、`unknown` 或 unavailable sentinel 当成真实 session/evidence。
5. 外部 CLI 无 session 时仍可作为 Owner manual report 创建持久诊断任务，但不写虚假的 trajectory `sessions`/`pain_events` 投影；必须返回结构化 warning 和 nextAction。
6. Owner reason 是 report context，不是 trajectory/root-cause evidence，不得为了让 evidence 非空而复制进去。
7. 手动路径沿用现有 `manual_*` pain ID 作为 canonical ID；自动路径继续由现有 production identity/admission owner 推导或 reconcile canonical ID。
8. Codex correlation 必须保留 root session、rollout identity、logical observation key 和 host turn；不得压扁成 session-only。
9. 新 `painIngress.v1` payload 与现有 `diagnosticJson` 顶层字段在兼容窗口内由一个函数双写，并测试一致性。
10. execution status、aggregate progress、per-candidate outcome 是三个正交维度。`furthestStage` 只表示至少一个 item 到达，不表示全部完成。
11. 不新增数据库、后台 worker、独立 source of truth 或仅用于本修复的新 feature flag。
12. 当前 Gate A/B flags 只选择 gate，不是 pain off-switch；rollback 依赖 adapter/package revert。

## 执行流程

### 0. 建立可复述基线

执行并保存证据：

```powershell
git status --short
git log -n 5 --oneline
git worktree list
git rev-parse --show-toplevel
```

确认当前目录是上述专用 worktree、现有未知改动没有被覆盖。完整阅读：

- PRI-642 Linear issue 和最新评论；
- rev 2 SPEC；
- `docs/product/PRODUCT_IDENTITY.md`；
- `docs/adr/0014-mvp-first-strategy-and-product-pivot.md`；
- `docs/superpowers/specs/2026-08-28-codex-governance-closure-spec.md`；
- `docs/process/error-management/ERROR_PATTERN_INDEX.md` 中与证据断链、静默降级、lineage、重试状态相关的条目；
- private emotional-value guide；
- 所有当前 production emitters、直接调用方、stores、payload readers、tests 和 package/build wiring。

若 Linear 可访问，先设 PRI-642 为 In Progress，并只留下有信息量的设计/阻塞评论。若不可访问，记录证据但不要阻塞本地实现。

完成标准：能列出每个生产 emitter 的 source、origin、correlation、evidence acquisition、canonical identity owner、写入路径、重试路径、消费者和现有测试。把最终 inventory 回填到 SPEC 的 migration inventory；不要创建第二份长期真相。

### 1. 关闭 G0：证明 session transport

从当前 OpenClaw 代码、安装产物、真实运行时和必要时的 OpenClaw 官方资料，证明安装后的 `pd-pain-signal` 如何获得可信当前 session。

决策顺序：

1. Owner-direct 路径优先复用 `/pd-pain`；
2. agent-invoked skill 优先使用现有可信 command/tool context；
3. 只有证据证明现有机制不存在时，才增加一个最小的 host-to-command transport。

可信 transport 必须来自同一 host event/command context，并通过 rc-6 lineage mismatch negative test。采用环境变量时必须证明变量由 host 注入、workspace/session 作用域正确且子进程不会继承陈旧值；不能仅凭变量名存在就信任。

禁止让模型猜 session、扫描“最新 session”、按时间挑 session 或静默退回 unbound。若 agent skill 无法取得可信 session，默认安全行为是明确拒绝 host-bound 声明并引导 Owner 使用 `/pd-pain`；同时继续寻找可验证的最小 transport，直到 G0 可用真实运行时证明。

完成标准：安装产物测试和真实 OpenClaw 运行均证明提交 task 的 session 与触发会话完全相同；mismatch 测试在修复前失败、修复后通过。

### 2. 先写 Scope A 回归测试

按 TDD 建立以下红灯：

1. published/install-layout `pd-pain-signal` 使用已证明的 session transport；
2. `/pd-pain` 将当前 session 和非占位 evidence 一起提交；
3. `pd pain record --session <real>` 写入一致的 bound provenance/evidence；
4. nonexistent session 在 LLM、task、candidate mutation 之前失败；
5. unreadable DB 与 empty trajectory 有不同 reasonCode；
6. external CLI 无 session 不创建 `cli` trajectory session/pain row，不制造 evidence，但诊断 task 持久且 warning/nextAction 明确；
7. generated candidates 非空、admitted/ledgered 为空时不能报告内化完成；
8. Commander 真 parser、`--json` 单对象 stdout、stubbed `process.exit` 后无后续 mutation。

使用真实公共/生产边界。source-regex 测试只能作为迁移临时护栏，不能充当最终证明。

完成标准：每项测试都能在修复前因预期原因失败，且没有通过 mock 绕开 production composition。

### 3. 实现并验证 Scope A

最小修改以下责任边界：

- OpenClaw typed evidence acquisition + array compatibility wrapper；
- `/pd-pain` session/evidence submission；
- CLI explicit-session validation and provenance derivation；
- external unbound CLI 的 honest persistence/observability；
- skill/template/generated/install artifacts；
- operator success/result semantics 所需的最小兼容扩展。

读取所有 immediate callers 后再改公共类型。所有 DB/JSON/host input 从 `unknown` 验证，不使用 `as` 代替 runtime validation。所有 degraded/refused results 包含 reasonCode、warning/notes 和 nextAction。

Scope A 完成后运行 targeted tests、build/typecheck、install/package smoke，并做一次真实 OpenClaw dogfood：记录 report ID、canonical pain ID、session、diagnostic task、evidence refs、candidate decisions、ledger IDs 和 seeded task IDs。只输出脱敏/计数证据，不泄露 transcript 内容。

完成标准：SPEC §12.1 全部通过，且 real dogfood 能证明同一 session lineage；此时做一个可复述 checkpoint 和 Scope A commit。

### 4. 完成 B0 inventory 与 contract tests

逐一处理至少：

- `hooks/pain.ts`；
- `hooks/llm.ts`；
- `hooks/lifecycle.ts`；
- `hooks/gate-block-helper.ts`；
- `hooks/after-tool-call-helpers.ts`；
- `core/signal-collector-host.ts`；
- `commands/samples.ts`；
- CLI manual entry；
- Codex `governance-signal-admission.ts` 及 observation consumers。

把每个 emitter 标记为：Scope A 已迁移、Scope B 待迁移、保持 peer adapter，或明确 out of scope；每个结论附生产 consumer 和测试证据。

为 SPEC valid-combination matrix 每一行写 contract test，包括 mixed-event lineage、bound+unavailable、external-unbound 和 Codex incomplete lineage。

完成标准：不存在“未发现的直接 PainToPrinciple/PainSignalBridge 调用方”；矩阵每一行都有确定 oracle。

### 5. 实现 B1 shared ingress 与 re-entry

在 `@principles/host-runtime` 中深化现有 admission/evidence 能力，提供一个小而语义化的 ingress 接口。它负责：

- runtime validation；
- correlation consistency；
- evidence classification；
- legacy payload shaping；
- result shaping；
- 调用现有 identity/task/admission owners。

它不直接成为 canonical identity、task store 或 candidate lifecycle 权威。

新增 versioned `painIngress.v1`，并从同一 builder 生成现有顶层：`sourcePainId`、`sessionIdHint`、`provenance`、`provenanceReason`、`hostKind`、`evidence`、`workspaceDir`。增加 SQLite round-trip、legacy read、nested/top-level mismatch、malformed JSON、lineage mismatch 和 bounded safe serialization tests。

修改 `executePendingDiagnosis`：从 persisted payload 读取并验证 provenance/correlation，不再默认 `host_context_bound`。legacy compatibility branch 不得制造新 host binding。

完成标准：共享接口通过全部 contract/round-trip/re-entry negative tests；无新 DB/table/flag/source of truth；Architecture/Runtime guards 通过。

### 6. 实现 B2/B3 OpenClaw 迁移与 outcome convergence

按 emitter family 小步迁移，每一组先 characterization、再 production-boundary test、再修改：

1. manual/prompt family；
2. tool failure/after-tool family；
3. LLM/empathy/lifecycle family；
4. gate-block/sample rejection family。

每组验证：source、session、trace、evidence 和 canonical identity 一致；unavailable automatic signal observation-only 且有 reason；没有 LLM 调用；重复交付幂等。

实现 status + progress + per-candidate outcomes。保留现有 `candidateIds`、`ledgerEntryIds`、`admissionResults` compatibility fields 一个迁移窗口，明确其 derivation。收集 admitted IDs、ledger IDs、seeded task IDs 和 not-internalizable/failure reason，不以 furthestStage 表示 all-success。

完成标准：SPEC §12.2 的 OpenClaw、retry 和 mixed-outcome 场景全部通过；所有已迁移 emitter 不再独立拼装互相矛盾的 provenance/session/evidence。

### 7. 执行 B4 Codex parity gate

在修改 Codex production path 前冻结并运行：

- rootSessionId；
- rolloutIdentity；
- logicalObservationKey；
- hostTurnId；
- canonical pain identity；
- duplicate/reconciliation；
- promotion tail；
- retry/re-entry。

如果 shared ingress 能在不扩大接口、不丢 lineage、不产生第二 admission authority 的条件下提高 leverage，则迁移 Codex adapter。如果迁移只会把现有深模块包一层或丢失语义，则保留现有 Codex governance admission 作为 peer adapter，只接入共享 contract/result 的安全部分，并在 SPEC inventory 记录理由。

完成标准：冻结 fixtures 和 real consumer tests 全绿；B4 决策能通过 deletion test、real seam test 和 interface leverage review。

### 8. 清理、文档和错误经验

仅删除已被 production searches、consumer tests 和 build/package evidence 证明未使用的 wrapper、duplicate builder 和临时 source-shape tests。不要顺手合并 Gate A/B 或修复历史 pending 数据。

同步更新：

- CLI help；
- 中英文 skills/templates/generated artifacts；
- operator success semantics；
- architecture/navigation docs 中与生产 reality 冲突的内容；
- SPEC status、inventory 和最终 implementation evidence。

把每个真实 finding 对照 Error Pattern Index 分类。PRI-642 是复发/逃逸生产缺陷；若 handbook 没有同根因条目，记录一个根因级 recurrence；已有则追加一次精炼 recurrence，不创建重复条目。运行 handbook validator。

完成标准：没有 stale published artifact、stale CLI help 或第二份规范真相；handbook 决策有证据。

### 9. 对抗性评审与最终验证

分别执行两轴评审：

- Standards correctness：AGENTS、Runtime Contract、CLI Contract、architecture guards、Complexity Delta；
- Specification correctness：逐条映射 SPEC Scope A/B、acceptance、non-goals 和 Owner decisions。

重点攻击：

- 伪 session/伪 evidence；
- manual/automatic identity authority 混淆；
- nested/top-level drift；
- retry stale provenance；
- Codex lineage collapse；
- mixed candidate false success；
- skipped mutation after CLI exit；
- package/install artifact 未同步；
- Scope B 借机重做 Gate A/B。

修复所有有效 P0/P1，以及违反 acceptance 或造成实质 correctness/safety 风险的 P2。然后运行：

```powershell
git diff --check
npm run verify:merge
```

另运行所有不在 merge gate 内的 targeted、integration、BDD、package/install 和 dogfood checks。任何 skipped test、缓存 fallback、网络失败或 pre-existing warning 都单独报告，不能隐藏在“tests pass”中。

完成标准：所有必需测试 exit 0、无静默 skip、diff 仅包含本任务、两轴复审无阻塞 finding。

### 10. Git 与 Linear 收尾

保持小而可审查的 commits，建议边界：

1. SPEC/execution contract；
2. Scope A regressions；
3. Scope A implementation；
4. shared ingress/re-entry；
5. emitter migrations/outcomes；
6. Codex parity decision；
7. docs/handbook/generated artifacts。

提交前逐次确认 `git status` 和 diff scope。不要修改或压扁不属于本任务的提交。

若 Linear 可访问，留下最终证据评论。没有 PR 时保持 In Progress；只有 Owner 另行要求并实际创建 PR 后才设 In Review。不要设 Done、不要自动 merge。

## 唯一允许的未完成状态

只有以下情况可以停止并报告 blocked：同一个外部阻塞已经在至少三次连续推进中复现，仓库、测试、runtime inspection、官方资料和安全替代方案均无法推进，并且继续需要新的 Owner authority、凭据或交互式真实 host 操作。

blocked 报告必须包含：已尝试证据、精确阻塞点、仍然安全完成的部分、未满足的 SPEC 条款，以及 Owner 只需执行的一条最小操作。不要用“任务很大”“时间不足”“最好确认”作为阻塞理由。

## 最终交付格式

最终回复必须以仓库要求的 `Owner Review Card` 开始，并另外包含：

1. Scope A 每条 acceptance 的 PASS/FAIL 与证据；
2. Scope B 每条 acceptance 的 PASS/FAIL 与证据；
3. B4 Codex 决策及理由；
4. emitter migration inventory 摘要；
5. targeted tests、dogfood 和 `verify:merge` 的真实结果；
6. commits 列表；
7. 未解决风险和明确未纳入项；
8. Complexity Delta 最终值；
9. 可点击的关键文件链接。

只有全部完成条件满足时才使用“完成”。
