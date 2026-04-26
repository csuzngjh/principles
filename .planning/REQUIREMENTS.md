# Requirements: M6 Production Runtime Adapter: OpenClaw CLI Diagnostician

**Defined:** 2026-04-24
**Core Value:** 实现第一个真实生产级 PDRuntimeAdapter，让 `pd diagnose run --runtime openclaw-cli` 能通过 OpenClaw CLI 调用真实诊断智能体，返回 DiagnosticianOutputV1，并沿用 M3/M4/M5 链路完成全流程。

## v2.5 Requirements

### CliProcessRunner

- [ ] **RUNR-01**: CliProcessRunner 新增通用进程执行器，支持 command, args, cwd, env, timeoutMs 参数
- [ ] **RUNR-02**: 捕获 stdout, stderr, exitCode, durationMs；timeout 时 kill 子进程并返回标准超时错误
- [ ] **RUNR-03**: 不使用 shell 拼接命令，必须使用 spawn/execFile 参数数组（避免 quoting injection）
- [ ] **RUNR-04**: 单测覆盖：success、non-zero exit、timeout、invalid JSON

### OpenClawCliRuntimeAdapter

- [ ] **OCRA-01**: 实现 PDRuntimeAdapter 接口，RuntimeKind = `openclaw-cli`
- [ ] **OCRA-02**: startRun 同步调用 `openclaw agent --agent <id> --message <json> --json --local --timeout <ms>` 并缓存结果，pollRun 返回 terminal status
- [ ] **OCRA-03**: fetchOutput 解析 CliOutput { text }，从 text 字段提取 JSON 并返回 DiagnosticianOutputV1
- [ ] **OCRA-04**: OpenClaw CLI 失败映射到 PDErrorCategory：
  - command not found → runtime_unavailable
  - timeout → timeout
  - non-zero exit → execution_failed
  - invalid JSON → output_invalid
  - schema mismatch → output_invalid
- [ ] **OCRA-05**: 不要求复杂异步 session 管理，第一版为 one-shot run
- [ ] **OCRA-06**: 两类 workspace 边界必须显式控制（PD workspace vs OpenClaw agent workspace），通过 cwd/env/profile/agent config 控制
- [ ] **OCRA-07**: OpenClaw invocation mode 必须显式：支持 `--openclaw-local` / config option；禁止静默 local/gateway fallback；必须测试 gateway 失败和 local 失败两种路径的 error mapping

### RuntimeKind 扩展

- [ ] **RUK-01**: RuntimeKindSchema 新增 `openclaw-cli` 字面量（全文统一：schema/CLI参数/测试/文档只用 `openclaw-cli`，不出现 `openclaw`/`openclaw-agent`/`openclaw-cli-agent` 混用）
- [ ] **RUK-02**: 不删除 TestDoubleRuntimeAdapter（仅作为显式测试 runtime，不做静默 fallback）

### DiagnosticianPromptBuilder

- [ ] **DPB-01**: 输入 DiagnosticianContextPayload，输出给 OpenClaw agent 的 message / extraSystemPrompt
- [ ] **DPB-02**: Prompt 内只输出 JSON，不包含 markdown、文件操作指令、工具调用指令
- [ ] **DPB-03**: JSON 必须符合 DiagnosticianOutputV1 schema
- [ ] **DPB-04**: Prompt 包含 contextHash、taskId、diagnosisTarget、conversationWindow 摘要、sourceRefs
- [ ] **DPB-05**: Prompt 不教 LLM 操作 PD 数据库或文件系统；代码负责提交，LLM 只负责分析

### PD CLI 扩展

- [ ] **CLI-01**: `pd diagnose run --runtime test-double` 继续工作（M4 已实现）
- [ ] **CLI-02**: `pd diagnose run --runtime openclaw-cli --agent <agentId> [--json]` 路由到 OpenClawCliRuntimeAdapter
- [ ] **CLI-03**: `pd runtime probe --runtime openclaw-cli` 返回 runtime 健康状态和 capabilities（HARD GATE）
- [ ] **CLI-04**: 所有 CLI 输出支持 `--json` 格式

### Error Mapping

- [ ] **ERR-01**: openclaw CLI binary not found / ENOENT → `runtime_unavailable`
- [ ] **ERR-02**: CliProcessRunner process timeout → `timeout`
- [ ] **ERR-03**: non-zero CLI exit code (非 ENOENT) → `execution_failed`
- [ ] **ERR-04**: CliOutput.text JSON parse failed → `output_invalid`
- [ ] **ERR-05**: CliOutput.text parse 成功但不符合 DiagnosticianOutputV1 schema → `output_invalid`

### Telemetry

- [ ] **TELE-01**: emit runtime_adapter_selected event（选择 openclaw-cli runtime 时）
- [ ] **TELE-02**: emit runtime_invocation_started event（CLI 进程启动时）
- [ ] **TELE-03**: emit runtime_invocation_succeeded / runtime_invocation_failed event（CLI 进程完成时，含 errorCategory）
- [ ] **TELE-04**: emit output_validation_succeeded / output_validation_failed event（DiagnosticianOutputV1 校验时）

### E2E / Integration Verification

#### Fake OpenClaw (无真实 OpenClaw CLI / auth 依赖)
- [ ] **E2EV-01**: CliProcessRunner mock/fake 进程 runner 验证 openclaw-cli adapter 路径（不依赖真实 openclaw binary）
- [ ] **E2EV-02**: `pd diagnose run --runtime openclaw-cli --agent <id>` 完整链路（mock runner）：task → run → DiagnosticianOutputV1 mock → artifact → candidates
- [ ] **E2EV-03**: TestDoubleRuntimeAdapter 路径不受影响（回归测试）

#### Real OpenClaw (D:\.openclaw\workspace 可用时)
- [ ] **E2EV-04**: `pd runtime probe --runtime openclaw-cli` 成功返回健康状态（HG-1 HARD GATE）
- [ ] **E2EV-05**: `pd context build` 产生有效 DiagnosticianContextPayload
- [ ] **E2EV-06**: `pd diagnose run --runtime openclaw-cli --agent <id>` 真实链路：task → run → openclaw agent → DiagnosticianOutputV1 → artifact → candidates
- [ ] **E2EV-07**: `pd candidate list` / `pd artifact show` 可查到 openclaw-cli 产出的 artifact 和 candidates

#### Legacy 回归
- [ ] **E2EV-08**: legacy import 路径（openclaw-history runtime）可正常工作

**注意**：如果真实 OpenClaw auth/agent 不可用，允许 M6 输出 `blocked evidence`（记录 blocked 原因和证据），但禁止伪造成功。

## Future Requirements (M7+)

- [ ] **MULTI-01**: 支持 `pd diagnose run --runtime claude-cli` 或 `codex-cli`
- [ ] **MULTI-02**: RuntimeSelector 根据 AgentSpec.preferredRuntimeKinds 自动选择 runtime
- [ ] **GATE-01**: principle candidate gating/scoring 流程
- [ ] **INJ-01**: active principle injection 到 agent context

## Out of Scope

| Feature | Reason |
|---------|--------|
| OpenClaw 插件 API 调用 | M6 降级为外部 CLI，不依赖插件 |
| heartbeat / prompt hook 注入 | 显式 runner 调用替代 prompt 注入 |
| sessions_spawn | 不使用 OpenClaw session 管理 |
| marker file / report file | LLM 只输出 JSON，代码负责提交 |
| OpenClaw skill dispatch | M6 不调用 skill 系统 |
| PD 状态写回 OpenClaw .state | PD 是 truth，OpenClaw 是外部 runtime |
| principle promotion | 下游消费 M6 产出 |
| PrincipleTreeLedger 修改 | M5 adapter/bridge 已完成 |
| 静默 fallback 到 TestDouble | TestDouble 仅显式测试 runtime |

## Hard Gates (HG-1 ~ HG-6)

| ID | Description |
|----|-------------|
| HG-1 | `pd runtime probe --runtime openclaw-cli` 必须交付 |
| HG-2 | OpenClaw CLI 无 `--workspace`；两 workspace 边界必须显式控制 |
| HG-3 | `--local` 不能静默 fallback，必须作为显式 option/config |
| HG-4 | OpenClaw `--json` → CliOutput { text }，DiagnosticianOutputV1 在 text 里；PD 必须解析并校验 schema |
| HG-5 | M6 签收必须包含真实 `D:\.openclaw\workspace` 验证 |
| HG-6 | 不使用 heartbeat/prompt hook/sessions_spawn/marker file/OpenClaw 插件 API |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| RUNR-01 | m6-01 | Pending |
| RUNR-02 | m6-01 | Pending |
| RUNR-03 | m6-01 | Pending |
| RUNR-04 | m6-01 | Pending |
| OCRA-01 | m6-02 | Pending |
| OCRA-02 | m6-02 | Pending |
| OCRA-03 | m6-02 | Pending |
| OCRA-04 | m6-02 | Pending |
| OCRA-05 | m6-02 | Pending |
| OCRA-06 | m6-03 | Pending |
| OCRA-07 | m6-03 | Pending |
| RUK-01 | m6-01 | Pending |
| RUK-02 | m6-01 | Pending |
| DPB-01 | m6-03 | Pending |
| DPB-02 | m6-03 | Pending |
| DPB-03 | m6-03 | Pending |
| DPB-04 | m6-03 | Pending |
| DPB-05 | m6-03 | Pending |
| CLI-01 | m6-04 | Pending |
| CLI-02 | m6-04 | Pending |
| CLI-03 | m6-04 | Pending |
| CLI-04 | m6-04 | Pending |
| ERR-01 | m6-04 | Pending |
| ERR-02 | m6-04 | Pending |
| ERR-03 | m6-04 | Pending |
| ERR-04 | m6-04 | Pending |
| ERR-05 | m6-04 | Pending |
| OCRA-07 | m6-03 | Pending |
| TELE-01 | m6-05 | Pending |
| TELE-02 | m6-05 | Pending |
| TELE-03 | m6-05 | Pending |
| TELE-04 | m6-05 | Pending |
| E2EV-01 | m6-06 | Pending |
| E2EV-02 | m6-06 | Pending |
| E2EV-03 | m6-06 | Pending |
| E2EV-04 | m6-06 | Pending |
| E2EV-05 | m6-06 | Pending |
| E2EV-06 | m6-06 | Pending |
| E2EV-07 | m6-06 | Pending |
| E2EV-08 | m6-06 | Pending |

**Coverage:**
- v2.5 requirements: 38 total (RUK-02 + OCRA-07 + E2EV split; ERR-01~05 renumbered but count unchanged)
- Mapped to phases: 38
- Unmapped: 0

---
*Requirements defined: 2026-04-24*
*Last updated: 2026-04-24 after roadmap creation*
