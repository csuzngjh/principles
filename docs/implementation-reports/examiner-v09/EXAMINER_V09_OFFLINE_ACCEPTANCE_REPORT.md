# EXAMINER v0.9 — Offline Acceptance Report (Phase 5)

| 属性 | 内容 |
|---|---|
| SPEC | SPEC-PD-EXAMINER-001 v0.9（Phase 5 §9 + §13 清单） |
| 分支 | `ai/adhoc-20261031-examiner-v09-7f3k2q-examiner-v09` |
| 验收日期 | 2026-11-01 |
| 执行方式 | `node scripts/dev/principle-learning-lab/run-examiner-v09-acceptance.mjs`（默认 2 重复/题） |
| 授权边界 | offline-stub only — Real Model Calls = 0 / Real Host Runs = 0 / Production Writes = 0 / Historical Asset Mutation = 0 |

## 1. 总结论

```text
OVERALL: PASS
```

两个模式的离线端到端链路全部成功；全部历史冻结资产 SHA-256 与基线 v2 逐一比对**零漂移**（593 文件）。基线 v1→v2 的唯一差异 = EXM-MVP-001-v4 的 4 个文件（授权 rebind 程序移动实现绑定与衍生 hash；executionsHash `97e2d4e7…` 不变量保持，Owner 评审内容 hash 未动），已在基线文件头部记录出处，CEB 全部研究零触碰。

## 2. 验收产物（全部持久化于 `scripts/dev/principle-learning-lab/examiner-studies/`，绝不写入冻结区 `challenge-studies/`）

| 产物 | ISO | FULL |
|---|---|---|
| Study 目录（manifest/pair-assignment/heps/rulecode/arm-configs/preregistration/hashes/suite/scoring-contract/judge-only/actor-visible） | ✅ EXM-V09-ACC-ISO | ✅ EXM-V09-ACC-FULL |
| 合法 Preregistration（FROZEN + 全 hash 钉） | ✅ | ✅ |
| A/B Pair 分配（seed 冻结、平衡随机、assignmentHash 防篡改） | 6 pairs | 6 pairs |
| 完整 Ledger（budget/events/adjudications JSONL） | ✅ | ✅ |
| Injection Evidence（每单元 sidecar，chainHash 防篡改） | 12 条 | 12 条 |
| Scorer 结果（逐 attempt 重放重评分） | ✅ | ✅ |
| ITT / Fidelity 统计（examiner 区块） | ✅ | ✅ |
| Report V2（JSON+MD） | ✅ REPORT_PENDING | ✅ REPORT_PENDING |
| Replay 验证 | ✅ | ✅ |
| 汇总 | `acceptance-summary.json` PASS | PASS |

## 3. 关键数字（acceptance-summary.json 摘录）

| 指标 | ISO | FULL |
|---|---|---|
| units | 12/12 SUCCEEDED | 12/12 SUCCEEDED |
| 注入链 | 12/12 RUNTIME_LOADED + verified | 12/12 RUNTIME_LOADED + verified |
| ITT 计划适用配对 | 4 | 4 |
| ITT 点估计 | **0.5**（ESTIMABLE，界 [0.5, 0.5]） | **0.5**（ESTIMABLE，界 [0.5, 0.5]） |
| NOT_APPLICABLE 配对（不入分母） | 2（boundary 题 × 2 重复） | 2 |
| Fidelity CONTEXT_PRESENT+ | 6/6 | 6/6 |
| Control 污染 | 0 | 0（full-library control 合法携带非目标库，目标文本零泄漏） |
| 报告状态 | REPORT_PENDING（合成 Gold——诚实态，绝不 READY） | 同左 |

ITT=0.5 的构成（可从原始记录复算）：适用配对 = 题01×2rep（Control 断言越界→FAIL，Treatment 先验证→PASS，d=+1,+1）+ 题03×2rep（双侧同行为 d=0,0）→ (1+1+0+0)/4 = 0.5。

## 4. §9.1 场景矩阵覆盖（代码级红→绿证据：`scripts/__tests__/principle-learning-lab-examiner-v09.test.ts`，41 用例全绿）

| 场景 | 证据 |
|---|---|
| Isolated A/B 仅切换目标 | `isolated mode: control payload is EMPTY` |
| Full Library 非目标冻结（漂移被拒） | `full-library arm verification detects non-target principle drift` |
| RuleCode 基线 ON 不被关闭 / OFF 保持 / 耦合→bundled | §13.A 三用例 |
| Principle/RuleCode 耦合 | `uncontrollable coupling is declared bundled_intervention` |
| HEPS Hash 漂移检测 | `HEPS … detects snapshot tampering` |
| 随机化可复算 / 篡改检测 | §13.B `pair assignment is reproducible … tamper-evident` |
| unitOrder 跳过/重复/夹带被拒 | `runner rejects a unitOrder that skips…` |
| 隔离缺失阻断（session/workspace） | preflight blockers 测试 |
| NOT_APPLICABLE 不入分母 | E2E applicability = {1 applicable, 1 notApplicable} |
| 注入失败保留 ITT | `treatment injection failure stays IN the ITT denominator` |
| UNKNOWN 五类区间 | §5.5 表逐字 it.each |
| Control 污染识别（含 full-library forbiddenContent） | fidelity 两用例 |
| 容量挤出记录 | `capacity eviction under a tight budget …` |
| Primary Endpoint 执行后不可改 | `endpoint drift … critical report finding` |
| 端到端重放 + PENDING 不覆盖 | `recomputation is byte-stable and READY protection is honored` |
| 历史 9 题身份/字节不变 | acceptance baseline 593 文件零漂移 + v4 rebind executionsHash 不变量 |
| v1/v2/v3 评分兼容 | 既有 v07 套件 155/155 全绿（零回归） |
| Console 后端全旅程 + 真实模式 403 | `tests/server/routes/examiner.test.ts` 6/6 |

## 5. 诚实边界（与 SPEC §7.3/§14 对齐）

1. 全部结果标记 `offline-stub` + `SYNTHETIC_OFFLINE` Gold——只证明契约与管线正确性，**不构成真实宿主行为结论**。
2. Report V2 状态为 REPORT_PENDING：合成 Gold 无独立人审（Gate 1 BLOCKED），报告绝不进入 READY。
3. 离线链的 HOST_ACCEPTED 证据等级语义 = 离线 transport 即宿主边界，链条 scope 标注 offline-stub，永不冒充真实宿主证明。
4. 宿主可证上限表（生产证据记录器事实）：openclaw/codex/workbuddy 的 prompt 通道当前可证至 SUBMITTED；enforcement 侧 openclaw/workbuddy 可证 RUNTIME_LOADED——真实宿主实验需 Owner 单独授权。
