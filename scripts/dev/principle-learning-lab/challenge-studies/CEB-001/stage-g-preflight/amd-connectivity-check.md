# AMD Radeon TokenFactory — 接口连通性验证记录

> 执行日期：2026-10-25 · 性质：**合成数据连通验证**（§5 第二阶段授权范围）——与正式 Stage G 候选生成请求**完全分离**，未发送任何研究候选、未接触 Gold。
> 端点：`https://developer.amd.com.cn/radeon/api/v1`（https-only，公网 host）· Provider：`amd-radeon-tokenfactory` · Model：`GLM-5.3-Flash`
> 凭据：`~/.amd_radeon_api_key`（mode 600）/ `AMD_RADEON_API_KEY` 环境变量——未写入任何源码/测试/SPEC/日志。

## 1. 模型目录（GET /models，1 次请求）

- 目录共 **16 个模型**；GLM 系仅 1 个：**`GLM-5.3-Flash`**（在列 ✓）。
- **目录定价（美元/token）**：prompt `2.8e-7`（$0.28/M）、completion `5.6e-7`（$0.56/M）、input_cache_read `5.6e-9`；context_length **262,144**。
- 部署标记：AMD 将该模型标为 **`experimental`**（vLLM 部署：system_fingerprint `vllm-0.1.dev1+gfdd64a3db`）——记录于实验环境信息，不触发设计复审。

## 2. 最小合成请求（POST /chat/completions，2 次请求，零研究数据）

| 请求 | 参数 | 结果 |
|---|---|---|
| 探针 A | 无 response_format，max_tokens=100 | **200，1.37s**，content=`{"ok":true}`，model=`self-dploy/GLM-5.3-Flash`，usage.cost=0.00001316，reasoning_tokens=3 |
| 探针 B | `response_format=json_object` + `reasoning_effort=medium`，max_tokens=150 | **200，106.9s**，content=**null**（finish 截断），reasoning_tokens=159，usage.cost=0.00009072 |

**结论**：
- `json_object` 结构化输出**受支持**（无参数错误）。
- **reasoning 与输出共享 max_tokens 预算**（智谱思考模型已知特性）：探针 B 的 159 reasoning > 150 预算 → 内容为 null。对 Stage G 的影响与缓解已写入 transport 空内容错误信息与预注册风险节：max_tokens 用满 4000 + 提示词要求简洁；若实测 reasoning 持续 >3,500 需在预注册冻结前处置（唯一允许的技术参数议题）。
- 探针 B 耗时 106.9s（推理波动/排队）——正式运行的请求超时预算须按 ~120s+ 设计（transport 侧沿用 ambiguous→RESULT_UNKNOWN 语义，不自动重试）。
- 首次带 response_format 的早期请求出现一次 `status 000`（连接层超时）——重试即成功；正式协议已有 RESULT_UNKNOWN/不自动重试语义覆盖该类不确定性。

## 3. 模型身份核验字段（已修正进 transport）

服务器 `model` 字段带 provider 前缀（`self-dploy/GLM-5.3-Flash`）；**权威身份字段为 `metadata.requested_model` / `metadata.used_model`**（均=`GLM-5.3-Flash`）。transport 身份校验已改为 metadata 优先 + 后缀匹配，原始前缀字段不再造成误判 mismatch。

## 4. 费用与配额口径（Owner 修正 2026-10-25：**AMD 模型对 tokenfactory 用户完全免费**）

- **模型费用 = $0**（Owner 确认免费；目录美元定价 $0.28/M/$0.56/M 为名义标价）。预算账本按零模型费记账；服务器 `usage.cost` 保留为**审计备注**（nominalServerCost），不进预算。
- **$3 上限议题就此关闭**（无费用可超；上限保留为防护性常数，兼容性不再存疑）。
- **免费层风险 = 调用不稳定**（高并发共享容量）：慢响应（实测 106.9s 样本）/连接层 000/429 均可能发生。已落实的预案：
  1. 网络层失败/响应不可解析 → **AmbiguousOutcome → RESULT_UNKNOWN**（不自动重试、不误判为干净失败、请求额度保留消耗）；
  2. 429 → FAILED_KNOWN + 服务端 Retry-After 记录（重试须显式新请求并计入 16 上限）；
  3. 失败/未填槽按八类槽位契约如实记账，16 请求耗尽即止，**不因不稳定扩量**；
  4. 请求超时预算按 ≥120s 设计（慢响应实测样本）。
- 平台 points/余额端点不可程序化查询（目录无 /credits）——以服务端拒绝信号为事实准绳；points 与名义美元**均不与预算账混算**。

## 5. 限流

未触发 429（样本 3 次真实请求 + 1 次 000）。Retry-After 逻辑已实现（记录、不自动重试）——**真实 429 行为未观测，如实标注**。

## 7. 参数专项修正轮合成验证（2026-10-25 第二批：探针 C/D，合成数据零研究内容）

**模型规格核对（目录实测 vs 智谱官方，分开记录不混用）**：AMD 部署 `GLM-5.3-Flash`：context **262,144**（智谱官方 1M/128K 输出——**AMD 部署独立口径**）；目录 `supported_parameters`=[temperature,max_tokens,top_p,stream,response_format,tools,tool_choice]——**reasoning_effort 未声明**（发送被服务器接受且 reasoning 行为有变化迹象，但**效果记为 UNVERIFIED**，不假设完整实现智谱参数面）；`max_completion_tokens` 目录未报（实测 32768 被接受）。

| 探针 | 参数 | 结果 |
|---|---|---|
| C | **max_tokens=32768** + `reasoning_effort=max` + JSON 信封任务 | 200，104.6s，**finish=stop，完整 JSON envelope**；usage prompt=57/completion=106/**reasoning=60**；名义 cost 0.00007532；身份 metadata.used=GLM-5.3-Flash |
| D | **max_tokens=30**（故意饥饿） | 200，**finish=length，content=null**，reasoning=35/completion=30——精确复现截断形态，与 transport `output_budget_exhausted` 检测分支一一对应 |

**预算分解口径（供应商不可分解→如实标记）**：输入 ≤8,000（计量口径）｜生成总预算（reasoning+completion 共享）≤**32,768**（部署实测接受值）｜最终输出单独上限=**不可单独限制**（`non_decomposable_by_provider`），事后可经 `usage.completion_tokens_details.reasoning_tokens` 分解计量。

**生效参数（本轮后）**：max_tokens=32,768（默认，spec.outputTokenCap 封顶 ≤32768）；reasoning_effort=medium 默认/max 已测可用；超时两段=连接早段 15s（近似）+整体 240s；16 请求/36 槽/每请求 ≤6 候选约束**不变**；免费层 $0 计费不变。

本轮真实调用累计：AMD 合成 **6 次**（目录 1+探针 5）；正式研究候选请求仍 **0**。

## 6. 本轮真实调用统计（连通验证，非研究请求）

| 项 | 数 |
|---|---|
| AMD 真实 HTTP 请求 | **4**（1 目录 + 3 chat 探针，其中 1 次 000 失败） |
| 研究候选发送 | **0** |
| Gold/judge-only 数据接触 | **0** |
| 累计服务器计量费用 | $0.00010404（0.00001316+0.00009072，第 3 次探针 A 无 cost 回报） |
| 智谱本地编码端点验证请求（§1 本地模型，另口径） | 1（glm-5.3-flash，非 Stage G） |
