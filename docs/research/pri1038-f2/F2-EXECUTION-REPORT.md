# PRI-1038 F2 真实宿主实验终局报告（CEB-001，OpenClaw 通道）

- 执行日期：2026-10-30（批次 1 00:00–01:00Z 接线缺陷停机；批次 2 01:10–03:10Z 完整执行，授权窗 2026-10-29T23:27Z–2026-10-30T23:27Z）
- 授权：`docs/research/pri1038-f2/F2-RUN-AUTHORIZATION.json`（Owner 指令原文「授权F2」，36 单元 / 360 requests / 每 attempt ≤10 / 600s exec 墙钟 / 24h 窗）
- 通道：OpenClaw 2026.10.5 `agent exec`（per-round `--state-dir` 受控 state），zai / glm-5.3-flash（PRI-1037 周期 2 探针验证过的唯一通道）
- 隔离验收：PRI-1037 attempt-4 PASSED（9/9 检查 + 深验零理由），探针记录随执行副本携带并逐单元深验（`stage_r_probe_evidence_invalid` 门）
- 结论：**36/36 单元 SUCCEEDED；realHostBaseline = 正式 PASS（机器派生）**

## 1. 结果

| 臂 | 判定 | objectiveTaskOutcome |
|---|---|---|
| A（无注入） | 12/12 SUCCEEDED | **12 PASS / 0 FAIL** |
| B（原则文本） | 12/12 SUCCEEDED | 11 PASS / 1 FAIL（CT-02，no_report） |
| C′（经验摘要） | 12/12 SUCCEEDED | 11 PASS / 1 FAIL（CT-02，no_report） |

- 97 次真实模型请求（36 attempts，每单元 1–7 步，中位 3、均值 2.69），0 次预算拒绝，剩余 263/360。
- 身份：97/97 会话观测 `glm-5.3-flash`（exec 信封 + 运行时轨迹双源），97 个独立显式会话（每步一会话，会话独立性为 transport 级属性）。
- 证据：36/36 attempt 记录携带授权链（含 PASSED 探针绑定）+ `observedHostEvidence`（hostSessionId + 观测身份 + `openclaw-exec-state` 位置）；`deriveRealHostBaselineFromStudy` 正式派生 **PASS**（exec-state 轨迹逐会话佐证，模型一致性全过）。
- 行为报告：`behavior-report.json/md` 生成 + `--verify` 机器复核 = **REPORT_READY，0 findings**（分母=冻结预注册 36 单元；逐题 inputHash/goldHash 与四哈希复算核验）。
- 冻结：CEB-001/002/003-P 四哈希执行前后 VERIFY OK（零漂移）。
- 预算：36/36 attempts（顶格）、97/360 requests；本报告 = 批次 2（1793322627130 副本）完整 36 单元。

## 2. 批次 1 WIRING_DEFECT 处置（如实披露）

批次 1（副本 1793317156808，00:00–01:00Z）18 单元全部以 `invalid_action_cap`/`no_report` 收场。取证（attempt trace 的 `narrative_carried` 记录）证明模型回复是**完全合法的动作 JSON**（如 `{"type":"observe","args":{"obsId":"OBS-1"},...}` 带中文叙事）——缺陷在接线层：F2 actor 适配器无条件 `JSON.stringify(round.payload)`，而 OpenClaw transport 返回的 payload 本就是字符串，双重编码使每个回复解析为 JSON string 而非对象 → `invalid_response` ×2 → 步数帽终止。批次 1 即时停机（TaskStop），18 attempts/~36 请求度量的是接线缺陷而非行为。

处置：批次 1 副本原样保留为缺陷证据（`.tmp/pri1038-f2/1793317156808`），**不进入任何研究判定**；修复（payload 形态纪律：仅对象 stringify）+ 回归测试（string 形状解析 / object 形状不变）入库（c443eb0bd）；批次 2 于全新副本、同一授权下执行。批次 1 的请求消耗如实计入授权窗内总消耗对账（见 §4）。

## 3. 真实调用对账（授权窗内，zai/glm-5.3-flash）

| 时段(UTC) | 用途 | 请求 |
|---|---|---|
| 00:00–01:00 | 批次 1（WIRING_DEFECT，18 attempts × 2 步） | ~36 |
| 01:10–03:10 | 批次 2（有效执行，36 attempts / 97 步） | 97 |
| 合计 | 授权窗内 | **~133**（≤360 上限） |

Token 记账披露：批次 2 的 envelope 均携带 usage，但 transport→roundLog 的映射未透传（`hostRound.usage` 缺失），attempt 记录无 token 数——记账缺口如实记录（rc-9），原始 usage 保留于各 exec-state 数据库（一手证据）；适配器已补透传（后续批次受益）。本批 token 合计**NOT_RECORDED**，不作任何成本宣称。

## 4. 与 F1 基线的对比（描述性，非假设检验）

| | F1（直连模型，36/36 结算） | F2（真实宿主，36/36 SUCCEEDED） |
|---|---|---|
| 臂判定 | A 10 可评全 PASS；B 9；C 12 | A **12/12 PASS**；B 11/12；C 11/12 |
| 失败单元 | BN-01（B/C 注入臂同败，唯一判别信号） | CT-02（**B/C 注入臂同败**，A 臂同题 PASS） |
| 结构 | 单重复；UNKNOWN 清零后终局 NOT_EVALUABLE | 单重复；零 UNKNOWN；realHostBaseline=PASS |

一致性信号：A 臂天花板复现（12/12 vs F1 的 10/10 可评全 PASS）；唯一失败再次出现在 **B/C 注入臂同题同败**（CT-02）而 A 臂通过——与 F1 的「注入臂同败、B≠C 未分化」模式同构，继续支持「一般上下文效应未排除」的既有判定边界；本批 n=1 重复，不做任何假设检验、不并入确证样本。

## 5. 证据索引

| 证据 | 位置 |
|---|---|
| 授权记录（Owner 指令原文绑定） | `docs/research/pri1038-f2/F2-RUN-AUTHORIZATION.json` |
| 执行态归档（36 attempt 文件 + 三层账本 + 报告对 + 授权/探针副本） | `docs/research/pri1038-f2/execution-archive/` |
| 逐会话运行时轨迹（派生 JSONL，97 会话 × 7 事件；一手=各轮次 state sqlite） | `execution-archive/trajectories/<sessionId>.jsonl` |
| 行为报告 | `execution-archive/behavior-report.json/md`（REPORT_READY，verify 0 findings） |
| 一手 exec-state DB（含 usage 的转写事件） | `.tmp/pri1038-f2/1793322627130/f2-host-rounds/*/state/`（合并后按 git-15 清理） |
| 批次 1 缺陷证据（原样保留） | `.tmp/pri1038-f2/1793317156808/`（WIRING_DEFECT） |
| 接线与修复提交 | c556e92b4（F2 wiring）→ 9995b00d7（resume）→ c443eb0bd（payload P0）→ 本报告 |

## 6. 边界与结论

1. **PRI-1038 验收达成**：F2 真实宿主执行在授权链（Owner 授权 + PASSED 探针 + 逐单元深验）下完成，`realHostBaseline=PASS` 由 `deriveRealHostBaselineFromStudy` 机器派生——SPEC §6.4 的「不能证明隔离时停止 F2」禁令的前置条件已全部满足并被证据支撑。
2. 行为结果为**描述性**：单重复、单题族、单模型、单宿主形态；B/C 各 1 失败且同题（CT-02）不构成 B≠C 分化证据；不推翻亦不加强 CEB-001 终局判定（NOT_EVALUABLE）。
3. F2 执行不改变 §2/§3 主线（C-A/C-E）判定；CEB-002/003-P 结论零影响。
4. 本批零生产写入（每轮 side-effect 扫描干净）；所有真实调用发生在授权窗与授权通道内。
