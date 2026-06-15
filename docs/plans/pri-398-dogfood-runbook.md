# PRI-398 Dogfood Runbook — MVP 主链路验证

**目标:** 验证 C1-C5 五个工单打通的 MVP 数据管道，在真实 workspace 上模拟种子用户全程操作，发现潜在 bug，为 PRI-390/PRI-391 是否必做提供裁决依据。

**执行人:** AI 助手（扮演种子用户和操作员两个角色）

**产出:** 每一步的原始 JSON 输出保存到 `D:\Code\principles\docs\plans\pri-398-dogfood-runbook-output\` 目录，命名规则 `<阶段>-<步骤>.json`（或 `.txt`），方便后续分析。

---

## 输出目录 — 所有报告保存位置

```powershell
New-Item -ItemType Directory -Force -Path "D:\Code\principles\docs\plans\pri-398-dogfood-runbook-output"
```

所有文件写入该目录，命名规则：`A1-doctor.json`、`B4-pain-record.json` 等。

---

## 前置检查（执行前必须通过）

```powershell
$W = "D:\.openclaw\workspace"
$PD = "node D:\Code\principles\packages\pd-cli\dist\index.js"

# PRE-1: 确认 CLI 版本（已含 #928/#932 的构建）
Invoke-Expression "$PD --version"

# PRE-2: 备份 state.db（唯一的回滚资产，强制）
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item "$W\.pd\state.db" "$W\.pd\state.db.backup-pre-pri398-$ts"
Write-Output "Backup created: state.db.backup-pre-pri398-$ts"
# state.db 不存在则先确认目录存在再继续
```

如果 PRE-2 失败（文件不存在），说明已是空 workspace，直接从阶段 B 开始。

---

## 阶段 A — 在真实存量数据上验证（reset 之前）

> **角色：操作员。** 目的：用保留的真实链路数据（24 个任务）验证 C1/C2/C5 输出是否可信，顺便评估 Console 是否存在 PRI-390 描述的 pain 重复问题。

### A1 — 配置一致性（C1 核心验收）

```powershell
$W = "D:\.openclaw\workspace"
$OUT = "D:\Code\principles\docs\plans\pri-398-dogfood-runbook-output"

# 运行 config doctor（读 .pd/config.yaml）
node D:\Code\principles\packages\pd-cli\dist\index.js config doctor --workspace $W --json 2>&1 > "$OUT\A1-doctor.json"

# 运行 runtime probe（验证 doctor 和 probe 用同一 config 源）
node D:\Code\principles\packages\pd-cli\dist\index.js runtime probe `
  --runtime pi-ai `
  --workspace $W `
  --json 2>&1 > "$OUT\A1-probe.json"
```

**检查点（逐条在报告中标注 PASS/FAIL/BUG）：**
- `A1-doctor.json` 中 `configYaml.path` 包含 `.pd/config.yaml`
- `A1-probe.json` 中解析到的 runtime profile（provider/model）== `A1-doctor.json` 中的 internalAgents diagnostician profile
- probe 结果来源是 `.pd/config.yaml`，**不是** `.state/workflows.yaml`
- **BUG 信号:** probe 输出 provider 或 model 与 doctor 不同 → 记录 `BUG-C1-config-drift`

### A2 — 一键主链路体检（C5 核心交付）

```powershell
node D:\Code\principles\packages\pd-cli\dist\index.js mvp smoke `
  --workspace $W `
  --json 2>&1 > "$OUT\A2-smoke.json"
```

**检查点：**
- 输出是单个可解析 JSON 对象（不含任何非 JSON 前缀/后缀）
- `verdict.stages` 包含 11 个 stage
- 每个 `violation` stage 都有非空 `reason` 和 `nextAction`
- `config_source_alignment` stage: ok（已验证 A1）
- `dreamer_context` stage: 若有已完成 dreamer task，检查 `contextHash != "empty"`
- **BUG 信号 #1:** 命令抛错而非输出 JSON（ERR-066 没修好）→ 记录 `BUG-ERR066-not-fixed`
- **BUG 信号 #2:** 任何 violation stage 没有 `nextAction` → 记录 `BUG-missing-nextAction`

### A3 — 完整性检查 + 任务抽查

```powershell
# 完整性
node D:\Code\principles\packages\pd-cli\dist\index.js runtime internalization integrity `
  --workspace $W --json 2>&1 > "$OUT\A3-integrity.json"

# 全量任务列表（JSON 格式 — 新增的 --json 支持）
node D:\Code\principles\packages\pd-cli\dist\index.js task list `
  --workspace $W --json 2>&1 > "$OUT\A3-tasks.json"

# 从 A3-tasks.json 取第一个 kind==dreamer 的 taskId，运行 task show
$tasks = Get-Content "$OUT\A3-tasks.json" | ConvertFrom-Json
$dreamerTask = $tasks.tasks | Where-Object { $_.taskKind -eq 'dreamer' } | Select-Object -First 1
if ($dreamerTask) {
  node D:\Code\principles\packages\pd-cli\dist\index.js task show $dreamerTask.taskId `
    --workspace $W --json 2>&1 > "$OUT\A3-dreamer-show.json"
}
```

**检查点：**
- `A3-tasks.json`: `ok=true`，`count` > 0，每个 task 对象含 `taskId/taskKind/status`
- `A3-dreamer-show.json`: 在 diagnosticJson 里查 `pi_metadata.dependencyTaskIds`
  - **BUG 信号:** dreamer task 的 `dependencyTaskIds==[]`（老数据，这是 reset 的理由，非 bug）
  - **BUG 信号:** `cmd --json` 输出 `%-22s` 这类格式字符串而非 JSON → 记录 `BUG-taskshow-not-json`
- `A3-integrity.json`: 记录当前 `overallStatus` 和所有 brokenLinks 类型+数量（作为 reset 前基线）

### A4 — Console 渲染评估（PRI-390 裁决依据）

```powershell
# 启动 Console（后台，5 秒后截取输出）
Start-Process powershell -ArgumentList "-Command node D:\Code\principles\packages\pd-cli\dist\index.js console --workspace $W 2>&1" -PassThru
Start-Sleep -Seconds 5
# 使用 pd Console 的 API 端点（如存在）直接查询 evidence chain
$resp = Invoke-WebRequest -Uri "http://localhost:4321/api/evidence-chain" -UseBasicParsing -ErrorAction SilentlyContinue
if ($resp) { $resp.Content > "$OUT\A4-console-evidence-chain.json" }
```

如果 Console API 不可用，记录：在浏览器打开 http://localhost:4321，截图 Behavior Evidence 页，保存截图到输出目录，文字描述以下检查点：

**检查点（在输出文件中文字描述）：**
- 每条 pain 是否只显示一行（还是重复出现）
- 是否出现 `pain_N could not be linked` 未匹配警告
- 诊断链（pain → diagnosis → candidate → principle）是否可见
- **BUG 信号 = PRI-390 触发条件:** 同一 pain 显示 2 条以上记录 / 出现刷屏未匹配警告 → 记录 `BUG-PRI390-needed`
- 把结果以文字写入 `"$OUT\A4-console-assessment.txt"`

**阶段 A 结束：把 A1-A4 的 PASS/FAIL/BUG 汇总写入 `"$OUT\A-summary.txt"`**

---

## 阶段 B — Reset + 种子用户冷启动模拟

> **角色切换：从操作员切换为「第一次使用 PD 的种子用户」。**
> 
> 你是一个刚拿到 PD 的种子用户，workspace 是空的，你要从记录第一个真实问题开始，一路走到看到自己提交的问题被内化为原则，然后激活它。

### B1 — Reset（state.db 归零）

```powershell
$W = "D:\.openclaw\workspace"
# 停止任何占用 state.db 的 PD 进程（先手动确认）
Remove-Item "$W\.pd\state.db" -Force
Write-Output "state.db deleted. Workspace reset complete."
# config.yaml / feature-flags / .pd/feedback 目录 保持不动
```

### B2 — 压测空 DB 失败路径（ERR-066 修复验证，最重要的 bug 检测点）

```powershell
$OUT = "D:\Code\principles\docs\plans\pri-398-dogfood-runbook-output"

# B2-a: smoke 必须输出结构化 JSON，不能打堆栈
node D:\Code\principles\packages\pd-cli\dist\index.js mvp smoke `
  --workspace $W --json 2>&1 > "$OUT\B2-smoke-empty-db.json"
$b2_exit = $LASTEXITCODE

# B2-b: task list 同样
node D:\Code\principles\packages\pd-cli\dist\index.js task list `
  --workspace $W --json 2>&1 > "$OUT\B2-tasklist-empty-db.json"
```

**检查点（ERR-066 验收）：**
- `B2-smoke-empty-db.json`: 可被 `ConvertFrom-Json` 解析（单对象）
- `$b2_exit == 1`（非零退出）
- JSON 含 `ok: false`、`reason`（提到 DB 缺失/不可读）、`nextAction`（具体操作命令）
- stdout **不含** `at Object.` `Error:` `throw` 等堆栈字样
- **BUG 信号:** 任何堆栈出现在 B2 输出里 → `BUG-ERR066-not-fixed`

### B3 — Config 仍完好（reset 只动 state.db）

```powershell
node D:\Code\principles\packages\pd-cli\dist\index.js config doctor `
  --workspace $W --json 2>&1 > "$OUT\B3-doctor-post-reset.json"
```

**检查点：**
- `configYaml.exists: true`、`stateDb.exists: false`（或 exists 但 ok）
- **BUG 信号:** config 丢失或 featureFlags 丢失 → reset 误删了不该删的东西

### B4 — 种子用户记录第一条真实 pain

> **你是种子用户。** 你刚发现 AI 助手在执行某项任务时没有先读 AGENTS.md 就开始修改代码，导致产出了错误的结果。你要把这个问题告诉 PD。

```powershell
# 用中文写一条真实、具体的 pain（模拟真实种子用户）
$pain_reason = "AI助手在修改代码前没有阅读AGENTS.md中的错误手册，导致重复了ERR-001中描述的类型断言绕过验证问题，产生了一个不应存在的运行时类型错误"

node D:\Code\principles\packages\pd-cli\dist\index.js pain record `
  --reason $pain_reason `
  --source "manual" `
  --workspace $W `
  --json 2>&1 > "$OUT\B4-pain-record.json"
```

**检查点：**
- 输出含 `painId`（canonical ID，不是 `pain_N`）
- 输出含 `taskId`（diagnostician task 已创建）
- **BUG 信号 #1:** 没有 `painId` 字段 → 记录 `BUG-no-canonical-painId`
- **BUG 信号 #2:** 同一命令创建了 2 个 trajectory pain 行（查 task list 看是否有 2 个 diagnostician tasks）→ 记录 `BUG-PRI390-double-write`
- **BUG 信号 #3:** 命令失败/非 JSON 输出 → 记录

```powershell
# 立刻查 task list 确认只有 1 个 diagnostician task
node D:\Code\principles\packages\pd-cli\dist\index.js task list `
  --workspace $W --json 2>&1 > "$OUT\B4-tasks-after-pain.json"
# 期望: count=1, tasks[0].taskKind=="diagnostician"
```

### B5 — 跑诊断（diagnostician via LM Studio）

diagnostician 有独立命令 `pd diagnose run`，不走 `run-once`。

```powershell
# 从 B4 输出取 taskId
$b4 = Get-Content "$OUT\B4-pain-record.json" | ConvertFrom-Json
$diag_task_id = $b4.taskId

# 执行 diagnostician（-r pi-ai 让它从 .pd/config.yaml 读 LM Studio 配置）
node D:\Code\principles\packages\pd-cli\dist\index.js diagnose run `
  --task-id $diag_task_id `
  --runtime pi-ai `
  --workspace $W `
  --json 2>&1 > "$OUT\B5-run-diagnostician.json"
$b5_exit = $LASTEXITCODE
```

**检查点：**
- `B5-run-diagnostician.json`: `status=succeeded`
- `hasSucceededRun: true`（在 task show 里确认）
- 产出了 candidate

```powershell
node D:\Code\principles\packages\pd-cli\dist\index.js task list `
  --workspace $W --json 2>&1 > "$OUT\B5-tasks-after-diag.json"
# 找到 taskKind==diagnostician 的 task，status 应为 succeeded
# 找到 candidate（可通过 candidate list）
$diag_done = Get-Content "$OUT\B5-tasks-after-diag.json" | ConvertFrom-Json
$diag_task = $diag_done.tasks | Where-Object { $_.taskKind -eq 'diagnostician' }
Write-Output "Diagnostician status: $($diag_task.status)"

# 查 candidate
node D:\Code\principles\packages\pd-cli\dist\index.js candidate list `
  --task-id $diag_task.taskId `
  --workspace $W `
  --json 2>&1 > "$OUT\B5-candidates.json"
```

**BUG 信号：**
- `status != succeeded` 或无 succeeded run → `BUG-diag-no-run`（C4 的 repair 应能修）
- 无 candidate 产出 → `BUG-no-candidate`

### B6 — 内化：candidate → dreamer（#928 核心验收）

```powershell
$b5_cands = Get-Content "$OUT\B5-candidates.json" | ConvertFrom-Json
$cand_id = $b5_cands.candidates[0].candidateId

# 执行 internalize
node D:\Code\principles\packages\pd-cli\dist\index.js candidate internalize `
  --candidate-id $cand_id `
  --workspace $W `
  --json 2>&1 > "$OUT\B6-internalize.json"
```

**检查点：**
- 输出 `status=created`、`taskId`、`channel`
- **BUG 信号:** `status=no_task_created` + reason 含 lineage 相关 → lineage 没传进去

```powershell
# 读取新建的 dreamer task，验证 lineage（#928 最关键验收点）
$b6 = Get-Content "$OUT\B6-internalize.json" | ConvertFrom-Json
$dreamer_id = $b6.taskId

node D:\Code\principles\packages\pd-cli\dist\index.js task show $dreamer_id `
  --workspace $W --json 2>&1 > "$OUT\B6-dreamer-show.json"

# 解析 diagnosticJson 里的 pi_metadata.dependencyTaskIds
$dreamer_show = Get-Content "$OUT\B6-dreamer-show.json" | ConvertFrom-Json
$diag_json = $dreamer_show.task.diagnosticJson | ConvertFrom-Json
Write-Output "dreamer dependencyTaskIds: $($diag_json.pi_metadata.dependencyTaskIds)"
Write-Output "dreamer inputArtifactRefs: $($diag_json.pi_metadata.inputArtifactRefs | ConvertTo-Json)"
"dependencyTaskIds: $($diag_json.pi_metadata.dependencyTaskIds)" > "$OUT\B6-lineage-check.txt"
"inputArtifactRefs: $($diag_json.pi_metadata.inputArtifactRefs | ConvertTo-Json)" >> "$OUT\B6-lineage-check.txt"
```

**检查点（#928 验收 — 最关键）：**
- `dependencyTaskIds` 不为空（含 diagnostician taskId）
- `inputArtifactRefs` 含 `artifactType=diagnostician_output` 的条目
- **BUG 信号:** `dependencyTaskIds==[]` → #928 的 lineage 修复没有传到 production 路径 → 记录 `BUG-lineage-severed`

```powershell
# 测试失败路径：对一个 taskId/artifactId 全空的假 candidate 执行 internalize
# （预期: fail loud with invalid_candidate，不是静默产空 seed）
# 这一步需要手工构造，暂时只记录 B6 结果即可
```

### B7 — 跑 dreamer（contextHash 必须非 empty）

```powershell
node D:\Code\principles\packages\pd-cli\dist\index.js runtime internalization run-once `
  --runner dreamer `
  --runtime config `
  --workspace $W `
  --json 2>&1 > "$OUT\B7-run-dreamer.json"
$b7_exit = $LASTEXITCODE
```

**检查点（#928 验收核心）：**
- `status=succeeded`
- 在 run 结果或 task show 里查 `contextHash` — 不能是 `"empty"`
- `contextRefs.length > 0`

```powershell
$b7 = Get-Content "$OUT\B7-run-dreamer.json" | ConvertFrom-Json
Write-Output "dreamer run status: $($b7.status)"
# 取 contextHash — run-once 输出里若无，补查 task show
if ($b7.context) {
  Write-Output "contextHash: $($b7.context.contextHash)"
  Write-Output "contextRefs count: $($b7.context.contextRefs.Count)"
  "contextHash=$($b7.context.contextHash) contextRefsCount=$($b7.context.contextRefs.Count)" > "$OUT\B7-context-check.txt"
} else {
  "run-once output did not include context field; check B6-dreamer-show.json diagnosticJson" > "$OUT\B7-context-check.txt"
}
node D:\Code\principles\packages\pd-cli\dist\index.js task list `
  --workspace $W --json 2>&1 > "$OUT\B7-tasks-after-dreamer.json"
```

**BUG 信号:**
- `contextHash == "empty"` → lineage 虽然写进去了但 buildContext 没读到 → `BUG-context-still-empty`
- run status = failed → 记录失败原因

### B8 — 继续推进链路（philosopher → scribe）

```powershell
# philosopher
node D:\Code\principles\packages\pd-cli\dist\index.js runtime internalization run-once `
  --runner philosopher `
  --runtime config `
  --workspace $W `
  --json 2>&1 > "$OUT\B8-run-philosopher.json"

# scribe
node D:\Code\principles\packages\pd-cli\dist\index.js runtime internalization run-once `
  --runner scribe `
  --runtime config `
  --workspace $W `
  --json 2>&1 > "$OUT\B8-run-scribe.json"

# 检查产出原则 artifact
node D:\Code\principles\packages\pd-cli\dist\index.js task list `
  --workspace $W --json 2>&1 > "$OUT\B8-tasks-after-scribe.json"

# 检查 smoke 报告是否出现 owner_reviewable_principle = ok
node D:\Code\principles\packages\pd-cli\dist\index.js mvp smoke `
  --workspace $W --json 2>&1 > "$OUT\B8-smoke-mid.json"
(Get-Content "$OUT\B8-smoke-mid.json" | ConvertFrom-Json).verdict.stages |
  Where-Object { $_.stage -in @('dreamer_context','successor','owner_reviewable_principle') } |
  ForEach-Object { "$($_.stage): $($_.status) — $($_.reason)" } |
  Out-File "$OUT\B8-key-stages.txt"
```

**检查点：**
- scribe 产出 principle artifact
- 在 Console 里 principle 出现在 owner 审查队列
- **BUG 信号:** 任何 runner 报 contextHash=empty 或 no upstream artifact

### B9 — 最终 smoke（所有绿）

```powershell
node D:\Code\principles\packages\pd-cli\dist\index.js mvp smoke `
  --workspace $W --json 2>&1 > "$OUT\B9-smoke-final.json"
$b9_overall = (Get-Content "$OUT\B9-smoke-final.json" | ConvertFrom-Json).verdict.overall
Write-Output "FINAL SMOKE: $b9_overall"
```

**检查点：**
- `overall == "ok"`，或所有 violation 都有 `nextAction`，0 个 silent
- **BUG 信号:** dreamer_context stage 仍 violation（contextHash=empty）→ 链路未打通

---

## 汇总报告模板

执行完成后，把以下内容写入 `"$OUT\SUMMARY.txt"`：

```
=== PRI-398 Dogfood Runbook Summary ===
执行时间:
执行人:

## 阶段 A 结果
A1 config 一致性:   PASS/FAIL — 备注
A2 smoke 存量数据:   PASS/FAIL — 备注
A3 完整性+任务抽查: PASS/FAIL — 备注
A4 Console 评估:    PASS/FAIL — PRI-390 是否需要? YES/NO/PENDING

## 阶段 B 结果
B2 空 DB 失败路径:  PASS/FAIL (ERR-066 验收)
B3 Config 完好:     PASS/FAIL
B4 Pain 记录:       PASS/FAIL — painId 是否规范? 有无双写?
B5 诊断执行:        PASS/FAIL — status
B6 Lineage 验收:    PASS/FAIL — dependencyTaskIds 是否非空?
B7 Dreamer 上下文:  PASS/FAIL — contextHash = ? (非 empty = PASS)
B8 后继链路:        PASS/FAIL
B9 最终 smoke:      PASS/FAIL — overall = ?

## Bug 列表
| ID | 严重度 | 描述 | 所在步骤 | 归属工单 |
|----|--------|------|---------|---------|
| BUG-001 | ... | ... | ... | ... |

## 裁决
PRI-390 (canonical pain identity): 必须做 / 推迟 post-MVP
种子用户就绪: YES / NO — 阻塞项: ...
```

---

## 快速参考 — 所有文件

| 文件 | 内容 |
|------|------|
| `A1-doctor.json` | config doctor 输出 |
| `A1-probe.json` | runtime probe 输出 |
| `A2-smoke.json` | smoke（存量数据）|
| `A3-integrity.json` | 完整性检查（reset 前基线）|
| `A3-tasks.json` | 全量任务列表 |
| `A3-dreamer-show.json` | 存量 dreamer task 详情 |
| `A4-console-assessment.txt` | Console pain 重复问题评估 |
| `A-summary.txt` | 阶段 A 汇总 |
| `B2-smoke-empty-db.json` | 空 DB smoke（ERR-066 验收）|
| `B2-tasklist-empty-db.json` | 空 DB task list |
| `B3-doctor-post-reset.json` | reset 后 config 完好验证 |
| `B4-pain-record.json` | 种子用户第一条 pain |
| `B4-tasks-after-pain.json` | pain 后任务列表（双写检查）|
| `B5-run-diagnostician.json` | diagnostician run 结果 |
| `B5-candidates.json` | 产出的 candidates |
| `B6-internalize.json` | candidate internalize 结果 |
| `B6-dreamer-show.json` | dreamer task 详情 |
| `B6-lineage-check.txt` | dependencyTaskIds/inputArtifactRefs 人工验证 |
| `B7-run-dreamer.json` | dreamer run 结果 |
| `B8-run-philosopher.json` | philosopher run 结果 |
| `B8-run-scribe.json` | scribe run 结果 |
| `B9-smoke-final.json` | 最终 smoke（整体验收）|
| `SUMMARY.txt` | **汇总报告（我分析的主要依据）** |

---

## 注意事项

1. **B5 的 runner kind**：用 `diagnose run --help` 先确认 diagnostician 的执行方式，可能是 `pd diagnose run` 而非 `run-once --runner diagnostician`。
2. **LM Studio 必须提前启动**，且加载了 `config.yaml` 里配置的模型（当前是 qwen3.6-27b-mtp）。
3. **每步执行后** 把输出文件路径和关键字段（status/overall/painId 等）记录到 `SUMMARY.txt`，不要等到最后统一记。
4. 发现 BUG 时：立刻在 `SUMMARY.txt` 的 Bug 列表里加一行，**不要停下来修**，继续执行后续步骤，收集全部信息后一起分析。
5. A4 Console 评估：如果 `pd console` 启动后无法用 API 查询，文字描述 Behavior Evidence 页的 pain 显示情况即可（是否重复/是否未匹配），写入 `A4-console-assessment.txt`。
