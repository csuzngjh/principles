# CEB-002 执行证据归档说明

> 归档日期 2026-10-28 · 本目录是对 **2026-10-27 已完成实验**的证据归档——**不代表新增实验结果，不改变任何原有研究结论**。

## 1. 归档来源与源状态

| 项 | 值 |
|---|---|
| 源 worktree | `D:\Code\_worktrees\principles\adhoc-20261027-ceb002-consistency-4c9c71`（本轮保全未动，详见 PR 描述） |
| 源 HEAD | detached `2082939515bbd92ec475103abbba32fc805c2e6b`（2026-10-27 main 提交） |
| 源状态 | 40 modified + 12 untracked（CEB-002 冻结+执行态、`.tmp/ceb002-final` 交付包） |
| 冻结身份 | suiteHash `02cbc15c…d04f5` · mappingHash `213090da…`（CEB-001 共享链） · graderHash `eef38484…` · studyPlanHash `bd0a8408…cc4f47` |
| 执行事实 | 96/96 单元 SUCCEEDED · attempts 96/96 · requests 298/960 · 身份全部 glm-5.3-flash · 墙钟 130 min（2026-10-27T12:22Z 授权生效后） |

## 2. 归档内容与转换记录

| 归档文件 | 来源 | 转换 |
|---|---|---|
| `challenge-studies/CEB-002/`（本 PR 全部变更：冻结产物+三层账本+96 运行记录） | 源 worktree 研究目录 | **零转换**（`cp -a` 字节复制，文件 mtime 保留在源与归档 worktree；git 记录本归档提交时间） |
| `scripts/dev/principle-learning-lab/prepare-ceb002-freeze.mjs` | 源 worktree（未跟踪） | 零转换（可复现冻结准备构建器） |
| `FINAL-REPORT.md` | `.tmp/ceb002-final/FINAL-REPORT.md` | 零转换（2026-10-27 原文；注意其"A=C 完全一致"表述已被决策报告勘误为汇总口径） |
| `RESEARCH-DECISION-REPORT.md` | `.tmp/ceb002-final/RESEARCH-DECISION-REPORT.md` | 零转换（终局核查+勘误+功效重算+下一阶段决策） |
| `behavior-report.json` / `behavior-report.md` | `.tmp/ceb002-final/study/behavior-report.*`（REPORT_READY 已提交版本） | 零转换；生成方式=在 96 结算态研究副本上 `generate-behavior-report --now`（REPORT_READY 事件在该副本 events.jsonl 内，非研究目录）；归档后经 `--verify` 复验 exit 0 |
| `terminal-audit-20261028.json` | `.tmp/ceb002-final/audit.mjs` 于 2026-10-28 只读重算 | **重算产物**（非 2026-10-27 原件——原件仅打印未存盘；同源同脚本，输入为源 worktree 冻结研究目录；脚本哈希见清单） |

## 3. 排除项（有意不归档）

| 排除 | 理由 |
|---|---|
| `.tmp/ceb002-final/RESEARCH-DECISION-PACK.md` | 已被 CEB-003 契约收口**取代**的提案（matched-summary C' 设计）；其有效结论已进入已入库的 `CEB-003/OWNER-REVIEW-*.md`（PR #2193）；保留在源 worktree `.tmp`，哈希记录于 SHA-256 清单 |
| `.tmp/ceb002-final/{audit.mjs,analyze.mjs}`、`ceb002-{execute,resume,resume3}.sh`、`ceb002-execution-log.txt` | 一次性验证/编排工具与日志；关键数字已由 `terminal-audit-20261028.json` 独立重算证实；哈希记录于清单 |
| `.tmp/ceb002-final/study/`（整个副本） | 派生视图；其唯一增量（behavior-report 对 + REPORT_READY 事件）已按上表归档 |
| 源 worktree 的 `run-challenge-study.mjs` 未提交修改（8 行 `--repetitions`） | 已被 main（PR #2193, `1c21bd5d1`）**语义等价包含**（逐行核对：同一 8 行）；源侧为冗余副本 |
| 源 worktree 的 `CEB-003/` 未跟踪目录 | 已由 PR #2193 入库（含追加的期望哈希表）；源侧为冗余副本 |

## 4. 归档时核验摘要（全部通过，命令与输出见 PR 描述）

冻结 `--verify` OK（源与归档 worktree 双侧）· 96 单元 1:1:1:1 对应（运行文件=RESERVE=ATTEMPT_RESULT=裁定行）· 审计重算 96/96/298 全 SUCCEEDED、身份唯一 glm-5.3-flash · behavior-report `--verify` exit 0（归档副本）+ 归档研究目录再生复验 · 授权链门禁 dry-run（窗口内模拟钟）OK · CEB-001 与 CEB-003-P 在 origin/main `fa80623d3` 冻结不变（VERIFY OK）· 敏感扫描 CLEAN（无凭据模式命中）。

## 5. 结论边界

CEB-002 为探索性研究（主分析精确 McNemar p=1.0 NOT_SIGNIFICANT，n=8 判别层功效上限 0.145）。本归档不改变其结论、预注册或授权记录；B 臂 VIOLATION_ABSTENTION 信号为探索性描述，B vs C 载荷句数混杂在案（详见已入库 CEB-003-P 归档与 `RESEARCH-DECISION-REPORT.md`）。
