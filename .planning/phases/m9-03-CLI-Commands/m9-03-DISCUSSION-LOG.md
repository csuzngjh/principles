# Phase m9-03: CLI Commands - Discussion Log

**Date:** 2026-04-29
**Phase:** m9-03 (CLI Commands)

## Areas Discussed

### 1. Config Source (CLI-04)
**Question:** pi-ai 的 provider/model/apiKeyEnv 配置来源？
**Options:** CLI flags + policy fallback / Pure policy-driven / CLI flags only
**Selection:** CLI flags + policy fallback
**Notes:** probe 和 diagnose 接受 --provider/--model/--apiKeyEnv/--maxRetries/--timeoutMs flags。有 flag 用 flag，没有则从 policy 读取。

### 2. Probe Scope (CLI-01)
**Question:** pd runtime probe --runtime pi-ai 应该验证什么？
**Options:** API key + model resolution + test complete / API key + model resolution / API key only
**Selection:** API key + model resolution + test complete
**Notes:** 三步验证：apiKeyEnv 存在 → getModel 不抛异常 → 最小 prompt complete 验证完整链路。

### 3. Probe Complete Detail
**Question:** probe 的 test complete 具体怎么做？
**Options:** Minimal prompt complete / Model resolution only
**Selection:** Minimal prompt complete
**Notes:** 发一个最小 prompt（如 'ping'），验证 complete 能返回。消耗少量 token 但验证完整链路。

### 4. Probe Timeout
**Question:** probe --runtime pi-ai 的超时时间？
**Options:** 30s / 15s / 60s
**Selection:** 60s
**Notes:** pi-ai 走真实 LLM 调用，需要更长时间。

### 5. Pain Record (CLI-03)
**Question:** pd pain record 是否需要接受 --runtime flag？
**Options:** No flag, pure policy / Optional --runtime flag
**Selection:** No flag, pure policy
**Notes:** 完全走 factory/policy，符合 LOCKED-03。现有代码无需修改。

### 6. Diagnose Flags (CLI-02)
**Question:** pd diagnose run --runtime pi-ai 的 flags 是否与 probe 一致？
**Options:** Same as probe / Policy only for diagnose
**Selection:** Same as probe
**Notes:** provider/model/apiKeyEnv/maxRetries/timeoutMs flags 与 probe 保持一致。

## Decisions Summary

| ID | Decision | Area |
|----|----------|------|
| D-01 | CLI flags + policy fallback | Config Source |
| D-02 | --runtime pi-ai 是必填 flag | Config Source |
| D-03 | 三步验证：apiKey + model + complete | Probe Scope |
| D-04 | probe 超时 60s | Probe Scope |
| D-05 | probe 输出包含 test complete 结果 | Probe Scope |
| D-06 | diagnose flags 与 probe 一致 | Diagnose Flags |
| D-07 | pi-ai 分支加入 runtime 选择逻辑 | Diagnose Flags |
| D-08 | pain record 不接受 --runtime flag | Pain Record |
| D-09 | apiKeyEnv 缺失 → 明确错误消息 | Error Handling |
| D-10 | test complete 失败 → 输出错误类别 | Error Handling |
| D-11 | 配置验证失败 → 包含修复建议 | Error Handling |

## Deferred Ideas

None

---
*Discussion log: 2026-04-29*
