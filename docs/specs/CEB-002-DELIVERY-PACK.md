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

## 2. CEB-002-PREREGISTRATION（预注册草案）

- **主假设 H1**（确证级预留）：在判别层（L2+L3，8 题×2 rep=16 B-C 配对）上，B 臂 objective FAIL 率 ≠ C 臂（McNemar 精确检验，双侧 α=0.05）。**基础批为探索性**：16 配对在 B−C 差异率 25% 时功效约 50-60%——**预注册升级条款**：若首轮不一致配对率 ≥30%，追加 2 rep 至 4 rep（32 配对，差异率 25% 时功效 ~85%），升级在看结果前由本条款自动授权、看结果后追加无效。
- **次指标**（探索性，Holm 不校正、如实标注）：①边界层 B 臂违规率 vs C vs A（负迁移）；②成本型配对差异（轮数/unnecessaryCostUnits，Wilcoxon）；③A−B 注入总效应。
- **失效规则**：批次 UNKNOWN 率>40%→NOT_EVALUABLE；连续两单元 UNKNOWN 停；身份/哈希/账本异常停。缺失保留分母（沿 CEB-001 纪律）。
- **明确不预注册**：不据单 case 差异宣称机制；天花板（A 臂全 PASS）如实报告为"该层无判别面"。
- 冻结流程：Owner 批准后 build-ceb002-suite.mjs 重跑（确定性重建）→计算四哈希→freeze→预注册生效。**当前全部 DRAFT-NOT-FROZEN**。

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

## 6. Owner Review Card — 一次决策

**建议批准的实验范围**：CEB-002 冻结+预注册生效+执行授权（96 attempts/960 requests 上限/订阅通道/480s/并发 3/两批）。**最小可行预算**：首批仅 L2+L3+B 层 13 题×3×2=78 单元（可先排除 L1 锚点层，但 L1 是天花板检测锚，建议保留）。**预计耗时**：冻结+预注册 <1h（确定性重建）；执行 50-70 分钟；报告收口 <1h。**可得结论**：①判别层 B vs C 配对差异（探索性→可升级确证）；②边界负迁移五情境；③天花板是否被难度梯度打破（L1 锚点对照）。**主要风险**：真实模型下 L2/L3 仍天花板（则原则收益假设在本任务族不可检验，需再上难度或换任务族）；探索性样本的单点差异不可确证。**回滚**：CEB-002 整目录为 draft，删除即回滚；CEB-001 全程零触碰（已验证）。

**等待 Owner 的三个一次性决定**：①批准 CEB-002 冻结+预注册生效；②批准执行授权（全量 96 或最小 78）；③确认探索性→确证的升级条款。批准后全自动执行到终局报告，无中途确认。
