# EXAMINER v0.9 — Final Implementation Report

```text
Owner Review Card

1. Problem
   SPEC-PD-EXAMINER-001 v0.9 需要从设计规范落成可用系统：一条 Principle 激活后
   是否真正改变宿主行为、在完整原则体系中是否仍有增量价值——此前只有 v0.7 的
   单原则三臂管线，无双模式契约、无 HEPS、无 RuleCode 策略、无六级注入证据、
   无 ITT/Fidelity、无产品入口。
2. Before
   Scorer V3/Report V2/Runner/Ledger/Freeze 已存在（v0.7，PR #2239）；
   isolated_principle/full_library、HEPS、RuleCode Policy、注入证据六级、
   ITT、Treatment Fidelity、Console 入口全部为规格级，代码零实现。
3. After
   双模式契约 + HEPS + RuleCode 策略 + 主终点冻结 + 配对随机化 + 六级注入证据链
   + ITT/Fidelity 统计 + Report V2 examiner 区块 + 离线端到端验收（OVERALL PASS）
   + Console /examiner 产品入口（创建→预检→离线执行→报告全旅程真实后端）。
4. Existing mechanism reused
   PL Lab 全套：Scorer V3、Report V2、Runner（增量）、Ledger（零改动）、
   freeze/canonical hash、compile 链、scripted stub；console 既有模型/路由/i18n/
   导航契约。未新建任何平行引擎。
5. Complexity Delta
   New source of truth: NO（研究工件 JSON，非生产真相源）
   New persisted state: NO（零 DB/schema 变更）
   New subsystem: NO
   New public abstraction: YES ×3（examiner-study / examiner-injection-evidence /
     runner examiner 臂验证+unitOrder——各为 SPEC 直接要求，闭式+测试钉死）
   New feature flag: NO
   New cross-package dependency: NO（console 动态 import dev lab，dev-scope，
     安装态 503 诚实降级）
   New host-specific behavior: NO
   New external/network capability: NO
6. Design reason
   v0.9 §15 要求 Examiner 是 PL Lab 的产品化组合而非新基础设施——全部能力
   以既有文件的增量函数 + 两个新契约模块落地；研究工件沿用既有冻结布局。
7. Verification
   41 新红→绿测试（§13 A–F 清单）+ 155 既有 v07 测试零回归 + 验收脚本
   OVERALL PASS（双模式 12/12 单元、12/12 RUNTIME_LOADED 链、ITT 复算、
   replay 一致、593 历史文件零漂移）+ v4 rebind executionsHash 不变量 +
   CEB×3 冻结验证 OK + console 3020 测试绿（含 6 个 examiner 路由测试）
   + TS/ESLint/UI build 绿。
8. Risk
   真实宿主注入证据只能证到 SUBMITTED（prompt 通道）——真实行为结论天然受限
   （见限制层面）；合成 Gold 使全部新研究报告停在 REPORT_PENDING（诚实态）。
   dev-scope console 入口在安装运行时不可用（503 显式声明而非伪装）。
9. Rollback / recovery
   单分支 PR，revert 即整体回滚；无生产数据迁移；历史资产零改动
   （基线可逐字节复验）。
10. Follow-ups（刻意不做）
   Gate 1 独立人工 Gold 审核；真实宿主授权与 Phase 6；2×2 因子执行系统；
   Scorer 维度扩展；将 lab 提升为可发布包（console 生产集成前提）。
```

---

## 1. 产品层面

- **Owner 如何使用**：侧边栏「Examiner 验证」或任一 Principle 详情页顶部「验证此原则的行为效果」→ `/examiner`（目标原则已预选）。
- **选模式**：创建表单——完整原则库增量 A/B（默认）/ 独立原则 A/B（诊断）+ 每题重复次数（1–5）。
- **Preflight**：「运行预检」展示 12 项检查（资格/HEPS/RuleCode/A-B 对比/隔离/Gold/注入能力/授权/目录保护），blocker 红色⛔、警告⚠、通过✓。
- **执行与结果**：「离线执行」→ 单元状态计数（SUCCEEDED/UNKNOWN/…）→「报告」展示 Report V2：ITT（点估计或上下界+四格表+UNKNOWN/NOT_APPLICABLE 计数）、Fidelity（CONTEXT_PRESENT+/RUNTIME_LOADED/污染/挤出）、主要终点、诚实标注。
- **理解增量价值**：模式 A 回答"原则本身有没有用"，模式 B 回答"在我的完整原则体系里还有没有额外价值"；两模式结论解释边界写入报告与 UI 文案。

## 2. 研究层面

- **ITT 正确**：固定预注册适用分母 N；d_i=F_C−F_T；五类 UNKNOWN 区间逐字实现；点估计仅在全确定时给出；注入失败样本永不分母剔除。
- **Fidelity 独立**：与 ITT 分开计算/展示（§5.4 规则文本内嵌）；"实际注入"按 CONTEXT_PRESENT+ 定义，SUBMITTED 不算。
- **Primary Endpoint 冻结**：闭式注册表绑定 Scorer V3 维度，definitionHash/applicabilityRuleHash 双钉；执行后漂移→critical finding→REPORT_INVALID（有测试）。
- **UNKNOWN 保留 / NOT_APPLICABLE 纪律**：边界题单独计数不入分母；无静默插补；`inapplicableTrigger` 负迁移由 Scorer V3 既有契约承担。
- **容量挤出**：FIFO 预算策略 + recordCapacityCompetition（逐臂记录被挤出原则 id/hash），报告分列。
- **结论边界**：离线研究永远 DESCRIPTIVE（无显著性字段）； causalAttribution 沿用 NOT_ESTIMABLE 阶梯；合成 Gold → REPORT_PENDING。

## 3. 工程层面

- 复用：Scorer V3、Report V2、Runner、Ledger、Freeze/Replay、compile、scripted stubs、console 全套框架。
- 修改：challenge-runner（unitOrder+注入 sidecar+examiner 臂验证+dispatchedOrder）、challenge-statistics（+2 函数）、challenge-behavior-report（+examiner 区块+sidecar 过滤）、generate 侧无破坏。
- 新增：lib/examiner-study.mjs（约 800 行）、lib/examiner-injection-evidence.mjs（约 230 行）、run-examiner-v09-acceptance.mjs、console 路由×2+页面+i18n、41 测试、验收产物。
- 复杂度：零新 DB/数据管道；console 生产依赖图零变化。

## 4. 质量层面

- 新增 41 测试全绿；既有 v07 lab 155 测试零回归；scripts 全量套件结果见 §6；
- Hash 验证：593 文件基线零漂移；v4 executionsHash 不变量保持；CEB×3 verify OK；
- Replay：verifyBehaviorReportV2 全 check 通过；重算字节稳定；
- 安全：Mimosa 逐文件扫描（两处高危按建议重构：路径穿越→根边界+枚举成员；正则 `.exec(`→`.match(`；SQL 参数化无涉及）；commit 前扫描 ENOBUFS 已按兼容策略继续并如实记录；
- CI：PR 提交后以 required 状态为准（不预宣称绿）。

## 5. 限制层面（须 Owner 决策/知晓）

| 项 | 状态 |
|---|---|
| Gate 1 CHALLENGE_TRUST_READY | **BLOCKED**——独立人工 Gold 审核未做（代码测试不可替代） |
| Gate 2 BEHAVIOR_EVALUATION_READY | NOT_READY（依赖 Gate 1 + 真实宿主授权） |
| Gate 3 / Gate 4 | NOT_STARTED（Gate 4 的本地开发环境预演=本次 Console 入口） |
| 真实宿主适配 | 三宿主注入证据契约已对齐；prompt 通道实际可证 SUBMITTED；WorkBuddy/OpenClaw enforcement 可证 RUNTIME_LOADED；F2 执行路径沿用 v0.7 Stage R 门 |
| 真实模型授权 | NOT GRANTED（本轮 Real Model Calls = 0） |
| 待 Owner 决策 | ① 是否为验收套件安排独立人审（解 Gate 1）② lab 打包为可发布产物以解锁 console 生产集成 ③ 真实宿主 Phase 6 授权范围 |

## 6. 验证执行记录

| 套件 | 结果 |
|---|---|
| principle-learning-lab-examiner-v09.test.ts（新增） | 41/41 ✅ |
| v07 scorer/statistics/isolation/report/productization | 155/155 ✅ |
| run-examiner-v09-acceptance.mjs | OVERALL PASS（ISO+FULL） |
| pd-console 全量 vitest | 3020 通过（含 examiner 路由 6/6、导航契约 39/39、i18n 治理） |
| pd-console tsc / eslint / build:ui | ✅ |
| CEB-001/002/003-P verifyFrozenStudy | ✅ ×3 |
| v4 rebind | executionsHash 97e2d4e7… 不变量 ✅ |
| scripts 全量 vitest（--maxWorkers=2） | 见 PR 描述（提交时以实际输出为准） |

## 7. 完成定义对照（任务书 §13）

Phase 0–5 授权范围工作全部完成；双模式契约实现；Scorer V3/Report V2 复用；Runner+六级证据链完整；ITT/Fidelity 正确；UNKNOWN/NOT_APPLICABLE 纪律正确；离线端到端 PASS；Console 最小产品入口完成；相关测试全绿；历史冻结 hash 不变；零真实模型/宿主/生产写入——

```text
IMPLEMENTATION_COMPLETE（离线实施）
Gate 1: BLOCKED（独立人审）｜Gate 2: NOT_READY｜Phase 6: 待独立授权
```
