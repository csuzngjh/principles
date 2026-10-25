# Stage G Preflight Report — CEB-001 / SPEC-PD-EXAMINER-001 v0.3

> 执行日期：2026-10-24（无模型预检）
> 状态：**READY_FOR_OWNER_REVIEW**（预检完成；Stage G 本身未授权、未执行）
> 本报告由 Owner 指令的 preflight 任务产出；不含任何真实模型调用、真实候选或真实评审结论。

---

## A. 当前基线

### A1 工作树与基线

| 项 | 值 |
|---|---|
| 分支 / HEAD | `main` @ `b62a9d8f2151858a0c0980fbc9cc9e1c2ddf7190` |
| origin/main（只读查询，未同步） | `b62a9d8f`（与本地一致） |
| 已跟踪文件修改 | **0**（`git diff --name-only` 为空，`git diff --check` 干净） |
| 未跟踪条目 | 30 项 = 原有 15 + 会话期间**外部新增 2**（`docs/implementation-reports/PRI-1019-post-update-verification-20261024.md`、`PRI-1019-runtime-and-rulecode-root-cause-20261024.md`，非本任务创建，均保留）+ Phase 1A 8 项 + Phase 1B 5 项 + 本预检 4 项（validator/enumerator/测试/本目录） |
| SPEC | `docs/specs/SPEC-PD-EXAMINER-001-v0.3.md`（sha256 `def15985…`，v0.3，579 行） |

### A2 研究材料核实

- SPEC v0.3：仓库在案，完整可读。
- Phase 0 / 1A / 1B 报告：**仅会话交付，未持久化到仓库**（`docs/implementation-reports/` 无 examiner 相关文件）——本预检不依赖其叙述，全部关键事实已对仓库实际状态重新核验（见 A3/A4）。
- Linear 工单（只读取回）：PRI-1034（Examiner 适配器 + Stage G fail-closed 授权门，Todo）、PRI-1035（Examiner vs 枚举试点，Todo，必报指标与本文 §E 一致）、PRI-1037（宿主隔离探针，Todo，NOT_RUN）。工单验收条款与 SPEC 一致，无冲突。

### A3 确定性枚举基线判定（本预检核心发现）

**判定前事实：**

1. **固定 12 题的确定性重建 = 已存在并验证 ✅**
   - 入口：`freeze-challenge-study.mjs --verify`（从 `challenge-suite.draft.json` 重新 compile 全部派生哈希并与冻结记录比对，VERIFY OK）。
   - 独立演示：在 `.tmp` 拷贝上用 lib 管线（compileSuite/freezeMapping/scoringContractHash）从草案重建 `mappingHash`/`graderHash`/`suiteHash`，三项 **IDENTICAL**；12 题 inputHash 全一致。
   - 重建不依赖随机数/时钟/网络/生产数据（1A/1B 测试含确定性断言：双拷贝运行 adjudications 逐字节相等）。
2. **生成式枚举算法 = 原本不存在 ❌**（`rg enumerateCandidates|generateCandidates|parameterSpace` 在 lab 内零命中）——draft log 的 `deterministic-enumeration` 标签只证明「零模型调用的人工确定性编写」，不证明存在可独立运行的出题算法。12 题是手写数据，含固定模板实例；无参数组合生成，无人工修订版本链（每题一次成稿）。

**处置（授权内最小修复）：** 新增 `lib/challenge-enumerator.mjs`——12 个领域内容模板 × 3 种干扰证据变体的**网格枚举器**（排序遍历、无随机/时钟/IO，**36 个候选** = 12×3 零过滤零排除（owner-review 一致性复核实测修正：初版报告误写 27，实测与断言见 `Owner-Review-Consistency-Check.md` §1），每候选携带 domain/distractor/facets 参数与 `modelCalls:0` 溯源）。它不改动冻结 12 题（那是 CEB-001 正式题集），而是 Stage G B 臂的候选池生成工具。**Go/No-Go #1 由 NOT_MET 变为 MET_FOR_PREFLIGHT（待 Owner 接受该枚举器为对照基线工具）。**

### A4 冻结资产复核（本预检未触动任何冻结内容）

| 哈希 | 值 | 状态 |
|---|---|---|
| mappingHash | `213090daecf0cbc9abfc51ca46641e4e3b835730ba9d9ec771118aaed9521290` | 不变 ✅ |
| graderHash | `eef38484c4f8ace059c178fcb0697c68154277073b7ab7a9d8c0e608ae383e79` | 不变 ✅ |
| suiteHash | `e1f2f5ca9d7f570faf454d057346c4f273e4fb467fa1790482f9a783e591fb5a` | 不变 ✅ |
| preregistrationHash | `01ac054b2aee6e84d4a1f36ae7f1ecb770567dd155da7e3a6afc88fe92c798d3` | 不变 ✅ |

研究目录无运行产物（`runs/` 不存在；三 ledger 0 字节）；`generation-authorization.json` 与 `run-authorization.json` 均 **NOT_AUTHORIZED**。本预检产物隔离于 `stage-g-preflight/` 子目录，与冻结资产分离。

---

## B. 对照实验方案（B / E 两臂）

完整协议见 `preregistration.stage-g.draft.json`（同目录）。要点：

- **B 臂（枚举）**：`challenge-enumerator.mjs` 网格生成，每候选记录来源模板/domain/distractor/facets/生成版本（generator=grid, modelCalls=0）。**不按未来 Actor 表现筛选改写候选。**
- **E 臂（Examiner）**：仅定义输入输出契约（冻结脱敏 Pain 证据 + mapping 哈希绑定 + 唯一允许模板 + 参数值域 → ChallengeDraftV1 信封）；不得改映射、不得改评分标准、不得自证有效。本预检**未调用模型、未生成任何真实 E 候选**。
- **公平性**：两臂共享同一 mappingHash、同一机制与边界、同一模板与动作集合、同一候选规模上限（32）、同一独立 Gold 标准、同一盲评规则与门槛、同一确定性校验器；E 臂无额外权威事实或权限。
- **双口径**：比较一（固定候选机会预算 36（= B 臂网格全量，owner-review 修订）：validRatio/机制覆盖/重复率/Gold 缺陷/边界覆盖/拒绝率）；比较二（相同合格题产出 16 道：总成本/人工时间/每题成本）。对齐差异逐项登记为混杂，不归因出题能力。
- **保留纪律**：全量保留（含格式错误/重复/机制偏移/无 Gold/不可执行/待修订/被拒+原因）；幸存者偏差禁止。

---

## C. 盲评方案

- 流程 7 步（RV 编号 seed 预注册 → 隐藏来源 → 按 reviewOrder 评审 → 独立判定 → 仲裁 → 事后揭示 → 全量存档）；`assignBlindReviewIds` 已实现并通过 fixture 验证（同 seed 确定性、跨 seed 换序、不改动原 candidateId/哈希、RV 编号零来源信息）。
- 八评审维度各带 pass/fail/undecidable 判据；**关键门槛** = 机制忠实度、Gold 独立性、泄漏防护——任一失败即无效，不因其他维度高分翻案。
- 双评审 + 第三方仲裁；kappa ≥0.6 采信门槛（PROPOSED）；评审者人选/时薪/工时未定 → **Owner 决策事项**；禁止模型自评替代。
- 现状：**DESIGNED_NOT_EXECUTED**——无真实评审者参与，仅本地 fixture 验证了流程函数。

---

## D. 校验器

**现状判定：** 1A 的 `challenge-compile.mjs`（schema/族/模板/Gold 结构校验）可复用但不足——缺严格未知字段拒绝、来源绑定、Gold 独立重推导、泄漏扫描、去重、盲评 ID。**本预检新增最小实现 `lib/challenge-validator.mjs`**（纯本地确定性函数，无网络/env/时钟——测试含静态证明断言）：

| 检查组 | 覆盖 |
|---|---|
| structure | 严格键集（candidate/draft/caseDef/fact/observation/requiredClaim 均拒绝未知字段）、枚举、长度/数量上限 |
| source | 模板身份 + sourceBinding.{mappingId,mappingHash} 与冻结值相等（机制漂移门）+ sourceMechanismRef 锚定映射 ID |
| executability | 复用 1A compileCase + buildClaimEnvironment |
| gold（独立重推导） | required verified 必须可由观察/ownerAnswer 蕴含结构确立；观察世界不得与 Gold 真值矛盾；边界降级设计合法但计数 |
| leak | 编译后 actor-visible 无判分键、无非预置观察输出 |
| dedup | exact（canonical 全等）+ 结构签名（数字归一化——SPEC §5.1「只换名词」陷阱的确定性代理）；**语义近似重复明确声明未解决**，路由盲评 |
| blind/coverage | RV 编号；按族候选/合格/拒绝/重复/pending + 8 项机制 facet 覆盖率 |

**测试证据：** `principle-learning-lab-challenge-stageg.test.ts` = **26/26 通过**（exit 0）：枚举器 4（确定性/自洽/覆盖/溯源）+ 正例 2 + 反例 fixture 11（未知字段×3、非法枚举/超限、机制漂移×2、外模板、无效 Gold×2、世界矛盾、Gold 泄漏、越权动作、不可执行）+ 去重 3（exact/数字改写/语义近似如实未解决）+ 盲评 2 + 统计 1 + 安全断言 3（授权占位未变、模块无网络构造静态证明、冻结哈希未变）。全部 fixture 标记 `syntheticTestFixture:true`。

---

## E. 预算与预注册（全部 PROPOSED_NOT_APPROVED）

- **指标字典**：9 项（见 prereg draft），每项含分母定义；缺失数据按 unknown 保留在分母，禁止事后收缩分母。
- **预算方案**：每臂候选机会上限 36（= B 臂网格全量）；E 臂总请求 ≤16（**含重试**）、单请求重试 ≤1（仅 FAILED_KNOWN；RESULT_UNKNOWN 禁自动重试——复用 1B 账本契约）；模型 requested/observed 双记录不符即停；输入 ≤8000/输出 ≤4000 token（调用前 max_tokens 硬限制）；费用上限 $3.0（**PROPOSED_NOT_APPROVED 草案——最坏情况算术 ≤192k tokens，单价未选定前非已验证硬预算**，详见 prereg draft §worstCaseArithmetic 与 Consistency-Check §3）；停止条件 5 项；**调用前硬限制与调用后观测值分级表述，不混称**。
- **样本量**：每臂候选机会 36 / 目标 16 合格题；如实声明为探索性证据（~36 样本下比例差 ≥0.22 才近可检出，无正式功效计算）；更强结论的 ≥60/臂方案已列（需确定性扩展 B 网格并重验证）供 Owner 单独决策。
- **Go/No-Go 阈值候选**：7 项（validRatio 差 ≥0.15、覆盖 ≥7/8 且不低于 B、重复 ≤0.20、Gold 缺陷 ≤0.10、每题成本 ≤2×B、修订中位 ≤10min、kappa ≥0.6）——**PROPOSED_NOT_APPROVED，未写入任何冻结契约**。

---

## F. 安全与授权统计

| 项 | 值 |
|---|---|
| 真实模型请求数 | **0** |
| 真实宿主实验数 | **0** |
| 真实 A/B/Summary 实验数 | **0** |
| 生产数据库写入数 | **0** |
| 冻结资产变化 | **无**（四哈希不变；verify 通过；产物隔离于 stage-g-preflight/） |
| `generation-authorization.json` | NOT_AUTHORIZED（未创建任何可执行授权记录） |
| `run-authorization.json` | NOT_AUTHORIZED |
| `realHostBaseline` / PRI-1037 | **UNKNOWN / NOT_RUN（保持原状，未改 PASS）** |
| 无模型路径证明 | 静态证明测试断言 validator/enumerator 源码无 `fetch(`/`process.env`/`http(s)://`/`Date.now`/`Math.random(`；两模块为纯函数，结构上不可能发起调用 |

---

## G. Go/No-Go 准入表（未来启动 Stage G 前）

| # | 前置条件 | 状态 |
|---|---|---|
| 1 | 确定性枚举基线可复现 | ✅ MET（重建已验证 + 枚举器本次实现并通过测试；**待 Owner 接受为对照工具**） |
| 2 | 候选生成输入及权限冻结 | ⏳ 草案就绪（prereg draft）——需 Owner 批准 |
| 3 | 输出 schema 与确定性校验器通过本地测试 | ✅ MET（26/26） |
| 4 | Gold 有独立权威来源 | ✅ MET（validator gold 独立重推导 + CEB-001 六源） |
| 5 | 盲评流程与阈值经 Owner 批准 | ❌ NOT_MET（DESIGNED；评审者/时薪/阈值待批） |
| 6 | 成本与调用预算经 Owner 批准 | ❌ NOT_MET（$3/16 请求为草案） |
| 7 | 候选来源链与失败记录可审计 | ✅ MET（provenance 字段 + 全量保留 + 1B 账本） |
| 8 | 真实模型调用单独授权 | ❌ NOT_MET（NOT_AUTHORIZED；PRI-1034 适配器未实现——实施属后续工单） |
| 9 | 失败/未知/重试符合预算与账本契约 | ✅ MET（1B 契约 + 预算方案引用） |
| 10 | Stage G 与 Stage R 权限边界分离 | ✅ MET（双授权文件分离；Stage R/PRI-1037 边界在 prereg draft §boundaries 明确） |

## 最终结论

**READY_FOR_OWNER_REVIEW** —— 预检完成：基线核实、对照协议、盲评设计、确定性校验器（含本地测试证据）、指标/预算/阈值草案全部就绪；无阻断项（无 §十 停止条件触发）。启动 Stage G 仍需 Owner：①批准本协议与阈值；②指定评审者与时薪；③批准预算；④授权 PRI-1034 实现；⑤签发 Stage G 授权（generation-authorization.json）。本预检不启动实验、不主张 Examiner 与枚举的任何优劣。
