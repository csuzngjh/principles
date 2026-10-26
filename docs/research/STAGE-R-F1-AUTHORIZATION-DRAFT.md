# Stage R F1 授权草案（DRAFT — 非生效，待 Owner 审批）

> 状态：**DRAFT / NOT_ISSUED**。本文件是给 Owner 的审批材料，不是授权本身。
> 活体 `challenge-studies/CEB-001/run-authorization.json` 保持 `NOT_AUTHORIZED`，
> 在 Owner 明确批准并亲自（或授权发版流程）写入正式记录前，任何真实执行都会被
> Stage R 授权门拒绝（fail-closed，代码强制，见 PR #2139/#2140 已合并实现）。
>
> 依据：SPEC-PD-EXAMINER-001 v0.4 §2.2 F1_CONTROLLED_ACTOR（真实模型 API +
> 固定 JSON action + 确定性 Oracle）。F1 不以 PRI-1037 为前置（F2 专属）。

## 一、授权记录草案（Owner 批准后写入研究副本的 run-authorization.json）

```json
{
  "schema": "challenge-stage-authorization.v1",
  "stage": "R",
  "status": "APPROVED",
  "studyId": "CEB-001",
  "suiteHash": "e1f2f5ca9d7f570faf454d057346c4f273e4fb467fa1790482f9a783e591fb5a",
  "mappingHash": "213090daecf0cbc9abfc51ca46641e4e3b835730ba9d9ec771118aaed9521290",
  "graderHash": "eef38484c4f8ace059c178fcb0697c68154277073b7ab7a9d8c0e608ae383e79",
  "studyPlanHash": "01ac054b2aee6e84d4a1f36ae7f1ecb770567dd155da7e3a6afc88fe92c798d3",
  "requestedActorIdentity": "GLM-5.3-Flash",
  "executionMode": "F1-direct-model",
  "arms": ["A", "B", "C"],
  "cases": ["CEB-001-FV-01", "CEB-001-FV-02", "CEB-001-FV-03", "CEB-001-CX-01", "CEB-001-CX-02", "CEB-001-CX-03", "CEB-001-BN-01", "CEB-001-BN-02", "CEB-001-BN-03", "CEB-001-TC-01", "CEB-001-TC-02", "CEB-001-TC-03"],
  "repetitions": ["1"],
  "attemptCap": 48,
  "requestCap": 1440,
  "issuedBy": "<Owner 决定署名>",
  "validFrom": "<签发时刻，ISO-8601 带时区>",
  "validUntil": "<签发 + 48h，ISO-8601 带时区>",
  "revoked": false,
  "halted": false
}
```

**身份一致性核对（代码级）**：`requestedActorIdentity: "GLM-5.3-Flash"` 与
`AMD_MODEL_ID`（`challenge-amd-transport.mjs` 常量）精确一致；runner 的
mode-consistency 检查要求 `createRealModelActor` 暴露的
`requestedModelIdentity`（= responder 的 `modelId` = `GLM-5.3-Flash`）与授权值
精确相等或 provider 后缀匹配；responder 的身份裁决器只认服务端
`metadata.used_model` / 原始 `model` 字段（精确或 `provider/model` 后缀），
`requested_model` 回显仅入审计。三处口径闭合于同一字符串。

## 二、研究计划与预算核算（源码推导，非经验值）

| 项 | 值 | 源码依据 |
| --- | --- | --- |
| 研究单元数 | 36 = 12 题 × 3 臂 × 1 重复 | `suite-manifest.json`（12 cases）；`preregistration.json`（A/B/C，repetitions.planned=1） |
| 单单元最大模型请求数 | **40** | actor 循环 `runControlledActorLoop`：每迭代恰 1 次 `reserveRequest(runState.step)` + 1 次 `actor.nextAction`；循环条件 `runState.step >= caps.maxSteps(40)` 终止（`challenge-actor.mjs`） |
| 无效动作是否额外消耗 | **是——无效动作同样消耗 step 与请求预留** | `stepClaimEnvironment` 在入口 `state.step += 1`（先于 action 合法性判定，`claim-evidence-env.mjs` L146-150）；`maxInvalidActions=2` 只是提前终止条件，不扩大请求上限 |
| attemptCap 的计数对象 | **研究级总 RESERVE 行数**（跨全部单元的 attempt 总数，每 unit×attemptId 恰一行，幂等） | `challenge-ledger.mjs reserveAttempt`：`used = entries.filter(e => e.type === 'RESERVE').length` |
| requestCap 的计数对象 | **研究级累计 REQUEST_RESERVE 行数**（attempt+step 幂等键；新 attemptId 产生新键但计入同一总额；已派发未应答不返还） | `challenge-ledger.mjs reserveModelRequest` L159；`reserveAttempt`/`reserveModelRequest` 均 never-return |
| requestCap 是否覆盖重跑/恢复 | **是**——崩溃恢复的新 attemptId 计入同一 requestCap 总数 | 同上 |
| 全计划理论最大请求数 | **36 × 40 = 1440**（每单元跑满 40 步且无 report/invalid 提前终止的硬上界） | 上面两行相乘 |
| requestCap 过低时的行为 | 循环在派发前预留被拒 → `request_budget_exhausted` 终止 → 该 attempt 按当前状态评分结算（trace/账本完整），后续单元同样快速终止——研究以"预算受限"形态完成，不崩溃不中断 | `runControlledActorLoop` reserveRequest 拒绝分支；stager/CLI 测试断言 |

**attemptCap = 48**：36（计划内初跑）+ 12（33% 恢复余量——每个 RESULT_UNKNOWN
单元如需重跑须用新 attemptId，各自再消耗 1 个 RESERVE）。
**requestCap = 1440**：恰好覆盖初跑理论最坏（硬上界，非估计）；不含重跑余量——
RESULT_UNKNOWN 的处置见第四节（不自动重跑，重跑需 Owner 追加授权）。

## 三、请求与 Token 预算

- 单请求：输入 ≤ 8000 tokens（`spec.inputTokenCap`，计量口径）；生成总预算
  （reasoning+completion 共享）max_tokens ≤ 32768（部署实测上限，供应商不可
  分解报告）；`response_format: json_object`。
- 研究级：requestCap=1440 是唯一的硬闸；token 不设独立停止线（每请求的实际
  usage 由 responder 记入 actorRounds 与失败回复，事后审计）。
- 超时：connect 15s / request 240s；超时按 ambiguous → RESULT_UNKNOWN（请求
  可能已到达，结果不可知）。

## 四、停止条件与 RESULT_UNKNOWN 处置

自动停止（代码强制）：
1. `requestCap` 耗尽 → 每单元在派发前被拒，研究收口（预算受限形态）。
2. `attemptCap` 耗尽 → 新 RESERVE 被拒（`budget_exhausted`）。
3. 任何 `model_identity_mismatch / conflict / unobserved` → 该请求记为已知失败
   （usage 证据保留）——若大量出现即为授权绑定错误的实证，Owner 应 halt。

操作停止（Owner 侧，写入本草案供执行轮遵守）：
4. 连续 3 个单元 RESULT_UNKNOWN（免费通道饱和信号，Stage G round8/9 先例）
   → 暂停，不要烧完 requestCap。
5. Owner 随时可在授权记录置 `"halted": true` → 门立即拒绝（halt 检查在窗口/预算之前）。

RESULT_UNKNOWN 处置：
- 同一 attemptId **永不自动重试**（`classifyUnit` → `result_unknown_no_auto_retry`）。
- 已派发未应答的请求槽位**不返还**（never-return 纪律）。
- 本轮授权内 RESULT_UNKNOWN 单元保持其状态收口；如 Owner 决定重跑，追加授权
  （提高 attemptCap/requestCap 或签发新记录）后以新 attemptId 执行。

撤销：Owner 置 `"revoked": true` 即生效（门在每次预留前重读授权记录的运行中
校验每单元执行）。

## 五、启动步骤（Owner 批准后）

```bash
# 0) 确认两 PR 已合并（#2139=a3a467794, #2140=f2b51366d）且工作区干净
# 1) 复制研究目录（保护活体冻结资产）
cp -r scripts/dev/principle-learning-lab/challenge-studies/CEB-001 .tmp/stage-r-f1-run/
# 2) 在【副本】写入上述已批准的 run-authorization.json（不改活体）
# 3) 计划核验（零网络、零执行、零账本写入）
node scripts/dev/principle-learning-lab/run-challenge-study.mjs \
  --study-dir .tmp/stage-r-f1-run --execution-mode F1-direct-model \
  --now <当前时刻 ISO> --dry-run
# 4) 核对打印的计划/预算行后，去掉 --dry-run 正式执行
```

凭据：`AMD_RADEON_API_KEY` 环境变量或 `~/.amd_radeon_api_key`（mode 600）；
缺失时 beforeSend 干净拒绝（零网络）；密钥永不入日志/账本/授权文件。
