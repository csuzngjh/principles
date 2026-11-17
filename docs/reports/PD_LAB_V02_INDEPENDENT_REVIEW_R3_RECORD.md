# §D 第三轮独立复审 — 原始执行记录（verbatim 归档，2026-11-17）

> 本文件是 SPEC v0.2 第三轮独立复审（Owner 第二轮评审要求，2026-11-17）fresh-context
> Explore 子代理的**最终报告逐字转录**（agentId `agent_d3ff2efe-8c7c-43d9-b68e-ce28a3885f9c`，
> 首轮 51 次工具调用 + 续跑 3 次，基线 `b759f3ee0` = origin/main tip @ 2026-11-17）。
> 转录自 ZCode 会话日志，未改动正文；文件头为此后添加的编者注。
> 独立性：该 agent 被明确禁止阅读 #2682 评审产物；其在报告中自述一次 grep 意外接触
> PRI-1244 报告 6 行后已丢弃并改从源码独立重验（诚实披露，见其独立性声明段）。
> 总体判定：**SUPPORTED_WITH_FINDINGS**（3 条 P3，无 P0/P1）。

---

# Independent Adversarial Verification Report — SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001 v0.2

**Verification baseline:** I read repository reality at worktree `D:\Code\_worktrees\principles\PRI-1245-report-remediation`, HEAD = `b759f3ee0d8ac6fa4fe6d6a586fa6e34cc21ed8f` (= `origin/main` tip, commit dated 2026-11-17 08:04:49 +0800, "feat(update-page)… (#2686)"). **Date of audit: 2026-11-17.**

**Independence statement:** I did NOT read `docs/reports/PD_LAB_SPEC_V02_INDEPENDENT_REVIEW.md`, `docs/reports/PROMPT_V2_HISTORICAL_ARTIFACT_AUDIT.md`, `docs/reports/PD_LAB_V02_END_TO_END_ACCEPTANCE_REPORT.md`, nor any other file under `docs/reports/` added by the authoring session (PR #2682, commit `78d631fa4`), nor `experiment/prompt-v2/reports/PD_LAB_HISTORICAL_EXPERIMENT_INDEX.md` (also added by #2682). My only inputs were the SPEC itself and repository sources predating or independent of the authoring session. **One disclosure:** an early `grep` for "ReplayEngine" surfaced ~6 lines from `docs/reports/PRI-1244_PD_LAB_CAPABILITY_INVENTORY.md` (a #2672-committed file I had not yet excluded; Windows path separators broke my filter). I discarded those lines and independently re-verified every ReplayEngine claim from source code only. No finding below relies on any authoring-session output.

**Baseline-integrity note:** `git diff --name-status 592f50b..HEAD` shows the SPEC's declared baseline (`592f50b4`) differs from my reading baseline only by: version bumps, the authoring session's own document additions (#2682), a modification to `docs/pipeline-evolution/scenarios/S001.md` (by #2682 — I avoided it, see Group 5), and PR #2686 UI files. Every source the SPEC cites is byte-identical between `592f50b4` and my reading baseline.

---

## Group 1 — §2.3 关键基线事实 (14 rows): **PASS_WITH_NOTES**

All 14 rows' verdicts verified against source:

1. **experiment-manifest.v1 VERIFIED** — `scripts/dev/pipeline-evolution/lib/experiment-manifest.mjs` exists (`newManifestTemplate` at :153-177); Pipeline Evolution uses it (`scripts/dev/pipeline-evolution/init-experiment.mjs:26`, `collect-evidence.mjs:39`); PLE reuses it (`scripts/dev/principle-learning-lab/run-pilot.mjs:37` imports from `../pipeline-evolution/lib/experiment-manifest.mjs`; writes manifest at :166).
2. **PLE Dataset/Fixture VERIFIED (synthetic)** — `scripts/dev/principle-learning-lab/fixtures/` exists (dataset-manifest.json, episodes/, histories/, judgments/, probes/, splits.json, world-manual.json); `lib/fixture.mjs` exists. Manifest fields confirmed by reading the JSON: `schemaVersion=pd-principles-dataset.v0.1`, `synthetic=true`, `episodeKind=synthetic_pilot`, `datasetId=PLE-PILOT-01`.
3. **PLE Sidecar VERIFIED** — `lib/sidecar.mjs:26` `STUDY_SCHEMA = 'principle-study.v1'`; :27 `ADJUDICATION_SCHEMA = 'adjudication.v0.1'`.
4. **PLE G1 VERIFIED (offline deterministic)** — `run-pilot.mjs` exists; :17 "Exit code 0 = G1 gate PASS; 1 = gate FAIL (honest failure, never faked)"; :150-151 `evaluateG1Gate`; README documents pipeline (`README.md:20-22`); tests exist (`scripts/__tests__/principle-learning-lab-*.test.ts`).
5. **PLE G2 PARTIAL** — `fixtures/pilot-run-config.json:3` `"status": "NOT_AUTHORIZED"`; :4 "actor wiring itself now EXISTS and is rehearsed offline… deterministic fake transports only"; `fixtures/preregistration.json:38` `"NOT_RUN…"`, :57 `"NOT_AUTHORIZED (OD-1..OD-2 pending…)"`, :142 `"realAgentPilot": "OWNER_DECISION_REQUIRED…"`; `README.md:106-109`. Matches "接线与离线演练存在，真实 Agent Pilot 仍未运行/未授权".
6. **PRR A/C Dataset VERIFIED** — `prr/lib/prr-dataset.mjs:29` `PRR_DATASET_SCHEMA = 'prr-ac-dataset.v0.1'`; :27/:64 canonical JSON + SHA-256 freeze.
7. **PRR 真实样本 UNKNOWN/未授权, AUTHORIZED_REAL_SAMPLE = 0** — `docs/specs/SPEC-PD-PRR-001-Gate-B0-AC-preregistration-20261022.md:45`: "`AUTHORIZED_REAL_SAMPLE` | 经授权真实样本 | 本阶段**零条**" (= 0); also :43-44 define `FIXTURE_ONLY`/`SCHEMA_CAPABILITY`.
8. **Pipeline Evolution Benchmark VERIFIED, S001–S006 + Episode reports + Evidence, 成熟度不一** — `docs/pipeline-evolution/` contains README.md, baseline-report.md, episode-playbook.md, reports/ (6 files incl. episode-001/002-r2/002-r3), scenarios/ (S001–S006); Evidence tooling: `scripts/dev/pipeline-evolution/collect-evidence.mjs`, `lib/evidence-package.mjs` (`evidence-index.v1`/`metrics.v1`/`pipeline-trace.v1` at :17-19, `renderOwnerReview` :436).
9. **Prompt V2 A/B VERIFIED** — `experiment/prompt-v2/reports/AB_EXPERIMENT_ACCEPTANCE_REPORT.md` and `EXPERIMENT_REPRODUCIBILITY_REPORT.md` exist; per-file `git log` shows both were committed only by #2653 (`63e76a8bd`) and never modified since — i.e., they are #2653 originals, not authoring-session products.
10. **全局实验注册中心 不存在** — `grep -rln "experiment.registry|experimentRegistry"` across `scripts/` and `packages/` returned zero hits.
11. **通用 Runner/Evaluator 不存在** — consistent with source: `lib/runner.mjs` vs `lib/real-runner.mjs` vs `lib/challenge-runner.mjs` vs `ab-run.mjs` are separate domain implementations; no universal runner found.
12. **跨领域统一 Evidence 契约 不存在** — consistent: five separate evidence mechanisms (`evidence-package.mjs`, `sidecar.mjs`+`report.mjs`, `examiner-injection-evidence.mjs`, `ab-blindpack`/`ab-eval`/`ab-metrics`, `prr-adjudicate.mjs`), no shared envelope found.
13. **通用真实宿主 Trace Replay MISSING** — consistent: `packages/openclaw-plugin/src/core/replay-engine.ts` is read-only report query only; generation retired (`src/index.ts:1016` "replay 生成路径已在 PRI-230 退役", :1068 English equivalent). No generic host trace-replay engine found anywhere.
14. **内部 PD-Lab 发版隔离 TARGET; lab-payload.mjs 边界测试** — `scripts/__tests__/lab-payload-closure.test.ts` exists with exactly the boundary assertions (see Group 2).

**Note (Finding 3 below):** rows 5's evidence cells cite `pilot-run-config.json` / `preregistration.json` without the `fixtures/` prefix. All "#2672 审计报告" citations (rows 10–13) are valid: `git show --name-status 2af0110a4` proves #2672 itself added `docs/reports/PRI-1244_PD_LAB_CAPABILITY_INVENTORY.md`, and `git ls-tree 592f50b4a` confirms the file existed at the SPEC's declared baseline (blob `1f3443b45…`, identical to `2af0110a4`).

## Group 2 — §3.1.C 七模块白名单: **PASS** (no findings)

`scripts/build/lab-payload.mjs:15-24` — `LAB_ENTRY_MODULES` contains exactly, in order: `lib/examiner-study.mjs`, `lib/challenge-runner.mjs`, `lib/challenge-behavior-report.mjs`, `lib/challenge-actor.mjs`, `lib/examiner-injection-evidence.mjs`, `lib/examiner-v07-cases.mjs`, `lib/examiner-v2-cases.mjs`. This is an exact match to the SPEC's seven entries (SPEC lines 188-194, listed without the `lib/` prefix). Packaging target `console/lab` confirmed in `packages/create-principles-disciple/scripts/bundle-plugin.mjs` (:11 imports `collectLabModuleClosure, LAB_ENTRY_MODULES` from `scripts/build/lab-payload.mjs`; :81 comment "payload carries the runtime subset under console/lab"; :550 "Copying console/lab/lib"; :558 fail-loud completeness check). "供 Examiner 路由动态加载" confirmed: `packages/pd-console/src/server/index.ts:620-621` routes `/api/examiner`; `lab-payload-closure.test.ts:19-22` reads the examiner route files and :36-51 requires the closure to contain every module they name. §10.2's five claimed test assertions all verified: closure-completeness (:36-51), no `__tests__`/test files (:53-57), no home-directory-secret-reading transport — `challenge-amd-transport` explicitly excluded (:58-59), fail-loud on missing module and on imports escaping `lib/` (:62-74; enforced in `lab-payload.mjs:42-43` and the `imports outside lib/` throw).

## Group 3 — §4.5 Prompt V2 全部数字: **PASS** (no findings)

Every number verified against the committed #2653 public reports (`experiment/prompt-v2/reports/AB_EXPERIMENT_ACCEPTANCE_REPORT.md` [AR] and `EXPERIMENT_REPRODUCIBILITY_REPORT.md` [RR], both provably untouched since #2653) plus the committed `experiment/prompt-v2/dataset/dataset-manifest.json`:

| SPEC claim | Evidence |
|---|---|
| 16 条真实 Pain 样本 | AR:3 "16 real pains × 2 arms"; dataset-manifest.json `sampleCount = 16` |
| V1/V2 两臂 | AR:3 |
| 完成 Grid-2 | AR:3 "Grid-2 (remediated harness…)" |
| 109/109 盲评包 | AR:3, AR:17 "109 包全评"; RR:32 "盲评包 109 个" |
| completion 两臂 16/16 | AR:10 |
| V1 78.86 → V2 81.50, +2.64 | AR:19 |
| 5/6 Agent 阶段改善 | AR:21-28 (RootCause +0.54, Distiller +3.61, Router +1.79, Dreamer −1.25, Philosopher +8.08, Scribe +2.84); AR:30 "②≥4 Agent 改善 = 5/6 ✓" |
| Pairwise V2 70.7% | AR:19 "V2 胜 65（70.7%）: V1 胜 27 : tie 17" |
| Dreamer 唯一退化 −1.25 | AR:26 "唯一退化" |
| 平均阶段延迟 −20% | AR:13 "34.3 s → 27.5 s (−20%)" |
| 总 Token 字符 −14.2% | AR:40 "~492.8K → ~423.0K (−14.2%)" |
| PASS_WITH_LIMITATIONS，非统计显著性 | AR:4, :51, :54 "不声称统计显著性" |
| +2.64 未达 +5 建议门槛 | AR:4, :30①, :53 |
| 评价模型=生成模型同为 GLM-5.3 家族、独立性受限 | AR:57; RR:39 |

Data/reproduction limitation claims all verified: `ab-grid`/`ab-run`/`ab-lib`/`ab-eval`/`ab-metrics`/`ab-blindpack` all exist in `experiment/prompt-v2/scripts/ab/`; two-arm execution via compiled production CLI dist in two worktrees (`ab-lib.mjs:28-30` worktree paths, :216-220 `runPd` uses `packages/pd-cli/dist/index.js`); absolute Windows worktree paths and production workspace path in `ab-lib.mjs` (:28, :30, :35-36, :39 `PRODUCTION_WORKSPACE = 'D:/.openclaw/workspace'`); full-fidelity data in gitignored `.tmp` (RR:3; `PUBLIC_DATA_REDACTION_AUDIT.md` [RA]:31; `.gitignore:224`; `.tmp` absent from this worktree); public copies redacted (RA §1-4, canary tests 7/7 at RA:27, scanner 0 failures RA:28); early under-redacted data entered pushed PR-branch history with cleanup pending Owner decision (RA §5, "NOT actioned by agent", :45 "no credentials/tokens").

**Verification ceiling note (not a discrepancy):** the raw per-stage JSONs (`runs/grid-2/blind-summary.json`, `layer1-metrics.json`) referenced by AR:32,42,46 live in gitignored `.tmp` and are absent from the repo, so independent verification is limited to the committed reports' own text. The SPEC itself discloses exactly this limitation (§4.5 复现和数据限制), so there is no contradiction — and no §4.5 number required reading prohibited or non-committed data.

## Group 4 — §1.3 修正表: **PASS_WITH_NOTES**

**Row count: exactly 7 rows** (SPEC lines 83-91), matching the 7 corrections claimed. Each row's "最新核验结果" cell has repo support:
1. 多套 Dataset/Benchmark 已存在 — fixtures/, prr/, `experiment/prompt-v2/dataset/`, `docs/pipeline-evolution/`, `scripts/dev/pipeline-closure-lab/scenarios/` (6 scenario dirs), Examiner data — all exist.
2. #2653 已有 `PASS_WITH_LIMITATIONS` 报告 — AR:4, :51.
3. Examiner/Challenge 白名单进 `console/lab` — Group 2 evidence.
4. 各域 Evidence 已存在 — `evidence-package.mjs:17-19`, `sidecar.mjs:26-27`, `examiner-injection-evidence.mjs:1` ("six-level injection evidence chain"), AR tools, PRR files.
5. Split 不统一 — PLE outer/inner leakage: `lib/fixture.mjs:195-206` (leakageGroupId outer-leak guard); Prompt V2 paired A/B (AR:3); PRR independent protocol (PRR spec :43-45).
6. Runner/Evaluator/Replay 语义不同 — distinct implementations listed in Group 1 row 11; ReplayEngine retired-generation/read-only-query (`src/index.ts:1016,1068`).
7. 当前无统一实验门禁 CI — `grep -ril "experiment|promotion" .github/workflows/` returned zero hits across 20 workflow files.

Whole-SPEC internal contradiction scan: I found none. Header SHA = §2.1 = §13 Stage 1 (`592f50b4…`); §3.1.C/§10.2/ADR-010 are mutually consistent with `lab-payload.mjs`; §4.5's "非统计显著性" is consistent with §9.3/§16 small-sample caution; §2.3 "TARGET" for new internal assets does not contradict the existing productized Examiner exception.

## Group 5 — §4.2 三个 Episode: **PASS_WITH_NOTES**

- **Scenario table** — `docs/pipeline-evolution/README.md:164-169` matches the SPEC exactly: S001 fixture-ready, S002 defined, S003 defined, S004/S005/S006 fixture-ready; lifecycle `defined → fixture-ready → validated → behavioral-verified` at README.md:83. (Note: `scenarios/S001.md` was modified by the authoring commit #2682 after the SPEC's baseline; I deliberately did not read it and verified statuses via the untouched README.md instead.)
- **Episode 001** — `reports/episode-001-report.md:16`: "判定：**PARTIAL_EPISODE**——Pain→Diagnosis→Principle→Rule→Evaluation 全部真实走通…Owner Review（生产路径）→Activation→Behavior Transfer 未达"; :42 "Behavior Transfer | **INCONCLUSIVE**"; :96 "PARTIAL_EPISODE". SPEC's paraphrase is exact.
- **Episode 002-R2** — `reports/episode-002-r2-report.md:1,10` "（NOT_REACHED 收官）…行为结果 = `NOT_REACHED`"; :77-78 Activation/Behavior A/B NOT_REACHED. Exact.
- **Episode 002-R3** — `reports/episode-002-r3-report.md`: Pain ✅ real (:24), Diagnosis ✅ (:25), Principle ✅ validated (:26), RuleCode ✅ three versions independently verified (:27), Evaluator ✅ with caveats (:28), Owner Decision ✅ "真实行使（模拟代投，生产应用层）… resolution **applied**" (:31) — a `reject_current` decision (:16, :45); Approval/Activation ❌ NOT_REACHED (:32); Behavior A/B 不适用 (:33). SPEC's paraphrase ("真实 Pain、Principle、RuleCode、Evaluation 和 Owner Decision 有证据；未形成 live Activation，Behavior A/B 不适用") is literally accurate on every element, but see Finding 2 on omitted qualifiers.

## Group 6 — 清单外全文矛盾扫描: **PASS_WITH_NOTES** (no contradictions found)

Additional SPEC claims spot-checked against reality, all consistent:
- §4.3 "24 个 arm" — `README.md:20` "24 个 arm（4 历史 × 6 策略）"; "三层评价" — `README.md:22`, `lib/evaluator.mjs:9`; "14-case Calibration" (§6.6) — `README.md:43` "14 案冻结校准电池"; `run-pilot.mjs:167-183` writes exactly `principle-study.json`, `adjudications.jsonl`, `comparison-report.json` + Markdown.
- §7.1 `preregistration.v0.1-draft` — `lib/prereg.mjs:10`, `fixtures/preregistration.json:2`.
- §7.2 manifest lacks hypothesis/arms/stop-rules — `experiment-manifest.mjs:153-177` template fields confirm (metadata only).
- §4.6 Examiner six-level chain with per-host binding — `examiner-injection-evidence.mjs:1,31,41`.
- §4.7/§8.4 Replay taxonomy — generation-retired read-only ReplayEngine confirmed from source (`replay-engine.ts:11` query-only methods; `src/index.ts:1016,1068`).
- §8.2 生产 `EvaluatorRunner` — exists in `packages/host-runtime/src/evaluator-runtime-context.ts`, `internalization-consumer-cycle.ts`.
- §6.3 `state.db`/`trajectory.db` — `packages/principles-core/src/evolution-store.ts`, `trajectory-store.ts`.
- §6.5 "PLE SPEC 曾提出 datasets/pd-principles/ 建议目录" — `docs/specs/SPEC-PD-PL-001-principle-learning-dataset-v0.3.md:290` (`datasets/pd-principles/v0.1/`), file exists.
- §4.1 Behavior Signature (`docs/experiments/`, 校验在测试) — `docs/experiments/README.md`, `packages/principles-core/tests/behavior-signature-artifact.test.ts`; Adaptive Selector one-time approved run — `scripts/dev/adaptive-selector-lab/README.md` ("Owner-approved… The already-consumed approval flag… prevents another run").
- §2.1 git claims: exactly one commit between `2af0110a4` and `592f50b4` (verified: `git log 2af0110a..592f50b4` = only `592f50b4a`, the #2670 squash); that commit touches only Ledger/Reuse-Park/candidate-intake production logic and zero audited lab/dataset/pipeline-evolution/prompt-v2 paths (`git show --name-only 592f50b | grep -E "principle-learning-lab|pipeline-evolution|prompt-v2|lab-payload"` = empty); all three header SHAs resolve to real commits with matching PR numbers (#2653=`63e76a8bd`, #2672=`2af0110a4`, #2670=`592f50b4a`).
- §17 Linear ticket statuses (Done/Backlog) are external to the repo and **not independently verifiable from repository reality**; the #2672 merge title ("[PRI-1244] PD Lab Capability Inventory") corroborates only the PRI-1244 completion claim.

---

## Findings list

1. **P3 — §1.3 / header: the v0.1 baseline document does not exist anywhere in committed history.** SPEC:9,23-24,81 state v0.2 corrects "v0.1"; `git log --all --diff-filter=A -- "*PD-LAB-EXPERIMENT-INTEGRATION-001-v0.1*"` is empty and `docs/specs/` contains only v0.2 (added by authoring PR #2682). The corrections therefore cannot be diff-verified against a committed v0.1; each correction's target fact is independently supported (Groups 1-6), so the corrections themselves stand — only the v0.1 reference is unverifiable. Fix: one line stating where v0.1 lives (e.g., uncommitted draft) or attach it.
2. **P3 — §4.2 Episode 002-R3 paraphrase omits two qualifiers present in the report.** SPEC:273-274 lists Owner Decision as "有证据" without noting (a) the terminal governance outcome was a legitimate **reject** and overall NOT_REACHED (`episode-002-r3-report.md:12,16-18,31-32`), and (b) the Owner Decision was exercised via **simulated proxy** ("模拟代投，生产应用层", :15-16, :31 — the report itself still calls it "真实行使"). Literally true as written but open to over-reading. Fix: append "（治理拒绝终局；Owner 决策为模拟代投）".
3. **P3 — §2.3 evidence paths cited without directory prefix.** SPEC:138 cites `pilot-run-config.json` / `preregistration.json`; actual paths are `scripts/dev/principle-learning-lab/fixtures/pilot-run-config.json:3` and `scripts/dev/principle-learning-lab/fixtures/preregistration.json:38,57`. Fix: prefix with `fixtures/` (§4.3:340 and §6.5 already do).

Groups 2 and 3 have **no findings**: the seven-module whitelist is an exact match, and every §4.5 number and data-limitation claim matches the committed #2653 originals with zero discrepancies.

**Environment observation (not a SPEC defect):** the authoring session's commit #2682 modified `docs/pipeline-evolution/scenarios/S001.md` and added seven files under `docs/reports/` plus `experiment/prompt-v2/reports/PD_LAB_HISTORICAL_EXPERIMENT_INDEX.md` after the SPEC's declared baseline; none of these were used as evidence, and all SPEC claims verified here rest on pre-baseline or source-code evidence.

---

**Final verdict: SUPPORTED_WITH_FINDINGS** — every factual claim in §2.3, §3.1.C, §4.5, §1.3, and §4.2 that is checkable against repository reality checked out exactly, including all git SHAs/ancestry claims and all 14+ Prompt V2 numbers; the only defects found are three P3-level provenance/precision notes (uncommitted v0.1 reference, R3 qualifier omission, two unprefixed evidence paths), none of which undermines the SPEC's substantive conclusions.