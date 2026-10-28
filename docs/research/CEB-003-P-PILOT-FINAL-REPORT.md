# CEB-003-P Pilot 终局报告

> 2026-10-28 · 研究 `CEB-003-P`（Pilot — 操作可行性验证，非假设检验）· 状态 **COMPLETED（96/96 合法结算）**
>
> 授权：Owner 2026-10-28 Goal 指令（三合一一次批准：冻结 + 预注册生效 + 96 单元真实执行）。
> 本报告区分**观察事实**、**描述性信号**与**不可确证事项**；不承担也不支持任何因果或确证性结论。

---

## 1. 执行完整性

| 项 | 值 |
|---|---|
| 代码基线 | `ai/adhoc-20261028-ceb003p-pilot-ab383c-research-pilot`（基点 `origin/main` `48c41925f`；lab 机器脚本与 main 零漂移核验） |
| 冻结版本 | suiteHash `dec7ba6385a3cc0c…ad748977` · mappingHash `213090da…`（CEB-001/002 共享链） · graderHash `eef38484…` · preregistrationHash（studyPlanHash）`413673be…7ad7eb3a1` |
| 题集一致性 | 16 题与 CEB-002 冻结套件**逐字节一致**：每题 inputHash/goldHash 与 CEB-002 冻结 manifest 完全相等（构建时逐题断言，见 `challenge-studies/CEB-003-P/case-reuse-provenance.json`） |
| C' 载荷 | v1.1.0 文本 SHA-256 `116fbaea…34c1df4`（203 字符），冻结时重新验证；v1.0.0 原件完好（`596ef77a…`）；arm C payloadHash = 该文本哈希 |
| 预注册生效 | 机器机制：授权记录绑定 `studyPlanHash = hashOfCanonical(preregistration.json)`，门禁逐单元复算拒绝漂移；预注册混杂（B vs C-prime 内容抽象 × 语言形式不可分离）原文冻结于 preregistration.json |
| 执行授权 | `run-authorization.json` APPROVED：glm-5.3-flash / bigmodel Coding Plan 订阅通道 / F1-direct-model / 96 attempts / 960 requests / 480000ms socket-inactivity / **maxRequestsPerAttempt 10（新机器门禁绑定）** / 有效窗口 24h |
| 身份核验 | 全部 291 个真实请求的服务端自报身份逐轮记录并核验为 `glm-5.3-flash`（suffix-match，服务端 attested 字段）；零缺失、零不匹配 |
| 实际执行 | 2026-10-27T17:20:10Z → 18:57:33Z（含一次 3.5 分钟编排器工具链停止-修复-恢复），净墙钟 ≈ **94 分钟**（预计 ~130 分钟） |
| 结算 | **96/96 单元全部 SUCCEEDED**：attempts 96/96（每单元恰 1 attempt）、真实 requests **291/960**（平均 3.03/单元，最大 5/单元，每 attempt ≤10 机器强制）、REQUEST_REFUSED 0、剩余预算 669 requests |
| 批次核验 | 12 批 × 7 项检查（behavior-report 生成+verify / freeze --verify / F1 integrity 审计重算 / 账本交叉核对 / 身份核验 / 哈希链+dry-run 门禁复验 / 预算窗口）**全部 GREEN**；批间 UNKNOWN 率恒为 0% |
| 终局核验 | 最终审计 `ok:true`（96/96/291，零问题）；执行后 freeze `--verify` OK；最终 behavior-report 生成+verify 通过；**CEB-001 与 CEB-002 冻结资产执行后均 VERIFY OK（零改动）** |
| 异常记录 | ① 第 1 批门曾停止：编排器对 behavior-report `--verify` 的成功判据写错（verify 以退出码判定，stdout 为 JSON 无字面 "OK"）——七项检查实际全部通过；修复编排器判定后离线重跑第 1 批门全绿并恢复执行。此为**编排工具缺陷**，非研究停止条件触发；零真实请求损失、零数据变更。② 其余无任何 UNKNOWN/FAILED/身份/账本异常 |

## 2. Pilot 结果（全部为描述性观察）

### 2.1 三臂客观结果与失败模式

| 臂 | 定义 | PASS | FAIL | 失败模式 |
|---|---|---|---|---|
| A | 无注入 | 30/32 (93.8%) | 2 | VIOLATION_ABSTENTION×1；unknown_claim+required_claim_missing×1 |
| B | CEB-001 冻结原则原文 | 26/32 (81.3%) | 6 | no_report×3；VIOLATION_ABSTENTION×3 |
| C' | 自然经验叙事 v1.1.0 | 25/32 (78.1%) | 7 | no_report×4；VIOLATION_ABSTENTION×3 |

所有 15 个 FAIL 单元的 `forbiddenBehaviorOccurred=true`（失败种类与禁止行为判定一致）。

### 2.2 VIOLATION_ABSTENTION_OBTAINABLE（Pilot 目标 1）

**可测量性：成立**——共 7 次发生，全部被机械裁定并落账：L1-02（A r1 / B r1 / C r2）、L2-04（B r1）、L2-05（B r1 / C r1 / C r2）。

**重复稳定性（描述性）**：仅 L2-05/C' 两次重复一致出现；L1-02 在三臂各出现一次（不同 rep）；其余单次。同 (case,arm) 两 rep 结果一致的配对 35/48，不一致 13/48——单次重复噪声大，失败不可视为 (case,arm) 稳定属性。

**B 特异性：未成立**——B 3 次 vs C' 3 次 vs A 1 次；该指标在无注入臂也出现。CEB-002 的探索性信号（B 臂过度谨慎）在本 Pilot 中**不呈现 B 特异模式**（描述性对照，非检验）。

### 2.3 难度层判别空间（Pilot 目标 3）

| 层 | A | B | C' |
|---|---|---|---|
| L1×3（锚点） | 4/6 | 4/6 | 3/6 |
| L2×4（判别） | 8/8 | 5/8 | 4/8 |
| L3×4（判别） | 8/8 | 7/8 | 8/8 |
| B×5（边界） | 10/10 | 10/10 | 10/10 |

判别空间存在但形态与预期不同：A 臂失败集中在 L1（67%），L2/L3 满分；注入臂（B/C'）失败集中在 L1+L2。边界层 30/30 全 PASS——三臂均零负迁移观察（与 CEB-002 的零观察一致）。

### 2.4 运行器安全（Pilot 目标 2+4）

三臂隔离逐单元机器复验（冻结哈希+臂配置重建+臂提示组装）；单写者锁串行（并发 1）；预算预留原子性（96 RESERVE / 291 REQUEST_RESERVE 与运行文件逐条对账一致）；恢复机制经真实演练（第 1 批门停止→修复→跳过已结算单元恢复，零重复消耗）；每 attempt ≤10 请求由新增授权绑定门禁强制（实测最大 5）；账本/事件/裁定三层记录与 12 份批次 behavior-report 全部 verify 通过。

### 2.5 资源

Token：prompt 246,406 + completion 259,055 = **505,461**（全 291 请求逐轮服务端 usage 求和，无缺失轮次）。requests 291（预算 960 的 30.3%）。

## 3. 结论边界

**观察事实**：96/96 合法执行结算；291 请求全部身份核验；三臂隔离与预算/账本/报告机制全链通过；上述全部计数。

**描述性信号（不构成推断）**：VIOLATION_ABSTENTION 可测量且跨臂出现（A1/B3/C'3）；注入臂客观通过率低于 A 臂（B −12.5pp / C' −15.6pp）；边界层零负迁移；重复间不稳定为主（13/48 配对翻转）。

**不可确证事项**：
1. **任何 B vs C' 差异不能归因于原则抽象的因果效应**——预注册混杂（内容抽象程度 × 处方语言 × 句数/语言形式同时差异）未消除，本设计原理上不可分离。
2. 无假设检验、无 p 值、无效应量估计；本 Pilot 结果**不并入**任何确证性样本，**不用于**调整确证性样本量。
3. 零负迁移观察 ≠ 负迁移风险不存在（30 个边界单元、单重复、探索性口径）。
4. 与 CEB-002 的跨研究对比（如 C' 25/32 vs CEB-002-C 28/32）为不同载荷不同会话的描述性对照，不可推断。

**未解决的后续研究问题**：B 特异性是否存在（需独立预注册的确证设计）；效应方向与大小（需先载荷匹配/第三条件设计再确证）；L1 锚点层 A 臂失败的机制；no_report 失败模式的通道相关性。

## 4. 追溯与交付

| 产物 | 路径（worktree `adhoc-20261028-ceb003p-pilot-ab383c-research-pilot`） |
|---|---|
| 冻结研究目录（含 96 运行记录+三层账本+授权） | `scripts/dev/principle-learning-lab/challenge-studies/CEB-003-P/` |
| C' 载荷与契约收口产物 | `scripts/dev/principle-learning-lab/challenge-studies/CEB-003/` |
| 可复现构建器 | `scripts/dev/principle-learning-lab/prepare-ceb003p-freeze.mjs` |
| 执行编排器/审计/负控 | `.tmp/ceb003p-exec/`（orchestrator.mjs、audit.mjs、orchestrator.log、summary.json、final-audit-96.json、reports/batch-01…12、final-study-copy） |
| 授权签发与负控 | `.tmp/ceb003p-auth/`（issue.mjs、negative-controls.mjs，12/12 PASS） |
| 本报告 | `docs/research/CEB-003-P-PILOT-FINAL-REPORT.md` |
| SHA-256 清单 | `docs/research/CEB-003-P-SHA256-MANIFEST.md`（逐文件） |

**判定：CEB-003-P 四项 Pilot 目标全部达成，96/96 单元合法完成，COMPLETED。**
