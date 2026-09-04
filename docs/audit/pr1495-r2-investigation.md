# PR #1495 R2 — Host Tool Semantic Reliability Closure 调查报告（Phase 0 只读）

日期：2026-09-04
基准：`ai/PRI-634F-rule-reliability-foundation @ 69a8f244`（R1 修复轮已合入分支）
SPEC：《PR #1495 R2 Host Tool Semantic Reliability Closure》（P1-1 Console 绕过 resolver、P1-2 单文件多宿主覆盖、P1-3 Codex apply_patch 缺失）

---

## 0. TL;DR — SPEC 指控核对

| SPEC 指控 | 判定 | 代码证据 |
|---|---|---|
| P1-1 Console 绕过 Tool Semantic Resolver，`ApprovalsConsoleModel` 直接 `createProductionGateDeps()` 自建 RuleHostWriter，同 artifact 可能 CLI reject / Console approve | **属实** | `pd-console/src/server/models/ApprovalsConsoleModel.ts:394`（approval 完成路径）与 `ActivationsConsoleModel.ts:447`（promotion readiness 路径）都是裸 `new RuleHostWriter({ gateDeps: createProductionGateDeps(), featureFlagProbe })`——无 toolSemantics、无 workspace 声明。R1 只接了 CLI 三处与两个宿主运行时 |
| P1-2 单文件 `host-tool-semantics.json` 最后写入者胜，OpenClaw/Codex 共享 workspace 时启动顺序决定验证结果 | **属实** | R1 存储是单文件（`host-tool-declaration.ts:52-73` 整文件覆盖写）；OpenClaw auto-consumer 启动时 save（`internalization-auto-consumer-service.ts`），Codex worker 每 cycle save（`workspace-worker.ts` Step 7）——双宿主同 workspace 必然互相覆盖 |
| P1-3 Codex declaration 只声明 `Bash`，但安装器 hook matcher 是 `Bash|apply_patch`，真实 `apply_patch` 调用被判不可达 | **属实** | `create-principles-disciple/src/installers/codex-host-installer.ts:203` `matcher: 'Bash|apply_patch'`（并有 `codex-plugin-bundle.test.ts:154` 契约测试锁定）；而 `codex-adapter/src/tool-semantics.ts` 只声明 Bash |

## 1. 全部 `new RuleHostWriter` 生产创建点清单（rg 全仓核实）

| 站点 | 接线状态 | 归属 |
|---|---|---|
| `pd-cli/src/commands/runtime-activation.ts:322`（dispatch） | ✅ workspace-provenance registry + projectDir + 无声明时拒绝 | R1 已接 |
| `pd-cli/src/commands/runtime-activation.ts:570`（readiness/promote） | ✅ 同上（readiness 无声明时降级 legacy） | R1 已接 |
| `pd-cli/src/commands/runtime-activation.ts:1378`（approve 完成） | ✅ 无声明时拒绝 | R1 已接 |
| `host-runtime/src/internalization-consumer-governance.ts:112`（auto-consumer/codex-worker 治理分发） | ✅ 宿主 registry 由 ports 传入（OpenClaw/Codex 各自真实 registry） | R1 已接 |
| `pd-cli/scripts/llm-dogfood.ts:304` | ✅ dogfood 自声明（脚手架，非生产） | R1 已接 |
| `pd-console/src/server/models/ApprovalsConsoleModel.ts:394` | ❌ **裸构造，无 registry** | **P1-1 修复点** |
| `pd-console/src/server/models/ActivationsConsoleModel.ts:447` | ❌ **裸构造**（promotion readiness 的 canActivate + collectHostChecks 都用它） | **P1-1 修复点** |
| `pd-cli/src/services/demo-story-a-runner.ts:85,140` | demo 脚手架（sandbox 恒 success 桩），非生产激活路径 | 不动 |
| `principles-core/.../proven-channel-baseline.ts:267` | 核心内 proven-baseline 装配（无宿主上下文，gateDeps 由调用方注入） | 不动（core 不应依赖宿主声明 store；其消费入口若需要声明，由上游传入） |

## 2. registry 生命周期（谁写 / 谁读 / 谁覆盖）

```
写：OpenClaw auto-consumer 启动 → saveHostToolDeclaration(ws, {hostKind:'openclaw', ...})
    Codex worker 每 cycle → saveHostToolDeclaration(ws, {hostKind:'codex', ...})
    （同一路径 <ws>/.pd/host-tool-semantics.json，整文件覆盖 → 最后写者胜，P1-2 根因）
读：pd-cli resolveWorkspaceToolSemantics（dispatch/approve/readiness）
    （Console 不读 —— P1-1 根因）
```

多宿主产品事实：PD 明确支持 OpenClaw + Codex 共一个 workspace（双安装器并存、pain_events.host_kind 区分来源）——声明模型必须按宿主分区。

## 3. 宿主清单与扩展点

现存宿主：`openclaw`、`codex`（`GovernanceHostKind` 已有该联合类型）。Resolver 的宿主分区键直接取声明里的 `hostKind`，不硬编码宿主名单。

## 4. Console 侧约束（影响 Phase 2 设计）

- pd-console 已依赖 `@principles/host-runtime`（`OPENCLAW_HOST_LIVENESS_CONTRACT` 在用）→ resolver 可直接 import，无新跨包依赖。
- `ApprovalsConsoleModel` 在构造 dispatcher 前已有 `existing.channel`（:149-150）→ code_tool_hook 拒绝点可复用该信息，无需改完成服务契约。
- `ActivationsConsoleModel` 的 writer 同时服务 `validateProductionArtifact` 与 `collectHostChecks` → 只需把构造换为 resolver 版本，调用面不变。

## 5. 实施顺序（按 SPEC §五，最小化风险）

- **Phase 1（深模块）**：`host-runtime/src/host-tool-semantic-resolver.ts`——职责：多宿主声明目录读写（`<ws>/.pd/host-tool-semantics/<hostKind>.json`）+ 旧单文件一次性迁移（读旧→按 hostKind 拆分写入新目录，不删除旧文件，消费方只认新目录）+ `resolveWorkspaceToolSemantics(workspaceDir)` 返回合并 registry（全部已声明宿主的并集；单宿主 workspace 结果与 R1 等价）。旧 `save/load` 保持导出（兼容既有调用与测试），内部改指向新存储。
- **Phase 2**：Console 两处改用 `resolveWorkspaceToolSemantics`（Approvals：无法解析→refused 结构化 reason/nextAction；Activations readiness：与 CLI readiness 同语义降级）。**CLI/Console parity 测试**：同一 artifact + 同一 workspace 声明状态，两侧 refusal/放行判定一致。
- **Phase 3**：顺序无关测试（openclaw→codex 与 codex→openclaw 最终声明集合一致，两宿主 registry 均可解析）。
- **Phase 4**：Codex 声明补 `apply_patch`（write）+ reachable 测试。

## 6. SPEC 与代码的偏差记录

- SPEC 提议的 `HostToolSemanticResolver` 输入含 `artifact/target host`——代码事实是 resolver 不需要 artifact（声明是 workspace 级、宿主级，与 artifact 无关）；artifact 相关判定留在 RuleHostWriter。按代码事实收窄。
- SPEC §七 CI quick-check 问题确认为独立事项（30m 超时取消证据：run 33844533275 job 100933514851；`npm ci` 重复为根因方向），不混入本 PR，单独登记 Linear。

## 7. 明确不做（SPEC §二）

无 Behavior Contract、无 RuleScope、不改 RuleHostDecision、不新增 feature flag、不降低 replay/validation 标准。
