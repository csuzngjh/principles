# Handoff: Fix Symphony Windows/ACPX Usability

## 任务目标

让 Symphony 在 Windows 上通过 **ACPX** 启动 **Claude Code**（不是 Codex app-server），实现完整闭环：

Linear active issue → Symphony 发现 issue → 创建 workspace → after_create hook → ACPX 启动 Claude Code session → agent 执行 → 日志可诊断

## 关键约束（用户明确要求）

1. **ACPX 优先直接执行终端里的 acpx 命令**，不要默认 `node <acpx dist/cli.js>`，不要默认 `codex app-server`
2. **WORKFLOW.md 的 codex.command 必须是 `claude`**，不是 `codex app-server`
3. **D:\Code\symphony-clean 是 D:\Code\principles\symphony 的 git worktree**，分支 `fix/windows-acpx-usability`
4. 只提交和 Windows/ACPX usability 直接相关的文件

## 两个仓库的关系

- **D:\Code\principles** = 主仓库（root repo），包含 WORKFLOW.md、项目代码
- **D:\Code\symphony-clean** = `D:\Code\principles\symphony` 的 git worktree，分支 `fix/windows-acpx-usability`
- symphony-clean 的改动最终会反映到 `D:\Code\principles\symphony`

## 当前状态：严重跑偏，需要回退和修正

### 跑偏 1：WORKFLOW.md 被改成了 codex app-server

**当前错误状态** (`D:\Code\principles\WORKFLOW.md`):
```yaml
codex:
  agent: "claude"
  command: codex app-server    # ← 错误！应该是 claude
```

**必须改回**:
```yaml
codex:
  agent: "claude"
  command: claude
```

同时 WORKFLOW.md 的 diff 还加了 `team_key: "PRI"` 和改了 `project_slug`，这些 linear 配置改动需要保留（因为 "principles" 是 org-level project，需要 team_key 过滤）。

### 跑偏 2：AgentRunner 仍然硬编码使用 AppServer

`D:\Code\symphony-clean\elixir\lib\symphony_elixir\agent_runner.ex` 第 83 行：
```elixir
with {:ok, session} <- AppServer.start_session(workspace, worker_host: worker_host) do
```

**问题**：AgentRunner 直接调用 `AppServer`（codex app-server 的 JSON-RPC 客户端），完全绕过了已有的 `AcpxSession` 和 `AcpxCli` 模块。

**正确做法**：AgentRunner 应该根据 WORKFLOW.md 配置选择 ACPX 路径或 AppServer 路径。当 `codex.agent == "claude"` 时，走 AcpxSession；当 `codex.agent == "codex"` 时，走 AppServer。

### 跑偏 3：ShellResolution 被改成了 cmd /C

`shell_resolution.ex` 被改成 Windows 用 `cmd /C`，这是给 AppServer 用的（因为 codex app-server 需要 stdin 转发）。但如果走 ACPX 路径，AcpxSession 已经有自己的 Port.open 逻辑，不需要 ShellResolution。

**ShellResolution 的改动可能仍然需要**（用于 workspace hooks 的执行），但不应是 ACPX 启动路径的一部分。

## 已有的正确模块（不需要重写）

### AcpxCli (`elixir/lib/symphony_elixir/agent_runner/acpx_cli.ex`)

已实现 ACPX 执行策略解析：
- `{:direct, executable}` - POSIX 直接执行 acpx
- `{:node_js, node_path, js_path}` - Windows 通过 node 执行 acpx JS

**问题**：用户要求优先直接执行 `acpx` 命令，但当前 AcpxCli 在 Windows 上会跳过直接执行（因为 acpx 在 Windows 上是 .cmd shim），直接走 node+js 路径。

**需要修正**：在 Windows 上，`acpx` .cmd shim 可以通过 `cmd /C acpx` 执行。AcpxCli 应该尝试：
1. `ACPX_COMMAND` env var
2. 直接 `acpx`（通过 cmd /C 包装，或 System.cmd 调用）
3. `node + acpx/dist/cli.js` 作为 fallback

### AcpxSession (`elixir/lib/symphony_elixir/agent_runner/acpx_session.ex`)

已实现完整的 ACPX session 生命周期：
- `sessions_ensure` → `acpx --format json --json-strict --cwd <ws> --approve-all claude sessions ensure --name <name>`
- `prompt` → `acpx ... claude prompt -s <session> -f <prompt-file>`
- `sessions_close`
- 事件解析和适配

**这个模块是正确的，只需要被 AgentRunner 调用。**

### AcpxRunner (`elixir/lib/symphony_elixir/agent_runner/acpx_runner.ex`)

辅助模块，构建 acpx 命令参数。

## 需要做的事情（按优先级）

### Step 1: 修正 WORKFLOW.md

```yaml
codex:
  agent: "claude"
  command: claude
```

保留 `team_key: "PRI"` 和 `project_slug` 的修正。

### Step 2: 修正 AgentRunner，根据配置选择 ACPX vs AppServer

`agent_runner.ex` 的 `run_codex_turns/5` 需要分支：

```elixir
defp run_codex_turns(workspace, issue, codex_update_recipient, opts, worker_host) do
  agent = Config.settings!().codex.agent

  if agent == "claude" do
    run_acpx_turns(workspace, issue, codex_update_recipient, opts)
  else
    run_app_server_turns(workspace, issue, codex_update_recipient, opts, worker_host)
  end
end
```

`run_acpx_turns` 使用 AcpxSession：
1. `AcpxSession.start_link(agent: "claude", cwd: workspace, recipient: recipient, issue_id: issue.id)`
2. `AcpxSession.sessions_ensure(pid, session_name, workspace, approve_all: true)`
3. `AcpxSession.prompt(pid, prompt_text, ...)`
4. `AcpxSession.sessions_close(pid)`

### Step 3: 修正 AcpxCli，Windows 上优先尝试直接执行 acpx

当前逻辑在 Windows 上直接跳过 `acpx`（因为是 .cmd shim），改为：
1. 尝试 `System.cmd("acpx", ["--version"])` — 如果成功，说明 acpx 在 PATH 中可用
2. 如果失败，fallback 到 node+js 路径

或者更简单：在 Windows 上用 `cmd /C acpx` 包装执行。

### Step 4: 清理 symphony-clean 的无关改动

**必须回退的**：
- `linear/client.ex` 的 team_key 改动 — 这个是必要的（org-level project 需要 team_key 过滤），但需要确认是否属于本任务范围。用户说"除非能证明是必要修复"。**它是必要的**，因为不修改 client.ex，Symphony 无法发现 "principles" project 的 issues。
- `config/schema.ex` 和 `config.ex` 的 team_key 改动 — 同上，是 team_key 功能的必要部分。
- `core_test.exs` 的改动 — 配套 team_key 的测试更新。

**必须删除的**：
- `elixir/test_acpx_1.exs` — 临时 smoke 文件

**ShellResolution 改动**：
- `cmd /C` 改动对 workspace hooks 执行有用（after_create hook 在 Windows 上需要 cmd /C 来执行 `git clone ... && npm install`），应该保留。
- 但需要确认 AcpxSession 不依赖 ShellResolution（它不依赖，它有自己的 Port.open 逻辑）。

### Step 5: 验证 ACPX CLI 可用

```bash
acpx --version
# 0.7.0 (已确认可用)

acpx --format json --json-strict --cwd D:\Code\principles --approve-all claude sessions ensure --name symphony-smoke-direct

# 创建 prompt 文件后：
acpx --format json --json-strict --cwd D:\Code\principles --approve-all --suppress-reads --timeout 60 claude prompt -s symphony-smoke-direct -f <prompt-file>
```

### Step 6: 最终 smoke — 启动 Symphony

```bash
# 环境变量
$env:LINEAR_API_KEY = "..."
$env:SYMPHONY_WORKFLOW = "D:\Code\principles\WORKFLOW.md"

# Elixir 路径
$elixirPath = "C:\Users\Administrator\AppData\Local\mise\installs\elixir\1.19.5-otp-28\bin"
$otpPath = "C:\Users\Administrator\AppData\Local\mise\installs\erlang\28\bin"
$env:PATH = "$elixirPath;$otpPath;$env:PATH"

cd D:\Code\symphony-clean\elixir
mix run start.exs
```

## 干净 Diff 清单

### Root repo (D:\Code\principles)

| 文件 | 改动 | 理由 |
|------|------|------|
| `WORKFLOW.md` | 添加 `team_key: "PRI"`, 修正 `project_slug`, 确保 `codex.command: claude` | team_key 是发现 org-level project issues 的必要配置；command 必须是 claude 不是 codex app-server |

### Symphony repo (D:\Code\symphony-clean)

| 文件 | 改动 | 理由 |
|------|------|------|
| `lib/symphony_elixir/agent_runner.ex` | 添加 ACPX 路径分支（当 agent=="claude" 时走 AcpxSession） | 核心功能：让 Symphony 能通过 ACPX 启动 Claude Code |
| `lib/symphony_elixir/agent_runner/acpx_cli.ex` | 修正 Windows 策略：优先尝试直接执行 acpx | 用户要求：优先直接执行终端里的 acpx 命令 |
| `lib/symphony_elixir/shell_resolution.ex` | Windows 改用 `cmd /C`（用 System.find_executable 获取完整路径） | workspace hooks 在 Windows 上需要 cmd /C 执行 |
| `lib/symphony_elixir/config/schema.ex` | 添加 `team_key` 字段 | org-level project 需要 team_key 过滤 |
| `lib/symphony_elixir/config.ex` | 验证逻辑接受 team_key 或 project_slug | 配套 schema 改动 |
| `lib/symphony_elixir/linear/client.ex` | 添加 team_key 查询路径 | org-level project 的 issues 无法通过 project.slugId 过滤 |
| `test/symphony_elixir/shell_resolution_test.exs` | 更新测试匹配 cmd /C | 配套 ShellResolution 改动 |
| `test/symphony_elixir/core_test.exs` | 更新错误 atom | 配套 config 验证改动 |

**删除**：
- `elixir/test_acpx_1.exs` — 临时文件

## 环境信息

- **OS**: Windows
- **Elixir**: 1.19.5-otp-28 (via mise, path: `C:\Users\Administrator\AppData\Local\mise\installs\elixir\1.19.5-otp-28\bin`)
- **Erlang**: OTP 28 (path: `C:\Users\Administrator\AppData\Local\mise\installs\erlang\28\bin`)
- **ACPX**: 0.7.0 (全局安装, `C:\Users\Administrator\AppData\Roaming\npm\acpx.cmd`)
- **Codex CLI**: 0.130.0 (全局安装)
- **LINEAR_API_KEY**: 在环境变量中可用 (48 chars)
- **Workspace root**: `D:\Code\principles-workspaces`
- **Linear project**: "principles" (org-level, slugId: `d4d597b84d4d`, team_key: `PRI`)
- **测试 issue**: PRI-127 "写一个贪吃蛇的网页小游戏"

## 已知的 Windows 特有问题

1. **8.3 短路径名**: `C:\Users\ADMINI~1\` vs `C:\Users\Administrator\`，导致 PathSafety canonicalize 不匹配。64 个测试失败都源于此。
2. **CRLF 换行**: hook 输出包含 `\r\n`，测试期望 `\n`
3. **Symlink 权限**: `File.ln_s!` 在 Windows 上需要 SeCreateSymbolicLinkPrivilege
4. **`cp` 命令不存在**: Windows 上应该用 `copy`，测试用 `cp` 作为 hook 命令
5. **Erlang Port.open**: 不能直接执行 .cmd/.bat 文件，需要完整路径或 cmd /C 包装

## 推荐的下一步 Agent 技能

- **codex** (consult 模式) — 让 Codex 审查 AgentRunner 的 ACPX 集成方案
- **diagnose** — 如果 ACPX smoke test 失败，用诊断循环排查

## 关键文件路径

- AgentRunner: `D:\Code\symphony-clean\elixir\lib\symphony_elixir\agent_runner.ex`
- AcpxCli: `D:\Code\symphony-clean\elixir\lib\symphony_elixir\agent_runner\acpx_cli.ex`
- AcpxSession: `D:\Code\symphony-clean\elixir\lib\symphony_elixir\agent_runner\acpx_session.ex`
- AppServer: `D:\Code\symphony-clean\elixir\lib\symphony_elixir\codex\app_server.ex`
- ShellResolution: `D:\Code\symphony-clean\elixir\lib\symphony_elixir\shell_resolution.ex`
- Config: `D:\Code\symphony-clean\elixir\lib\symphony_elixir\config.ex`
- Schema: `D:\Code\symphony-clean\elixir\lib\symphony_elixir\config\schema.ex`
- Linear Client: `D:\Code\symphony-clean\elixir\lib\symphony_elixir\linear\client.ex`
- WORKFLOW: `D:\Code\principles\WORKFLOW.md`
- start.exs: `D:\Code\symphony-clean\elixir\start.exs`
