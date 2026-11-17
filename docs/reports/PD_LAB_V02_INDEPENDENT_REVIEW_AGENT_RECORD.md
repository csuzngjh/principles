# §B 独立复核 — 原始执行记录（verbatim 归档）

> 本文件是 SPEC v0.2 独立复核报告（PD_LAB_SPEC_V02_INDEPENDENT_REVIEW.md §B）所引用的
> fresh-context Explore 子代理（agentId `agent_1c55fac3-1682-420f-a8b0-0242634a1945`，
> 44 次工具调用，约 627 秒，2026-11-16）的**最终报告逐字转录**，转录自 ZCode 会话日志
> （sess_cdf8d058…/agent_1c55fac3…/output.txt），2026-11-17 由 PRI-1245 r3 整改轮归档入库。
> 转录未改动任何正文内容；文件头为此后添加的编者注。
> 独立性声明：该 agent 当时被明确禁止阅读本会话其他评审产物，以 origin/main 为唯一事实基线。

---

所有核验项已完成。汇总评审报告。

---

# 独立架构评审报告：SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001 v0.2

核验基线：`origin/main` @ `11b6859a0`（已确认 `592f50b4` 是其祖先，故对当前 tip 的核验强于 SPEC 自我声明的基线）。被评审文件：`D:\Code\_worktrees\principles\PRI-1245-pd-lab-v02-integration\docs\specs\SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.2.md`（已完整阅读，工作区 clean，SPEC 本身已在分支上提交）。

## 逐项核验结果

### 1. §2.3 事实表逐行抽查 — PASS（2 处 P3 措辞问题）

| 行 | 结果 | 证据（origin/main） |
|---|---|---|
| `experiment-manifest.v1` 存在且被 Pipeline Evolution + PLE G1 使用 | PASS | `scripts/dev/pipeline-evolution/lib/experiment-manifest.mjs:18` `export const MANIFEST_SCHEMA = 'experiment-manifest.v1'`；`run-pilot.mjs:37` `import { newManifestTemplate, parseManifest } from '../pipeline-evolution/lib/experiment-manifest.mjs'` |
| PRR `AUTHORIZED_REAL_SAMPLE = 0` | PASS（表述间接） | `docs/specs/SPEC-PD-PRR-001-Gate-B0-AC-preregistration-20261022.md:45` "AUTHORIZED_REAL_SAMPLE…本阶段**零条**"；`docs/implementation-reports/SPEC-PD-PRR-001-gate-a-incremental-audit-20261022.md:329` "`AUTHORIZED_REAL_SAMPLE` 仍为 0"（SPEC 中无字面 `= 0`，但语义成立，见发现 F2） |
| Pipeline Evolution S001–S006 状态 | PASS（6/6 逐字一致） | `docs/pipeline-evolution/README.md:164-169`：S001 fixture-ready / S002 defined / S003 defined / S004–S006 fixture-ready；`:83` 状态机约定与 SPEC 逐字一致 |
| Prompt V2 报告存在性 | PASS | `experiment/prompt-v2/reports/` 含 `AB_EXPERIMENT_ACCEPTANCE_REPORT.md`、`EXPERIMENT_REPRODUCIBILITY_REPORT.md` 等 25 份报告 |
| §2.3 其余行附带核验 | PASS | sidecar.mjs:26-27 `principle-study.v1`/`adjudication.v0.1`；dataset-manifest.json:2,8,9 三字段逐字一致；prerequisites（G2 授权：README.md:106-107 `NOT_AUTHORIZED`/`OWNER_DECISION_REQUIRED`/`NOT_RUN`）；"无 Registry/无通用 Runner/无 Trace Replay"由 PRI-1244 报告 27/43-52/176 行及 manifest.mjs 头注 "no registry until SPEC Phase 2" 双重印证 |

### 2. §3.1.C 七个 LAB_ENTRY_MODULES 白名单 — PASS

`scripts/build/lab-payload.mjs:15-24` 逐字比对，七个模块名称与顺序与 SPEC 完全一致：`examiner-study / challenge-runner / challenge-behavior-report / challenge-actor / examiner-injection-evidence / examiner-v07-cases / examiner-v2-cases`（源码带 `lib/` 前缀，SPEC 写basename，无实质差异）。`bundle-plugin.mjs:11,556` 确认同一白名单进入 `console/lab`。

### 3. §4.5 Prompt V2 全部数字 — PASS（13/13 逐字一致）

对照 `experiment/prompt-v2/reports/AB_EXPERIMENT_ACCEPTANCE_REPORT.md`：
- 头注：`Grid-2 · 16 real pains × 2 arms + repeat runs · blind evaluation 109/109 packages · Verdict: PASS_WITH_LIMITATIONS`
- `总体：V1 78.86 → V2 81.50（+2.64）`；`pairwise（decided 92）：V2 胜 65（70.7%）`
- `Dreamer … −1.25 唯一退化`；`Avg stage latency 34.3 s → 27.5 s (−20%)`；`总量（输入+输出）~492.8K → ~423.0K (−14.2%)`；`Pipeline completion 16/16 = 1.00`两臂；`+2.64 未达 +5 建议门槛`；`不声称统计显著性`；`评估器与生成器同为 glm-5.3 家族`
- 复现声明同样成立：`ab-{grid,run,lib,eval,metrics,blindpack}.mjs` 六脚本均在 `experiment/prompt-v2/scripts/ab/`；`ab-lib.mjs:28-36` 含绝对 Windows worktree 路径、`:43` EXPERIMENT_ROOT 在 `.tmp`；REPRODUCIBILITY_REPORT 确认两 worktree 编译 dist 执行、全保真数据在 gitignored `.tmp`

### 4. §1.3 v0.1→v0.2 修正表 — PASS

共 **7 行**修正（行 85/86/87/88/89/90/91），逐行与正文对得上：行1↔§5/§6、行2↔§4.5/Stage 2、行3↔§3.1.C/§10.2、行4↔§4.6、行5↔§6.9（PLE 双层分割见 SPEC-PD-PL-001 v0.3:240,298；PLE 建议目录 `datasets/pd-principles/` 见 v0.3:290）、行6↔§8、行7↔Stage 5/ADR-013。全文数字交叉扫描（24 arms / 14-case / 16 样本 / 109 / 78.86/81.50/+2.64 / 5-6 / 70.7% / −1.25 / −20% / −14.2% / “七个模块”两处）未发现自相矛盾；§2.1 的“#2670 是唯一后续提交且不触碰 Lab 路径”经 `git log 2af0110a..592f50b4`（恰 1 commit）与 `git diff --name-only`（56 文件全部在 packages/openclaw-plugin + 1 个 scripts 检查脚本，零 scripts/dev|experiment|docs 路径）证实。

### 5. §4.2 三个 Episode 结论转述 — PASS

- EP001：`episode-001-report.md:16` “判定：**PARTIAL_EPISODE**——Pain→Diagnosis→Principle→Rule→Evaluation 全部真实走通…Owner Review（生产路径）→Activation→Behavior Transfer 未达”；`:42` Behavior Transfer **INCONCLUSIVE** — 与 SPEC 逐点一致
- R2：`episode-002-r2-report.md:10` “行为结果 = `NOT_REACHED`”
- R3：`episode-002-r3-report.md:12` "NOT_REACHED"；`:32` "Approval / Activation ❌ NOT_REACHED"；`:33` "Behavior A/B 不适用（…无 live activation 即无注入）” — 与 SPEC 一致（但见发现 F4）

### 6. 清单之外的事实错误扫描 — 未发现 P0/P1 级错误；2 项 P3

附加核验均成立：§4.2 架构判断清单（collect-evidence.mjs、`lib/evidence-package.mjs` 的 buildEvidenceIndex/metrics.v1/trace/renderOwnerReview）、§4.6 六级注入链（examiner-injection-evidence.mjs:1 "the six-level injection evidence chain"）、§8.1 runner.mjs/real-runner.mjs/runPd（ab-lib.mjs:216）、§8.2 EvaluatorRunner、§9.4 词汇表（METHOD_VALIDATED_ONLY sidecar.mjs:30；NOT_ESTIMABLE；INVALID_PROTOCOL actor.mjs:499；BEHAVIOR_OUTCOMES 四值 manifest.mjs:33）、§10.2 四条测试断言（lab-payload-closure.test.ts 四个 it，见 F6）、§4.1 资产位置（pipeline-closure-lab 6 场景、adaptive-selector-lab、docs/experiments behavior-signature、pd-console/routes/examiner.ts）、§11.1（redaction audit §5：verbatim blob 曾入 PR #2653 分支历史、无凭证/Token、Owner 决策未执行）、三个基线 SHA 与 PR 号（commit message 内嵌 #2670/#2672/#2653）。

## 发现清单

| # | Severity | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| F1 | P3 | §4.2 权威入口 4 个链接中 2 个使用被截断的 34 位 SHA `592f50b4aa0c6135128dc63e951efe1496`（另 2 个为完整 40 位），不一致（GitHub 仍可按前缀解析，链接有效） | SPEC 行 246、248 vs 行 242、244 | 统一为完整 SHA |
| F2 | P3 | §2.3 PRR 行写 “UNKNOWN/未授权；…`AUTHORIZED_REAL_SAMPLE = 0`"，把 UNKNOWN 与 TRUE_ZERO 并置一处。PRR 规范本身严格区分二者；“已授权真实样本数 = 0" 是可验证的 TRUE_ZERO（授权数为零），不是 UNKNOWN。仓库无字面 `= 0` 常量，仅有 "本阶段零条”/"仍为 0" 的报告表述 | PRR Gate-B0 spec:45；gate-a-incremental-audit:329 | 改写为 “授权真实样本数 = 0（TRUE_ZERO）；真实样本结果 UNKNOWN/未测量"，与 §4.4 的严谨措辞对齐 |
| F3 | P3 | §4.5 “总 Token 字符统计下降约 14.2%" 混用 Token 与字符。报告明确以**字符**计（~492.8K→~423.0K 字符，输入+输出），未做 token 化统计 | AB report §3 表 | 改为 "总字符量（输入+输出）" |
| F4 | P3 | §4.2 R3 摘要 “…和 Owner Decision 有证据" 省略了报告的关键限定：Owner Decision 为 **模拟代投**（“✅ 真实行使（模拟代投，生产应用层）"，EP001 的 Owner-mode 评审同样记为 SIMULATION）。对一份反复强调“不得把模拟写成真实"的治理 SPEC，该限定应保留 | episode-002-r3-report.md:31；episode-001-report.md:40 | 在 §4.2 补一句 "Owner Decision 为 owner-mode 模拟代投，非生产 Owner 审批" |
| F5 | P3 | §17 Linear 工单状态（PRI-1245/1246 Backlog、PRI-966/967–971 Done）无法用仓库证据核验（Linear 为外部系统）；仅 PRI-1244 Done 有仓库证据（PR #2672 已合并 + `docs/reports/PRI-1244_PD_LAB_CAPABILITY_INVENTORY.md` 存在） | git log 2af0110a4 | 对不可仓库核验的状态标注证据来源为 Linear 而非仓库，或在 Reality Audit 中注明 |
| F6 | P3 | §10.2 称测试"明确检查…不把整个 principle-learning-lab/lib 打包"。实际测试**没有**字面断言“闭包≠整个 lib"，其防过宽机制是：闭包内每项必须在 lib/ 内、排除测试材料、点名排除读取 Home API Key 的 `challenge-amd-transport.mjs`，加文件头注释声明的 "closure too wide" 失败模式。SPEC 的概括略超出测试的字面断言范围 | lab-payload-closure.test.ts:27-70（无 "not whole lib" 断言） | 措辞改为"通过白名单闭包+负向排除保证不发整个 lib" |
| F7 | P3（备注） | §4.7 "已退役的 ReplayEngine 历史报告查询”：`ReplayEngine` 类仍在 `promote-impl.ts:24,60,93,116` 被实例化，退役的是其重放语义、保留的只是 listReports/getLatestReport 只读查询——与 PRI-1244 “已退役的遗留报告只读查询” 一致，但读者可能误以为代码已删除 | replay-engine.ts（仅报告枚举/读取函数）；promote-impl.ts:24 | 无需改动；可选加“代码保留、仅作历史报告查询" |

未发现任何 P0（生产/安全边界失效）或 P1（核心结论不成立）问题。所有承重事实——基线 SHA 链、七模块白名单、S001–S006 状态、三 Episode 判定、Prompt V2 全部数字、PRR 零授权样本、G2 未授权状态、发版隔离测试、脱敏审计与历史泄漏声明——均在 `origin/main` 独立复核成立，且在比 SPEC 基线更新的 tip 上依然成立。

**总体判定：SUPPORTED_WITH_FINDINGS**（7 条 P3 级发现，核心事实与架构判断全部成立，未发现任何可推翻核心的陈述）