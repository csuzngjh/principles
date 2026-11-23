# PD Service Host Phase 5 — 新用户默认 Service Host 实施报告（2026-11-23）

- **工单**：PRI-1278 Phase 5（新用户默认 Service Host）
- **分支**：`ai/PRI-1278-phase5-default-service-host`，基线 `bfe31e925`（origin/main）
- **范围**：新安装默认架构、首次所有权初始化、宿主与后台生命周期解耦、升级隔离
- **结论**：**实现完成，待 Owner Review**。代码/单测/隔离环境真实周期通过；真实 Windows Task Scheduler 注册在本机被 OS 策略拒绝（`E_ACCESSDENIED`），如实记录为环境门禁；未对任何现有生产 Workspace 执行翻转。

## 1. 问题与修复

| P0 | 修复 |
|---|---|
| P0-1 安装器默认选择 OpenClaw | `--host` 不再有默认值；省略即 `none`（Service-Host-only，不安装任何宿主 Adapter）。交互安装默认选择 `none`，OpenClaw/Codex/WorkBuddy 均为显式选项。manifest 允许 `hosts: []` + 已声明 Workspaces（二者皆空的文件仍视为损坏）。 |
| P0-2 Scheduler 默认不注册/不启用 | 全新安装（本次运行前不存在 `install.json`）默认注册并启用用户级 OS 调度器；`--yes` 接受该推荐默认值；`--json`/`--non-interactive` 无显式同意时返回 `consent_required` 且不创建；`--no-service-host` 显式退出；`--register-service-host` 保持“仅注册、默认禁用”。升级只 refresh-if-registered。 |
| P0-3 新 Workspace 默认 Legacy Owner | 新增 `provision_fresh_install` CAS 迁移：无任何 ownership record 的全新 Workspace 一次原子写 `service_host_owned`（generation 1）。安装器编排：调度器复核 enabled → active-release no-consume readiness → CAS → 持久化投影复核 → 首次真实 managed cycle → `<pdHome>/service/install-provisioning.json` 证据。调度器未验证 enabled 或 readiness 失败时**不翻转 Owner**。任何已有 record（含 legacy）拒绝该迁移，升级必须走 `pd service handover`。 |
| P0-4 旧生命周期仍在 | OpenClaw Gateway 的 start/tick/post-cycle marker 门禁与 quiesce 已存在（Phase 4）；Companion 的过渡态阻塞、drain-stop、崩溃重启抑制已存在并有回归测试。本轮补齐“Service-Host-only 无宿主”的真实等待状态：`waiting_for_host_binding` 不再被计为失败周期（`pd service run-once` 退出 0），状态契约暴露 `hostBindingState`。 |

## 2. 代码修改

| 文件 | 变更 |
|---|---|
| `packages/install-layout/src/index.ts` | 允许 `hosts: []` + 非空 Workspaces；仍拒绝全空 manifest；schema 注释更新 |
| `packages/install-layout/src/background-execution-transition.ts` | 新增 `provision_fresh_install`（freshInstall 证明 + 无历史 record 证明 + 幂等重放 + generation fencing + 单次原子写；拒绝覆盖任何已有 record） |
| `packages/create-principles-disciple/src/index.ts` | `--host` 无默认；`--no-service-host`；非交互同意解析；安装摘要打印 Service Host 事实块；JSON 输出 `hostAdapter` / `serviceHost` |
| `packages/create-principles-disciple/src/prompts.ts` | 宿主选择默认 `none`；新增 Service Host 后台授权说明（OS 调度器、120s、可 disable），默认 Yes，纳入最终确认；升级不提示 |
| `packages/create-principles-disciple/src/installer.ts` | 首次安装判定（manifest 缺失）；首次安装不拉入检测到的宿主；升级降级任何隐式 enable；提交后编排 scheduler + provisioning；结果携带结构化 `serviceHost` |
| `packages/create-principles-disciple/src/service-host-bridge.ts` | 同意意图模型（enable / register_only / refresh_if_registered / opt_out / consent_required）；enable 后经 `pd service status` 复核 registered+enabled；新增有界 `runInstalledCliJson`（readiness / 首次周期） |
| `packages/create-principles-disciple/src/service-host-provisioning.ts` | 新增：readiness → CAS → 投影复核 → 首次真实周期 → 证据（原子写；证据失败只告警，不掩盖所有权事实） |
| `packages/create-principles-disciple/src/utils/env.ts` | `--host none` 的 Workspace 默认 `~/pd-workspace`（不继承 `~/clawd`） |
| `packages/pd-cli/src/services/service-host/managed-run.ts` | 无宿主绑定的 service_host_owned Workspace 记为 `waiting_for_host_binding`；nextAction 明确说明 |
| `packages/pd-cli/src/services/service-host/scheduler/service-status.ts` | 状态契约新增 `hostBindingState: bound | waiting_for_host_binding` |
| `packages/pd-cli/src/services/service-host/status/service-run-status.ts` | `triggerSource` 增加 `installer`；`workspaceState` 增加 `waiting_for_host_binding` |
| `packages/pd-cli/src/commands/service-run-once.ts` / `program.ts` | `--trigger installer`；exit 0 接受 waiting_for_host_binding |

未新增：第二套 Scheduler、常驻 Daemon、Task Store、Queue、Lease、Workspace Registry 或 feature flag。

## 3. 验收矩阵结果

| 场景 | 结果 | 证据 |
|---|---|---|
| 全新安装，无 OpenClaw | PASS（设计+单测） | `--host` 无默认；`none` 不运行任何 host installer；`installManifestHosts` 为空 |
| 全新安装，只有 Codex / WorkBuddy | PASS（既有路径回归） | host 选择独立；provisioning 对 codex/workbuddy 使用 `worker --status` readiness |
| 全新安装，选择 OpenClaw | PASS（既有路径回归） | host 显式选择；Gateway marker 门禁先于重启 |
| 全新安装，Service-Host-only | PASS（真实隔离运行） | 见 §4：`waiting_for_host_binding`、exit 0、首次周期记录 |
| OpenClaw Gateway 关闭 / Companion 关闭 / Console 关闭 | 既有测试覆盖 | Phase 4 门禁与 Companion ownership 测试（本机通过） |
| Scheduler disable | 命令语义未变 | `pd service disable` 只停未来触发；provisioning 仅依赖 enabled 状态 |
| Scheduler 注册失败 | PASS | 状态 `failed` → 不调用 provisioning，owner 保持 legacy |
| Worker 崩溃 / 重复触发 | 既有 Lease/Recovery/单实例锁 | Phase 1–4 套件回归 |
| 多 Workspace | 既有隔离 + 新增记录隔离用例 | transition 测试“never touches another workspace record” |
| 历史用户升级 | PASS（单测） | intent 降级到 refresh_if_registered；已有 record 拒绝 provision |
| handover 中断 / rollback | 既有 Phase 4 套件 | `workspace-handover.test.ts` 31 例 |
| `--yes` / `--json` / `--non-interactive` 授权语义 | PASS（单测） | bridge 同意矩阵；`--json` 无同意 → `consent_required` |
| 无凭据进入参数/日志/状态 | PASS | 桥接只传路径/子命令；证据文件不含凭据 |

## 4. 真实隔离运行证据（sandbox）

安装形态：worktree 构建产物组装的真实 canonical layout（`<home>/.pd/runtime/*`、`install.json`、`active.json`），`hosts: []`、`workspaces: [workspace]`。

1. `pd service status --json` → manifest `verdict=ok`、`hosts=[]`；Workspace `discoveryVerdict=authorized`、`hostBindingState=waiting_for_host_binding`。
2. `provision_fresh_install`（真实 install-layout CAS）→ `changed=true`、`state=service_host_owned`、`effectiveOwner=service_host`、`generation=1`；持久化投影一致。
3. `pd service run-once --trigger installer --json` →
   - `outcome=completed`，`triggerSource=installer`；
   - 唯一执行记录 `workspaceState=waiting_for_host_binding`、`skipReason=no_adapter_supports_workspace:codex|workbuddy|openclaw`；
   - **exit code 0**（无宿主是合法等待态，不是失败）；
   - `statusPath=<pdHome>/service/run-once-status.json`。
4. 状态文件与 manifest 均可重新解析；无任务/证据数据被伪造。

## 5. Windows Task Scheduler 真实注册

- 本机执行 `pd service install --json --pd-home <sandbox>`：OS 返回 `System.UnauthorizedAccessException`（`E_ACCESSDENIED`）。
- 独立最小复现（不经过 PD）：`schtasks /Create /TN PDPhase5SchedulerProbe /TR "powershell.exe -NoProfile -Command Write-Output pd-phase5-probe" /SC ONLOGON /F` 同样返回 `ERROR: Access is denied.`（`DELETE` 也报找不到该任务）。这证明拒绝来自主机策略，不是 PD 的注册代码。
- PD 的行为是正确的：结构化 `scheduler_mutation_failed` + nextAction，**没有**误报为未注册，也没有静默跳过。
- 因此本轮**无法**在本机完成“真实注册 → 启用 → OS 触发 → 禁用 → 卸载”的正向链路；`scheduler-windows.process.test.ts` 在本机 afterAll 清理阶段 120s 超时（同一环境门禁）。
- 状态读取本身可工作：`registered=false`、`enabled=false`、taskName/triggerConfiguration 均从 OS 见证读取。
- 结论：**平台门禁未解除**。需要在允许创建当前用户计划任务的 Windows 主机（非受限策略）上重跑该链路后，才能对生产 Workspace 执行批量切换。

## 6. 完整发布包安装链路（npm pack → installer）
- `tests/smoke-packaged-install.test.ts` 的 “production self-contained bundle installs with no npm invocation” **真实通过**（169.5s）：`npm pack` 生成自包含发布资产 → 真实 CLI 从 `PD_INSTALL_PLUGIN_DIR` 安装到全新临时 HOME → 组件 verified/configured、Story A passed、无 npm 调用。
- 该链路使用显式 `--host openclaw`（PRI-1278 Phase 5 起 `--host` 不再有默认值）。
- 该环境的 OS 计划任务创建被拒，因此安装过程中调度器步骤以结构化警告记录，**没有**翻转任何 Workspace Owner（符合“调度器失败不翻转 Owner”）。

## 7. 升级兼容

- 全新安装判定唯一依据：本次运行开始前 `~/.pd/install.json` 不存在。
- manifest 存在 → `freshInstall=false`：
  - 不创建、不启用调度器（除显式 `--enable-service-host`）；
  - 不调用 `provision_fresh_install`；
  - 已有 `backgroundExecutions` 原样保留；
  - 已有注册只做 refresh（interval 从实时状态读回，enabled 保留）。
- 旧 Workspace 迁移入口：`pd service handover --workspace <dir>`（Phase 4 编排，含 readiness + 旧消费者停止验证）。
- 回滚：`pd service rollback --workspace <dir>`。

## 8. Owner marker 与双消费者安全

- 唯一写路径：`transitionWorkspaceBackgroundExecution`（跨进程锁 + generation fencing + operationId 幂等 + 原子 rename）。
- `provision_fresh_install` 只接受“无任何 record”的 Workspace；任何历史 record 一律 `unexpected_state`。
- 依赖 enabled 的调度器：Scheduler 未验证 enabled → 不写 marker。
- 旧消费者门禁：Companion（spawn / restart 双入口）与 OpenClaw Gateway（start / tick / post-cycle）均把 `service_host_owned` 视为禁止消费；本机回归测试全绿。
- 无双消费者：迁移前旧消费者必须停止/冻结；本轮新安装路径没有旧消费者。

## 9. 已知限制（如实披露）

1. 真实 Windows Task Scheduler 正向链路被本机 OS 策略拒绝，未验证；macOS/Linux 真机同样未验证。
2. 完整 `npm pack → installer` 链路已通过（§6），但该环境无法让调度器进入 enabled，因此“安装器端到端翻转 Owner”未被真实演示；该路径由 provisioning 单测 + sandbox CAS/周期证据覆盖。
3. Companion / OpenClaw 的“完全删除旧生命周期代码”未做：保留为 legacy_owned Workspace 的显式 fallback（符合 SPEC §11 Phase 5 的“移除或显式降级为 manual fallback”）。Service-Host-owned Workspace 的旧消费者已被门禁阻止。
4. 首次 managed cycle 的超时预算为 180s；更长的真实任务周期由下一次 OS 触发从持久化状态继续。
5. Windows 之外的 Scheduler 注册仍是既有 `NOT_VERIFIED`（Phase 3 遗留）。
6. 本机 `create-principles-disciple` 套件存在环境性失败（gateway-notice mock 超时、Windows chmod 文件模式、并行构建 EPERM），与本 PR 无关；**PR CI 全绿**（含 `Test create-principles-disciple`、`Test pd-cli`、`Test pd-cli (Windows)`、`Test packaged install smoke`、`Verify Merge Gate`、CodeQL、e2e）。

## 10. 结论

新用户安装不再依赖 OpenClaw：`--host` 无默认、Service Host 默认启用、全新 Workspace 原子获得 `service_host_owned`、首次真实周期可观测。升级用户保持原 Owner 与既有注册状态，迁移只能显式发起。

**Phase 5 生产验收仍未完成**：真实 OS 注册链路（Windows/macOS/Linux）与完整发布包安装链路需要在无策略限制的环境重跑；在此之前不宣布生产 cutover。
