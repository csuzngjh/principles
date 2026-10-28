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

## 6. 评审发现记录（2026-10-28 Owner P1×2，归档字节零修改）

### 6.1 授权窗口与"账本耗尽≠全局撤销"（P1-1）

归档的 `run-authorization.json` 原文：`status: APPROVED`、`validUntil: 2026-10-28T12:22:47.763Z`、`revoked: false`、`halted: false`、`attemptCap: 96`、`requestCap: 960`。**归档与评审时点该授权在时钟上仍然有效**。原研究目录账本确实已耗尽（96 RESERVE / 96 ATTEMPT_RESULT / 298 REQUEST_RESERVE），但 Stage R 授权校验与目录预算账本是**不同检查**：以截断账本的新副本执行时，仍处有效期内的授权记录可以通过门禁。先前 PR 描述中"预算耗尽即阻断新执行"的论断**不成立，予以撤回**。

处置（Owner 指示的两条路径之一：**提前合并须有经过验证的隔离方案**——已实施）：
- 历史授权字节零修改（不置 revoked/halted——修改历史证据=禁止）；
- **授权退役注册表**（`challenge-studies/authorization-revocations.json` + Stage R 门禁退役拒绝，2026-10-28 实施）：与归档记录精确元组（studyId+suiteHash+确切窗口）匹配的记录在**任意时钟、任意研究副本**（含截断账本的新副本）下被门禁以 `authorization retired` 拒绝；注册表随 **lab 代码**（模块相对路径）而非研究数据加载——复制/截断研究数据无法摆脱它；删除条目须改仓库本体（git 保护，与门禁代码同一信任边界）；注册表畸形文件**响亮失败**（绝不静默忽略退役）；近失配（窗口差 1ms/suiteHash 不同/研究不同）不退役，按记录自身条件裁定；
- 机器验证（`principle-learning-lab-archived-authorization-gate.test.ts`，9 项）：注册表良构+精确元组匹配器+畸形响亮失败+两研究的字节钉定与退役登记+**窗口内模拟时钟下归档目录本体即拒**+**评审攻击路径（副本+截断三层账本+窗口内时钟）即拒**（且拒绝理由为退役而非过期——证明时钟无关）；
- 自然过期仍是独立后备（记录保留原窗口，时钟最终也会关闭它们）；
- 语义变化提示：退役实施后，本 README §4 中"授权链门禁 dry-run OK"的复验命令将拒绝并显示 `authorization retired`——这正是隔离生效的表现（该验证在退役前完成并记录于案）。

### 6.2 预注册元数据冲突（P1-2）

归档的 `preregistration.json`（与 `.draft.json` 同源）原文含：`status: DRAFT`、`frozenAt: null`、`notAuthorized.stageR: NOT_AUTHORIZED`、`freezeRequirement` 文案（三项批准未获）。**与"冻结并执行完毕"的归档叙述构成元数据冲突**。根因：`freeze-challenge-study.mjs` 从 draft 构造 preregistration.json 时填 freezeReferences 但**从不转换状态字段**——冻结哈希验证通过不能单独证明预注册状态字段已收口（工具缺口，非流程事实）。

处置（按 Owner 指示，不篡改历史文件）：
- 预注册/授权/账本原文全部保全；
- 本节即为冲突的显式记录；
- **批准链核对结果**（区分两件事）：
  - **"执行在绑定该预注册确切字节的授权下进行"——有证据**：授权记录绑定 `studyPlanHash = hashOfCanonical(preregistration.json) = bd0a8408…`（hashes.json 复算一致，门禁逐单元复算拒绝漂移）；96/96 attempt 记录全部携带同一授权 linkage（唯一 issuedBy=Owner 2026-10-27 三合一指令引文、唯一 suiteHash=02cbc15c）；首模型请求 2026-10-27T12:25:13.882Z **晚于**授权签发 12:22:47.763Z；全部 298 请求在窗口内。
  - **"预注册状态字段已被正确收口"——无证据**（上述 DRAFT/null/NOT_AUTHORIZED 字段从未被任何工具转换）；issuedBy 指令引文是执行代理在签发时对 Owner 指令的记录（时间学证明先于执行），非独立签名的批准文书。
- follow-up（不在本 PR）：未来研究的冻结工具应具备状态转换机制（如 FROZEN/IN_FORCE + frozenAt 回填），消除该证据缺口类。

### 6.3 对称披露：CEB-003-P（已并 main，#2193）存在同构问题

- 其归档授权（`challenge-studies/CEB-003-P/run-authorization.json`）同样 `APPROVED/revoked:false/halted:false`，**窗口至 2026-10-28T17:13:04.371Z**——评审发现的暴露类别对已合并的 CEB-003-P 同样成立；
- 其预注册状态字段同为本节 6.2 的工具缺口形态（status DRAFT 等）；其批准链证据同构：studyPlanHash=413673be… 绑定、96/96 linkage、首请求 17:20:10.661Z 晚于签发 17:13:04.371Z、全部 291 请求在窗口内；
- 对称修复已随本 PR 加入（同一退役注册表覆盖两研究，保护即刻生效、时钟无关）——归档授权（含已在 main 的 CEB-003-P）自注册表入库起即不可授权任何新执行，无需等待窗口自然过期。
