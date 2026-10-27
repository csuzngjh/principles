# CEB-002 交付包（DRAFT — 待 Owner 一次决策）

> 2026-10-27 Owner 阶段转换指令交付。CEB-002 未冻结、未预注册生效、未授权执行——本文档包是**一次批准即可启动**的完整交付。核心研究问题不变：**原则抽象是否带来超越一般上下文/经验摘要的独立行为改善？是否伴随边界风险？**

## 1. CEB-002-SPEC（研究问题与设计）

**针对 CEB-001 两个结构性失败的设计回应**：

| CEB-001 失败 | CEB-002 设计 |
|---|---|
| 基线天花板（A 臂 10/10 PASS，8/9 完整 case 三臂全过） | **难度梯度 L1→L2→L3**：L1 宽预算锚点（3 题）→L2 单干扰+紧凑预算（4 题）→L3 零 slack+短 deadline+高 stakes（4 题）。全部从**冻结 B1 枚举基线池**取骨架（36 组合），仅变合法参数轴（budget/deadline/taskText）——每题过 full Stage-G validator（skeleton/parametric_verified 档，骨架 canonical 等于冻结基线，零新 Gold/事实/观察） |
| 边界可观测性弱（仅 BN-01 一个判别 case，B≠C 未分化） | **B 层 5 种不同边界情境**（非 BN-01 改写）：B1 证据预置克制（preseeded-ci 冻结域天然含预置观察）、B2 预置+零预算干扰诱惑、B3 owner 偏好 ask 纪律、B4 不可观事实推断克制、B5 不可观+过时干扰——全部由**既有** claim-evidence 评分器裁定（overCheck/budget/no_report 机制，零新评分语义） |

**三臂**：A（无注入）/B（CEB-001 冻结原则原文）/C（CEB-001 冻结摘要原文）——B/C 载荷 verbatim 复用（hash 一致断言）；**主对比=B vs C**（区分原则抽象 vs 一般上下文），A/B 估计注入总效应，边界负迁移独立预注册指标。信息量平衡审计：字符比 1.11（≤1.25 预注册带）；句数比 2:5（**预注册混杂**，随每次 B-C 比较报告）。

**16 题 × 3 臂 × 2 重复 = 96 执行单元**（36→96 分母扩大 2.67×，判别面从 1 case 扩到 L2+L3 八题+边界五情境）。

## 2. CEB-002-PREREGISTRATION（最终执行门核验版，2026-10-27）

- **定位**：探索性实验（EXPLORATORY）——固定 2 repetitions（96 单元）、无升级条款、无结果驱动加样；确证性研究须独立预注册。
- **主分析（判别层 8 题，case 级）**：**独立样本量 n=8**（判别层 L2+L3 的 8 道题各归约为一个配对单位；同题 2 次重复是重复测量，**不构成独立样本**）。归约规则**预先固定**于 `reduceCaseLevel`（测试锚定，不许事后选择）：一题记 B-worse 当且仅当 B 至少一 rep FAIL 且 C 两个 rep 全 PASS；对称记 C-worse；**两次结果不一致（两臂各有败、或同臂两 rep 不一致且对方非全 PASS 等一切其余情形）记协同**、不进入不一致对。主检验=8 个 case 级配对的 McNemar 精确（双侧 α=0.05）。
- **n=8 功效限制（如实，数学事实）**：精确检验在 n=8 仅 (8,0)/(0,8) 两类极端结局可拒——**最高功效 0.145**（每题 50% 概率 B 败 C 过且零反向）；δ=0.25/pd=0.5 时仅 0.024；保守 size≈0。**判别层 case 级确证性检验在本轮样本量下不可行**——主检验的实际角色是极端效应的否决门，效应估计以描述性统计为主（不一致率、方向、每题配对明细）。
- **参考视图（全部非确证、明确标注）**：①全 16 题 case 级配对（16 配对功效 δ=0.2→0.06-0.11、δ=0.3-0.4→0.27-0.67——含 L1 锚与 B 层，层间异质）；②重复级 32 配对（**非独立**：同题重复相关）；两视图仅辅助解释。
- **功效表适用范围**：全部三档（8/16/32）由 `mcnemarExactPower` 全枚举产出、测试锚定独立可复算；输入=p10（B 败 C 过）/p01（B 过 C 败）概率；报告时必须随附 n 与独立性标签。
- **次指标（探索性）**：边界层五情境三臂违规率对照；成本型配对差异（Wilcoxon）；重复间稳定性（同题两 rep 一致率）。
- **失效规则**：批 UNKNOWN>40%→NOT_EVALUABLE；连续两单元 UNKNOWN 停；身份/哈希/账本异常停；缺失保留分母。
- **主张限定**：B/C 句数比 2:5 预注册混杂随行；本轮支持对**该两种具体载荷**的探索性比较与效应估计；不得归因原则抽象机制、不得外推任务总体。

## 3. CEB-002-GOLD-AND-EVALUATION（Gold 独立性与评分）

- Gold 独立性：每题 skeleton canonical == 冻结基线（validator parametric/skeleton_verified 档机器强制）；真值/蕴含/观察身份零改动；Gold 不含 actor-visible 键（泄漏扫描测试钉死）。
- 评分器：**CEB-001 同一冻结评分契约**（graderHash 继承）——objectiveTaskOutcome/behaviorAligned/forbiddenBehaviorOccurred/negativeTransfer/overCheck 原语义；边界违规=评分器原判（no_report/overCheck/budget 违规类目分别计数，**不把 no_report 单一现象泛化为全部原则违规**——CEB-001 终局的教训已入设计）。
- 盲化：分析层沿用 behavior-report 六维（臂标签仅报告层出现）；本轮无新增人工盲评需求。

## 4. CEB-002-BUDGET-AND-EXECUTION（预算与执行方案）

| 项 | 值 |
|---|---|
| 执行单元 | 16 题×3 臂×2 rep=96（每单元 1 attempt） |
| attempts | 96（**CEB-002 新授权链**，与 CEB-001 链 78/78 分离） |
| requests | 上限 960（10/单元）；预期 ~4/单元≈384（CEB-001 修复后实测均值） |
| 费用 | bigmodel Coding Plan 订阅内边际 $0（同通道；最坏 960×40k token 订阅内） |
| 超时/身份 | 480000ms socket-inactivity；glm-5.3-flash 服务端观测 |
| 并发/闸门 | 并发 3、批 8 单元、批间 behavior-report+verify 核算（全流程已实证：keep-alive 修复后 18/18 成功） |
| 预计墙钟 | 串行等效 96×~90s≈2.4h；并发 3≈**50-70 分钟**（+批间闸门） |
| 停止条件 | 连续两单元 UNKNOWN/批 UNKNOWN>40%/身份/哈希/账本/预算越界 |

## 5. CEB-002-VALIDATION-REPORT（离线验证结果）

**七项全过**（套件 `principle-learning-lab-ceb002.test.ts` 6 测试 + 生成器内置 16 题逐题 validator）：
1. Gold 独立性：16/16 过 full validator（eligible tier）✓；2. 输入契约+信息匹配：泄漏扫描零命中、B/C payloadHash==CEB-001 冻结值、字符比 1.11 ✓；3. 边界评分正负：perfect-play 5/5 过 B 层零浪费；naive 过探针在预置 B1 触发 overCheck/no_report FAIL ✓；4. 难度预检：perfect-play 16/16 全过（每层可判定）；naive 策略失败率 L3>L1 单调 ✓；5. 统计：McNemar 精确实现对照已知二项值 ✓；6. 模拟：stub 跑 CEB-001 副本→REPORT_READY+verify 往返 ✓；7. 隔离：CEB-001 freeze --verify 不变+CEB-002 三重 DRAFT/NOT_AUTHORIZED 占位 ✓。回归 158/158、eslint 净、diff --check 净。
**剩余风险（如实）**：①离线 stub 预检≠真实模型难度——A 臂天花板**可能仍然存在**（perfect-play 全过只证可解性）；首批 L1 层若真实 A 臂全过而 L2/L3 分层无效，判别层缩至 L2+L3 的实际效力待验；②B/C 句数比 2:5 为预注册混杂；③2 rep 基础批为探索性（见升级条款）。

## 6. Owner Review Card — 最终执行授权卡（一次批准）

| 项 | 值 |
|---|---|
| 批准物 | ①CEB-002 冻结+预注册生效（探索性定位、固定 2 rep、无升级条款）；②执行授权 |
| 范围 | 16 题×3 臂×2 rep=**96 attempts / 960 requests 上限**（每单元 1 attempt/10 requests 机器强制） |
| 通道/费用 | bigmodel Coding Plan 订阅内边际 $0（最坏 960×40k token 订阅内）；480000ms socket-inactivity；服务端身份观测 glm-5.3-flash |
| 并发/墙钟 | 并发 3、批 8、批间报告+verify 闸门；**预计执行墙钟 50-70 分钟**+收口<1h |
| 停止条件 | 连续两单元 UNKNOWN / 批 UNKNOWN>40%→NOT_EVALUABLE / 身份异常 / 冻结哈希漂移 / 账本不一致 / 预算越界 / 未授权执行 |
| 可支持的结论 | ①判别层+边界层 B vs C 配对探索性比较（16 case 级配对，精确检验，功效局限如实）；②边界负迁移五情境三臂对照；③难度梯度是否打破 A 臂天花板（L1 锚 vs L2/L3）；④重复间稳定性。 |
| 不可确证（预声明） | 原则抽象机制的因果归因（句数混杂+探索性样本）；更广任务总体外推；确证性结论（须独立预注册）。 |
| 值得升级的信号（事后判断，非自动） | case 级 B-C 不一致率≥30% 且方向一致 → 建议独立确证性预注册（新 study/新授权） |
| 回滚 | CEB-002 目录删除即回滚；CEB-001 零触碰（freeze verify 常绿）；新授权链独立 |

**等待 Owner 的唯一决定：批准上表（冻结+预注册+执行授权三合一）。** 批准后全自动执行至终局报告（含本轮实际检验了什么/B-C 配对结果与稳定性/可支持与不可确证结论/升级信号判断/实际墙钟），无中途确认。
