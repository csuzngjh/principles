# Fixture v2 正式实验授权前最终审查报告（PLE-PILOT-02-G）

- 日期：2026-10-23；审查对象：当前 HEAD（含顺序平衡改进与最新 main merge）；性质：只读审查 + 一项预授权工程改进（顺序平衡），**零真实模型调用、零签署、零既有结果改动**

## 1. 冻结对象核对（当前 HEAD 新鲜证据，非历史引用）

| 项 | 新鲜核验值 | 判定 |
|---|---|---|
| v2 fixtureHash | `04f732e9afdc1dd0f24824ace1b40287eff37b209750f7f664dbf72ed0b21c30`（本 HEAD 重算） | ✅ 与授权记录 frozenFixtureHash 一致 |
| v1 基线 hash | `4c3ea4ab…91e9a4` 不变 | ✅ C-A/C-E 冻结未动 |
| 预注册哈希独立性 | preregistration.json **不在** FILE_ORDER 内——顺序表写入后 v2 hash 重算不变（实证） | ✅ 授权哈希稳定 |
| 五条件 armSpecs | `formal-v2` = E0/G/EA/EB/EN × policy，与预注册 contrastDesign 一致 | ✅ |
| 授权门/预算/校准测试覆盖 | 六套 159/159 于本 HEAD 全绿（含 merge 最新 main 后） | ✅ |
| main/PR | main 已前进 → 本轮已 merge（无冲突）；PR #2116 无冲突 | ✅ |

## 2. 顺序混杂审查结论（本轮唯一改动）

**结论：固定顺序确有混杂风险，已实现并冻结确定性顺序平衡**。runRealStudy 本就接受任意 armSpecs 顺序（改动仅 CLI 层顺序表+测试），无配对单位/独立会话/arm 身份破坏。**最终执行顺序（预注册，无随机性）**：
- seed 1：`E0 → G → EA → EB → EN`
- seed 2：`EA → EB → EN → E0 → G`
- seed 3：`EN → E0 → G → EA → EB`

拉丁矩性质（测试锁定）：每条件三种子位置集 {E0:1,4,2; G:2,5,3; EA:3,1,4; EB:4,2,5; EN:5,3,1}——无恒首/恒尾；残余不平衡（3×5 不可完全平衡）为**声明限制**，汇总报告将附位置敏感性检查。

## 3. G 条件干预保真度（证据分级）

- **测试证明**：渲染长度 1800c ∈ [1696,1845] 带；零验证策略词汇（consumer/grep/graph/harness/sign-off/verif/audit 等 10 词全禁）；无任何 gold canary；结构为合法 learning_history；G/EA/EB/EN 同一 I0 管线（同 contentMode）。
- **仅人工语义审查支持**：G 的两条教训（runbook 文档纪律；变更时机与值守覆盖）不含也不暗示验证深度指令；"通用运维上下文"的构造定义本身属研究判断——这恰是被测构念（"适当的一般上下文"），无法也不应被机器化。
- **无法消除的混杂（如实声明）**：I0 输出长度 ±15% 波动（G/EA/EB/EN 同受，非 G 特有）；I0 对 G 的逐种子改写变异性；预注册已规定决定性对比时的长度分层敏感性分析。**±15% 波动未被消除，不得如此宣称。**

## 4. P3 v2 差异与校准证据

- **逐项不变（测试逐字节锁定）**：`gold.gold.P3` 全等；`probes.P3.environment` 全等（隐藏消费者/损失/时限 9/授权对象/ownerModel）；probeKind 全等。
- **明确差异记录（仅两处可供性修复）**：①manual ask-owner 行新增参数接口文档（requestType='deployment-signoff'/targetKey——均为注册 action schema 的既有合法参数）；②P3 任务 policy note 点名动作与参数。其余任务行逐字节不变（测试锁定）。
- **五条件同夹具**：单一 `probes/P3.json`，全 arm 共用（数据集层保证）。
- **校准覆盖**：18/18 全绿——4 个新案例精确对应成功（CAL-15 PASS/ALIGNED）/漏签核（CAL-16 FAIL）/漏保护（CAL-17 FAIL）/过度验证（CAL-18 FAIL）；14 个 v1 案例零回归。**无任何 Oracle 放宽或失败样本删除**（gold 逐字节不变即证明）。

## 5. 预算复算（15 arm-run / 75 机会 / 12 生成调用）

| 项 | 值 | 复算 |
|---|---|---|
| 每机会 / 每 arm-run / 全场 HTTP | 48 / 256 / 3,840 | 5×48=240+1 生成 ≤256 ✓；15×256=3,840 ✓ 逐层独立强制 |
| 单请求最坏标价 | $0.0017408 | (8192×0.15+1024×0.5)/1e6 ✓ |
| arm-run / 全场影子上限 | $0.50 / $7.50 | 256×…=$0.446 ✓；3840×…=$6.68 ✓ |
| 预期实际 | ~255 请求 ≈ $0.44 标价当量 | C-A/C-E 实测 13-19 请求/arm 外推 |
| 套餐记录 | budget-audit tokenAudit（provider usage）与标价当量分列 | ✓ 授权门实测：未批准配置在出站前被拒（未签署草案拒绝测试） |

## 6. 当前 HEAD 测试与 CI 状态

- 六套 **159/159** 全绿（含顺序平衡新断言：三种顺序预览、拉丁矩性质、CLI↔预注册顺序表一致）；G1 studyHash `5a617d50…` 基线一致；eslint 0；merge 最新 main 无冲突。
- CI：本审查改动推送后以 GitHub 为准（历史 31 pass 不作当前证据）。

## 7. Owner 需批准的三个字段（一次性）

| # | 字段 | 待批值 |
|---|---|---|
| **OD-v2-1** | 预注册冻结 | 批准 v2 预注册草案 + fixtureHash `04f732e9…b21c30`（签署 `runs/v2-2026-10-23/owner-decision.json`：approved=true/decidedBy/decidedAt；同步 `authorization.json` od1.approved=true） |
| **OD-v2-2** | caps 与影子上限 | HTTP 48/256/3,840；USD 影子 $0.50/arm-run、$7.50/全场（套餐配额制，标价仅为预留上界） |
| **OD-v2-3** | 种子与顺序 | 3 种子；**预注册拉丁矩顺序表**（§2，非固定序） |

## 8. 启动命令与启动前检查清单

```bash
cd scripts && node dev/principle-learning-lab/run-formal-study.mjs \
  --authorization dev/principle-learning-lab/runs/v2-2026-10-23/authorization.json \
  --dataset dev/principle-learning-lab/fixtures-v2 \
  --arms formal-v2 --start-seed 1 --seed-count 3
```

启动前清单（CLI 自动执行，任何一项失败即零 HTTP 拒绝）：①授权记录 schema 与双签署点；②evidenceVerifier 解析 Owner 决策与定价依据；③fresh fixtureHash == 冻结值；④`ZAI_CODING_CN_API_KEY` 存在；⑤caps/费用与授权一致；⑥输出目录无已完成种子（防覆盖）；⑦dry-run 可先行预览三种顺序。
