> **官方文档快照 · CodeBuddy Plugin Reference**

> **来源**：https://www.workbuddy.ai/docs/cli/plugins-reference
> **抓取日期**：2026-10-12（文档站构建 commit `4a4c8c2c72d`，文档 lastUpdated 2026-09-17）
> **性质**：官方文档快照，由 SSG HTML 自动转换为 Markdown，可能有少量格式损耗；内容以官方站为准。
> **注意**：canonical 指向 codebuddy.ai（CodeBuddy CLI 文档），WorkBuddy 桌面版与其共用引擎（取证时（桌面版 5.3.14）引擎文件为 `cli/dist/codebuddy.js`；本机 2026-10-11 已升级桌面版 5.8.1，引擎文件变为 `cli/dist/codebuddy-lite-wb.mjs`——复核时先 `ls` 引擎目录，勿照搬旧路径）；中文站 workbuddy.cn/docs/ide/Features/Hooks 是旧版（7 事件、仅 command 类型），勿混用。

---

# CodeBuddy Plugin Reference

> A complete technical reference for the CodeBuddy plugin system, covering component specifications, CLI commands, and development tools.

A **plugin** is a self-contained component directory that extends CodeBuddy with custom functionality. Plugin components include Skills, Agents, Hooks, MCP servers, and LSP servers.

---

## I. Plugin Component Reference

Markdown files for plugin skills and agents support LF and Windows CRLF line endings, as well as UTF-8 BOM headers. YAML frontmatter must begin at the start of the file and be enclosed by `---` delimiters on their own lines; the document body follows the closing delimiter.

### 1. Skills

Plugins extend CodeBuddy by adding skills, creating `/name` shortcuts that can be invoked by users or the AI assistant.

**Location**: The `skills/` or `commands/` directory under the plugin root.

**File format**: A skill is a directory containing a `SKILL.md`; a command is a plain Markdown file.

**Directory structure**:

```
skills/
├── pdf-processor/
│   ├── SKILL.md
│   ├── reference.md (optional)
│   └── scripts/ (optional)
└── code-reviewer/
    └── SKILL.md
```

**Integration behavior**:

- Skills and commands are discovered automatically when the plugin is installed.
- The AI assistant can invoke them automatically based on task context.
- Skills may include supporting files and scripts.

See [Skills](https://www.workbuddy.ai/docs/cli/skills) for details.

### 2. Agents

Plugins can provide specialized sub-agents for specific tasks, which the AI assistant can invoke automatically when appropriate.

**Location**: The `agents/` directory under the plugin root.

**Format**: Markdown files describing the agent's capabilities.

**Frontmatter configuration**:

```markdown
---
name: agent-name
description: The agent's expertise and when to invoke it
model: sonnet
effort: medium
maxTurns: 20
disallowedTools: Write, Edit
---

Detailed system prompt for the agent, describing its role, expertise, and behavior.
```

Plugin agents support the following frontmatter fields: `name`, `description`, `model`, `effort`, `maxTurns`, `tools`, `disallowedTools`, `skills`, `memory`, `background`, and `isolation`. The only valid value for `isolation` is `"worktree"`. For security reasons, plugin agents do not support the `hooks`, `mcpServers`, or `permissionMode` fields.

**Integration**:

- Agents appear in the `/agents` UI.
- The AI assistant can auto-invoke agents based on task context.
- Users can also invoke agents manually.
- Plugin agents cooperate with built-in agents.

See [Subagents](https://www.workbuddy.ai/docs/cli/sub-agents) for details.

### 3. Hooks

Plugins can provide event handlers that respond to CodeBuddy events automatically.

**Location**: `hooks/hooks.json` under the plugin root, or inline configuration in `plugin.json`.

**Format**: JSON configuration containing event matchers and actions.

**Configuration example**:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "${CODEBUDDY_PLUGIN_ROOT}/scripts/format-code.sh"
          }
        ]
      }
    ]
  }
}
```

**Available events**:

Plugin hooks respond to the same lifecycle events as user-defined hooks:

| Event | Trigger |
| --- | --- |
| `SessionStart` | Session starts or resumes |
| `UserPromptSubmit` | User submits a prompt, before AI processing |
| `PreToolUse` | Before tool execution; can block |
| `PermissionRequest` | When the permission dialog appears |
| `PermissionDenied` | When a tool call is denied by the auto-mode classifier. Return `{retry: true}` to tell the model it can retry |
| `PostToolUse` | After a tool call succeeds |
| `PostToolUseFailure` | After a tool call fails |
| `Notification` | When CodeBuddy sends a notification |
| `SubagentStart` | When a sub-agent starts |
| `SubagentStop` | When a sub-agent finishes |
| `TaskCreated` | When a task is created via `TaskCreate` |
| `TaskCompleted` | When a task is marked completed |
| `Stop` | When the AI finishes its response |
| `StopFailure` | When the turn ends due to an API error. Output and exit code are ignored |
| `TeammateIdle` | When a teammate is about to go idle |
| `InstructionsLoaded` | When CODEBUDDY.md or `.codebuddy/rules/*.md` files are loaded into context |
| `ConfigChange` | When a configuration file changes during the session |
| `CwdChanged` | When the working directory changes (e.g., the AI runs `cd`) |
| `FileChanged` | When a watched file changes on disk. The `matcher` field specifies the filename to watch |
| `WorktreeCreate` | When a worktree is created via `--worktree` or `isolation: "worktree"` |
| `WorktreeRemove` | When a worktree is removed (session exit or sub-agent completion) |
| `PreCompact` | Before context compaction |
| `PostCompact` | After context compaction completes |
| `Elicitation` | When an MCP server requests user input during a tool call |
| `ElicitationResult` | After the user responds to an MCP elicitation, before the response is sent back to the server |
| `SessionEnd` | When the session terminates |

**Hook types**:

- `command`: Executes a shell command or script.
- `http`: Sends the event JSON as a POST request to a URL.
- `prompt`: Uses an LLM to evaluate a prompt (use the `$ARGUMENTS` placeholder for context).
- `agent`: Runs an agent validator with tools, for complex validation tasks.

**Differences from Skill / Agent frontmatter hooks**:

A plugin can carry hooks via two distinct paths:

| Path | Scope | Safety gate |
| --- | --- | --- |
| `hooks/hooks.json` (described in this section) | Entire session (while the plugin is enabled) | Not subject to `allowUntrustedFrontmatterHooks`; takes effect as soon as the plugin is enabled |
| `hooks` frontmatter in `agents/*.md` or `skills/SKILL.md` | Only within that subagent / fork skill lifecycle | Subject to the `allowUntrustedFrontmatterHooks` gate, denied by default; users must explicitly enable it in `settings.json` |

Because frontmatter hooks are intercepted by the safety gate, plugin-distributed Skills / Agents that rely on frontmatter hooks to function correctly should clearly notify users in the plugin README to enable the `allowUntrustedFrontmatterHooks` setting. See [Hook Reference Guide - Frontmatter Hooks](https://www.workbuddy.ai/docs/cli/hooks#agent-skill-frontmatter-hooks) for details.

### 4. MCP Servers

Plugins can bundle Model Context Protocol (MCP) servers to connect CodeBuddy with external tools and services.

**Location**: `.mcp.json` under the plugin root, or inline configuration in `plugin.json`.

**Format**: Standard MCP server configuration.

**Configuration example**:

```json
{
  "mcpServers": {
    "plugin-database": {
      "command": "${CODEBUDDY_PLUGIN_ROOT}/servers/db-server",
      "args": ["--config", "${CODEBUDDY_PLUGIN_ROOT}/config.json"],
      "env": {
        "DB_PATH": "${CODEBUDDY_PLUGIN_ROOT}/data"
      }
    },
    "plugin-api-client": {
      "command": "npx",
      "args": ["@company/mcp-server", "--plugin-mode"],
      "cwd": "${CODEBUDDY_PLUGIN_ROOT}"
    }
  }
}
```

**Integration behavior**:

- MCP servers start automatically when the plugin is enabled.
- Servers appear as standard MCP tools in the toolkit.
- Server functionality integrates seamlessly with existing tools.
- Plugin servers can be configured independently of user-level MCP servers.

### 5. LSP Servers

> **Tip**: Need an LSP plugin? You can install one from the official marketplace — search for "lsp" in the `/plugin` Discover tab. This section covers how to create LSP plugins for languages not provided by the official marketplace.

Plugins can provide [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) (LSP) servers to give the AI assistant real-time code intelligence while working on a codebase.

LSP integration provides:

- **Instant diagnostics**: The AI assistant sees errors and warnings immediately after each edit.
- **Code navigation**: Go to definition, find references, and hover information.
- **Language awareness**: Type information and documentation for code symbols.

**Location**: An `.lsp.json` file under the plugin root, or inline configuration in `plugin.json`.

**Format**: JSON configuration mapping language server names to their configurations.

**`.lsp.json` file format**:

```json
{
  "go": {
    "command": "gopls",
    "args": ["serve"],
    "extensionToLanguage": {
      ".go": "go"
    }
  }
}
```

**Inline configuration in `plugin.json`**:

```json
{
  "name": "my-plugin",
  "lspServers": {
    "go": {
      "command": "gopls",
      "args": ["serve"],
      "extensionToLanguage": {
        ".go": "go"
      }
    }
  }
}
```

**Required fields**:

| Field | Description |
| --- | --- |
| `command` | LSP binary to execute (must be on PATH) |
| `extensionToLanguage` | Maps file extensions to language identifiers |

**Optional fields**:

| Field | Description |
| --- | --- |
| `args` | Command-line arguments for the LSP server |
| `transport` | Communication transport: `stdio` (default) or `socket` |
| `env` | Environment variables to set when starting the server |
| `initializationOptions` | Options passed to the server during initialization |
| `settings` | Settings passed via `workspace/didChangeConfiguration` |
| `workspaceFolder` | Workspace folder path for the server |
| `startupTimeout` | Maximum time (ms) to wait for server startup |
| `shutdownTimeout` | Maximum time (ms) to wait for graceful shutdown |
| `restartOnCrash` | Whether to automatically restart after a crash |
| `maxRestarts` | Maximum restart attempts before giving up |

> **Warning**: **You must install the language server binary separately.** LSP plugins configure how CodeBuddy connects to a language server but do not include the server itself. If you see an `Executable not found in $PATH` error in the `/plugin` Errors tab, install the binary for your language.

**Available LSP plugins**:

| Plugin | Language Server | Install Command |
| --- | --- | --- |
| `pyright-lsp` | Pyright (Python) | `pip install pyright` or `npm install -g pyright` |
| `typescript-lsp` | TypeScript Language Server | `npm install -g typescript-language-server typescript` |
| `rust-lsp` | rust-analyzer | [See rust-analyzer installation](https://rust-analyzer.github.io/manual.html#installation) |

Install the language server first, then install the plugin from the marketplace.

---

## II. Plugin Installation Scopes

When installing a plugin, choose a **scope** that determines where the plugin is available:

| Scope | Settings file | Use case |
| --- | --- | --- |
| `user` | `~/.codebuddy/settings.json` | Personal plugin, available in all projects (default) |
| `project` | `.codebuddy/settings.json` | Team plugin, shared via version control |
| `local` | `.codebuddy/settings.local.json` | Project-specific plugin, gitignored |
| `managed` | Managed settings | Managed plugins (read-only; updates only) |

Plugins use the same scoping system as other CodeBuddy configuration. See [Settings](https://www.workbuddy.ai/docs/cli/settings) for details.

---

## III. Plugin Manifest Schema (plugin.json)

The `.codebuddy-plugin/plugin.json` file (or `.workbuddy-plugin/plugin.json`, `.claude-plugin/plugin.json`) defines plugin metadata and configuration. This section documents all supported fields and options.

The manifest is optional. If omitted, CodeBuddy auto-discovers components in the [default locations](#file-location-reference) and derives the plugin name from the directory name. Use a manifest when you need to provide metadata or customize component paths.

### Complete Schema Example

```json
{
  "name": "plugin-name",
  "version": "1.2.0",
  "description": "Brief plugin description",
  "author": {
    "name": "Author name",
    "email": "[email protected]",
    "url": "https://github.com/author"
  },
  "homepage": "https://docs.example.com/plugin",
  "repository": "https://github.com/author/plugin",
  "license": "MIT",
  "keywords": ["keyword1", "keyword2"],
  "commands": ["./custom/commands/special.md"],
  "agents": "./custom/agents/",
  "skills": "./custom/skills/",
  "hooks": "./config/hooks.json",
  "mcpServers": "./mcp-config.json",
  "outputStyles": "./styles/",
  "lspServers": "./.lsp.json",
  "defaultEnabled": false,
  "dependencies": [
    "audit-logger",
    { "name": "secrets-vault", "version": "~2.1.0" }
  ],
  "experimental": {
    "themes": "./themes/",
    "monitors": "./monitors/monitors.json"
  }
}
```

### Required Fields

If a manifest is included, `name` is the only required field.

| Field | Type | Description | Example |
| --- | --- | --- | --- |
| `name` | string | Unique identifier (kebab-case, no spaces) | `"deployment-tools"` |

This name is used for component namespacing. For example, in the UI, the agent `agent-creator` from plugin `plugin-dev` will appear as `plugin-dev:agent-creator`.

### Metadata Fields

| Field | Type | Description | Example |
| --- | --- | --- | --- |
| `version` | string | Semantic version. If set in both the marketplace entry and `plugin.json`, `plugin.json` wins. Set in only one place. | `"2.1.0"` |
| `description` | string | Short description of the plugin's purpose | `"Deployment automation tools"` |
| `author` | object | Author information | `{"name": "Dev Team", "email": "[email protected]"}` |
| `homepage` | string | Documentation URL | `"https://docs.example.com"` |
| `repository` | string | Source code URL | `"https://github.com/user/plugin"` |
| `license` | string | License identifier | `"MIT"`, `"Apache-2.0"` |
| `keywords` | array | Discovery tags | `["deployment", "ci-cd"]` |
| `defaultEnabled` | boolean | Whether the plugin is enabled when no explicit setting exists, default `true` | `false` |
| `dependencies` | array | Other plugins that this plugin depends on; can declare semver ranges and marketplace | `[{"name":"helper","version":"^2.0.0"}]` |

### Component Path Fields

| Field | Type | Description | Example |
| --- | --- | --- | --- |
| `commands` | string | array | Custom command file/directory (replaces default `commands/`) | `"./custom/cmd.md"` or `["./cmd1.md"]` |
| `agents` | string | array | Custom agent files (replaces default `agents/`) | `"./custom/agents/reviewer.md"` |
| `skills` | string | array | Custom skill directories (replaces default `skills/`) | `"./custom/skills/"` |
| `hooks` | string | array | object | Hook configuration path or inline configuration | `"./my-extra-hooks.json"` |
| `mcpServers` | string | array | object | MCP configuration path or inline configuration | `"./my-extra-mcp-config.json"` |
| `outputStyles` | string | array | Custom output style files/directories (replaces default `output-styles/`) | `"./styles/"` |
| `experimental.themes` | string | array | Claude experimental field; CodeBuddy currently recognizes but does not load into runtime | `"./themes/"` |
| `experimental.monitors` | string | array | Claude experimental field; CodeBuddy currently recognizes but does not start background monitors | `"./monitors/monitors.json"` |
| `lspServers` | string | array | object | LSP configuration path or inline configuration | `"./.lsp.json"` |
| `userConfig` | object | Values CodeBuddy prompts the user to provide when enabling the plugin. See [User Configuration](#user-configuration) | See below |
| `channels` | array | Channel declarations for message injection. See [Channels](#channels) | See below |

### Default Enabled

`defaultEnabled: false` keeps a newly installed plugin disabled. Existing `enabledPlugins` settings take priority over this default, so upgrading or reinstalling does not change the state the user has already explicitly chosen. If a plugin is a dependency of an enabled plugin, the dependency takes precedence and CodeBuddy explicitly enables it.

### Plugin Dependencies

`dependencies` can be declared in both `plugin.json` and the marketplace plugin entry; the two declarations are merged. String dependencies resolve to the marketplace where the declarant resides; objects support the following fields:

| Field | Required | Description |
| --- | --- | --- |
| `name` | Yes | Plugin name |
| `version` | No | Node semver range, e.g., `~2.1.0`, `^2.0`, `>=1.4` |
| `marketplace` | No | The marketplace where the dependency resides; defaults to the declarant's marketplace when omitted |

Cross-marketplace auto-installation is blocked by default. It requires explicit authorization in the root plugin's marketplace's `marketplace.json`:

```json
{
  "name": "acme-tools",
  "allowCrossMarketplaceDependenciesOn": ["acme-shared"],
  "plugins": []
}
```

Only the root marketplace's allowlist takes effect; trust is not transitive. Cross-marketplace dependencies that the user has already manually installed and whose versions satisfy the requirements can be reused directly.

Version constraints are resolved via Git tags. Publishers use the `{plugin-name}--v{version}` tag naming convention, e.g., `secrets-vault--v2.1.3`. CodeBuddy merges the ranges from all enabled plugins for the same dependency and selects the highest version that satisfies the intersection. The tag semver is recorded in `resolvedVersion`; the cache directory uses the declared version plus a 12-character commit SHA suffix, preventing force-moved tags from reusing stale content.

Installing a plugin automatically installs the full transitive dependency chain. Enabling a plugin only transitively enables already-installed dependencies; enabling fails when a dependency is missing. Disabling or uninstalling a plugin that is still depended on by enabled plugins is blocked.

Auto-installed dependencies are marked with `auto: true` in `installed_plugins.json`. Normal uninstallation preserves these dependencies; use `plugin prune` or `plugin uninstall --prune` to clean up auto dependencies no longer needed by any manually installed plugin. Explicitly installing an auto dependency promotes it to a manual installation, after which it will not be pruned.

### User Configuration

The `userConfig` field declares values that CodeBuddy prompts the user to provide when the plugin is enabled. Use this instead of asking users to edit `settings.json` manually.

```json
{
  "userConfig": {
    "api_endpoint": {
      "description": "Your team's API endpoint",
      "sensitive": false
    },
    "api_token": {
      "description": "API authentication token",
      "sensitive": true
    }
  }
}
```

Keys must be valid identifiers. Each value can be substituted as `${user_config.KEY}` in MCP and LSP server configs and hook commands, and (for non-sensitive values only) inside skill, command, and agent content. Values are also exported as `CLAUDE_PLUGIN_OPTION_<KEY>` and `CODEBUDDY_PLUGIN_OPTION_<KEY>` environment variables to plugin child processes. Non-alphanumeric, non-underscore characters in environment variable names are replaced with `_` and then uppercased.

Non-sensitive values are stored in `pluginConfigs[<plugin-id>].options` in `settings.json`. Sensitive values are stored in the system keychain (or in `~/.codebuddy/.credentials.json` if the keychain is unavailable). Keychain storage is shared with OAuth tokens and has a total limit of around 2 KB, so sensitive values should be kept small.

### Channels

The `channels` field lets a plugin declare one or more message channels used to inject content into the conversation. Each channel binds to an MCP server provided by the plugin.

```json
{
  "channels": [
    {
      "server": "telegram",
      "userConfig": {
        "bot_token": { "description": "Telegram bot token", "sensitive": true },
        "owner_id": { "description": "Your Telegram user ID", "sensitive": false }
      }
    }
  ]
}
```

The `server` field is required and must match a key in the plugin's `mcpServers`. The optional per-channel `userConfig` uses the same schema as the top-level one, letting you prompt for a bot token or owner ID when the plugin is enabled.

### Path Behavior Rules

For `commands`, `agents`, `skills`, and `outputStyles`, a custom path **replaces** the default directory. If the manifest specifies `commands`, the default `commands/` directory is not scanned. Hooks, MCP servers, and LSP servers have different semantics for handling multiple sources.

- All paths must be relative to the plugin root and start with `./`.
- Components under custom paths follow the same naming and namespacing rules.
- Multiple paths can be specified as an array.
- To keep the default directory and add more paths, include the default in the array: `"commands": ["./commands/", "./extras/deploy.md"]`.

**Path examples**:

```json
{
  "commands": [
    "./specialized/deploy.md",
    "./utilities/batch-process.md"
  ],
  "agents": [
    "./custom-agents/reviewer.md",
    "./custom-agents/tester.md"
  ]
}
```

### Environment Variables

CodeBuddy provides three Claude Code-compatible path variables. They are substituted inline in skill, command, and agent content, hook configurations, and MCP or LSP server configurations, and are also exported as environment variables to hook, MCP, and LSP child processes. Each `CLAUDE_*` name has a corresponding `CODEBUDDY_*` alias.

**`${CODEBUDDY_PLUGIN_ROOT}`**: Absolute path to the plugin installation directory. Use it to reference scripts, binaries, and configuration files bundled with the plugin. This path changes when the plugin is updated, so files written here do not persist across updates.

**Compatibility**: The `${CLAUDE_PLUGIN_ROOT}` variable name is also supported for compatibility with Claude Code plugins.

**`${CODEBUDDY_PLUGIN_DATA}`**: A persistent directory for plugin state that survives updates. Use it for installed dependencies (such as `node_modules` or Python virtual environments), generated code, caches, and any files that need to persist across plugin versions. The directory is created automatically when first referenced by a placeholder or exported to a plugin child process.

**Compatibility**: The `${CLAUDE_PLUGIN_DATA}` variable name is also supported.

**`${CODEBUDDY_PROJECT_DIR}`**: The current workspace root directory. Used by plugin scripts to locate the user's project; should not be used to write the plugin's own persistent state.

**Compatibility**: The `${CLAUDE_PROJECT_DIR}` variable name is also supported.

Plugin child processes also receive the following option environment variables:

- `CLAUDE_PLUGIN_OPTION_<KEY>`: Claude Code standard name
- `CODEBUDDY_PLUGIN_OPTION_<KEY>`: CodeBuddy alias
- `PLUGIN_OPT_<KEY>`: Reserved compatibility name for existing CodeBuddy plugins

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CODEBUDDY_PLUGIN_ROOT}/scripts/process.sh"
          }
        ]
      }
    ]
  }
}
```

#### Persistent Data Directory

The `${CODEBUDDY_PLUGIN_DATA}` directory resolves to `~/.codebuddy/plugins/data/{id}/`, where `{id}` is the plugin identifier with characters outside `a-z`, `A-Z`, `0-9`, `_`, and `-` replaced by `-`. For example, a plugin installed as `formatter@my-marketplace` uses the directory `~/.codebuddy/plugins/data/formatter-my-marketplace/`.

A common use is to install language dependencies once and reuse them across sessions and plugin updates. Because the data directory's lifetime outlasts any single plugin version, simply checking for directory existence does not detect when an update has changed the plugin's dependency manifest. The recommended pattern is to compare the bundled manifest with a copy in the data directory and reinstall when they differ.

The following `SessionStart` hook installs `node_modules` on first run, and reinstalls them whenever a plugin update includes a changed `package.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "diff -q \"${CODEBUDDY_PLUGIN_ROOT}/package.json\" \"${CODEBUDDY_PLUGIN_DATA}/package.json\" >/dev/null 2>&1 || (cd \"${CODEBUDDY_PLUGIN_DATA}\" && cp \"${CODEBUDDY_PLUGIN_ROOT}/package.json\" . && npm install) || rm -f \"${CODEBUDDY_PLUGIN_DATA}/package.json\""
          }
        ]
      }
    ]
  }
}
```

`diff` exits non-zero whenever the stored copy is missing or differs from the bundled copy, covering both the first run and dependency-changing updates. If `npm install` fails, the trailing `rm` removes the copied manifest so the next session retries.

Scripts bundled under `${CODEBUDDY_PLUGIN_ROOT}` can run against the persisted `node_modules`:

```json
{
  "mcpServers": {
    "routines": {
      "command": "node",
      "args": ["${CODEBUDDY_PLUGIN_ROOT}/server.js"],
      "env": {
        "NODE_PATH": "${CODEBUDDY_PLUGIN_DATA}/node_modules"
      }
    }
  }
}
```

When a plugin is uninstalled from its last remaining installation scope, the data directory is automatically deleted; if the same plugin is still installed in other scopes, it is preserved. The CLI deletes it by default; pass `--keep-data` to retain it. `plugin prune` deletes the data directories of orphaned auto dependencies.

---

## IV. Plugin Cache and File Resolution

Plugins can be specified in two ways:

- Via `codebuddy --plugin-dir`, valid for the current session only.
- Via marketplace installation, valid for future sessions.

For security and validation, CodeBuddy copies **marketplace** plugins to the user's local **versioned plugin cache** (`~/.codebuddy/plugins/cache/<marketplace>/<plugin>/<version>`) rather than using them in place. The marketplace source code is still stored in `~/.codebuddy/plugins/marketplaces/<marketplace>`. Understanding this behavior is important when developing plugins that reference external files.

### Path Traversal Restrictions

Installed plugins cannot reference files outside their own directory. Paths that traverse outside the plugin root (like `../shared-utils`) do not work after installation because those external files are not copied into the cache.

### Using External Dependencies

If a plugin needs access to shared files within the same marketplace, you can create symlinks inside the plugin directory. Symlinks are processed by target location during cache copying:

- Pointing inside the plugin's own directory: preserved as relative symlinks.
- Pointing to other locations within the same marketplace: dereferenced and the target content is copied.
- Pointing outside the marketplace: the symlink is skipped.

```bash
# Inside the plugin directory
ln -s ../../shared-plugin/skills/foo ./skills/foo
```

This allows sharing files within a marketplace while preventing plugins from bringing arbitrary host files into the cache.

---

## V. Plugin Directory Structure

### Standard Plugin Layout

A complete plugin follows this structure:

```
enterprise-plugin/
├── .codebuddy-plugin/        # Metadata directory (optional)
│   └── plugin.json             # Plugin manifest
├── commands/                 # Default commands location
│   ├── status.md
│   └── logs.md
├── agents/                   # Default agents location
│   ├── security-reviewer.md
│   ├── performance-tester.md
│   └── compliance-checker.md
├── skills/                   # Agent skills
│   ├── code-reviewer/
│   │   └── SKILL.md
│   └── pdf-processor/
│       ├── SKILL.md
│       └── scripts/
├── output-styles/            # Output style definitions
│   └── terse.md
├── themes/                   # Claude standard theme definitions; currently recognized but not loaded
│   └── dracula.json
├── monitors/                 # Claude standard background monitor; currently recognized but not started
│   └── monitors.json
├── hooks/                    # Hook configuration
│   ├── hooks.json            # Primary hook configuration
│   └── security-hooks.json   # Additional hooks
├── bin/                      # Plugin executables, added to PATH
│   └── my-tool               # Callable as a bare command in the Bash tool
├── settings.json             # Plugin default settings
├── .mcp.json                 # MCP server definitions
├── .lsp.json                 # LSP server configuration
├── scripts/                  # Hook and utility scripts
│   ├── security-scan.sh
│   ├── format-code.py
│   └── deploy.js
├── LICENSE                   # License file
└── CHANGELOG.md              # Version history
```

> **Important**: The `.codebuddy-plugin/` directory contains the `plugin.json` file. All other directories (`commands/`, `agents/`, `skills/`, `output-styles/`, `themes/`, `monitors/`, `hooks/`) must live at the plugin root, not inside `.codebuddy-plugin/`. The `.workbuddy-plugin/` and `.claude-plugin/` directories are also supported for compatibility.

### File Location Reference

| Component | Default location | Purpose |
| --- | --- | --- |
| **Manifest** | `.codebuddy-plugin/plugin.json` | Plugin metadata and configuration (optional) |
| **Commands** | `commands/` | Skill Markdown files (legacy; new skills use `skills/`) |
| **Agents** | `agents/` | Sub-agent Markdown files |
| **Skills** | `skills/` | Skills following the `<name>/SKILL.md` structure |
| **Output styles** | `output-styles/` | Output style definitions |
| **Themes** | `themes/` | Claude standard field; CodeBuddy currently recognizes but does not load into runtime |
| **Monitors** | `monitors/monitors.json` | Claude standard field; CodeBuddy currently recognizes but does not start background monitors |
| **Hooks** | `hooks/hooks.json` | Hook configuration |
| **MCP servers** | `.mcp.json` | MCP server definitions |
| **LSP servers** | `.lsp.json` | Language server configuration |
| **Executables** | `bin/` | Executables added to the Bash tool PATH. When the plugin is enabled, files in this directory can be invoked as bare commands in any Bash tool call |
| **Settings** | `settings.json` | Plugin default configuration. Currently the runtime applies `agent`; `subagentStatusLine` is recognized and preserved |

---

## VI. CLI Command Reference

CodeBuddy provides CLI commands for non-interactive plugin management, suitable for scripting and automation.

### plugin install

Install a plugin from an available marketplace.

```bash
codebuddy plugin install <plugin> [options]
```

**Arguments**:

- `<plugin>`: Plugin name, or `plugin-name@marketplace-name` to specify a particular marketplace.

**Options**:

| Option | Description | Default |
| --- | --- | --- |
| `-s, --scope <scope>` | Install scope: `user`, `project`, or `local` | `user` |
| `-h, --help` | Show command help |  |

The scope determines which settings file the installed plugin is added to. For example, `--scope project` writes to `enabledPlugins` in `.codebuddy/settings.json`, making the plugin available to everyone who clones the project repository.

**Examples**:

```bash
# Install at user scope (default)
codebuddy plugin install formatter@my-marketplace

# Install at project scope (shared with team)
codebuddy plugin install formatter@my-marketplace --scope project

# Install at local scope (gitignored)
codebuddy plugin install formatter@my-marketplace --scope local
```

### plugin uninstall

Remove an installed plugin.

```bash
codebuddy plugin uninstall <plugin> [options]
```

**Arguments**:

- `<plugin>`: Plugin name, or `plugin-name@marketplace-name`.

**Options**:

| Option | Description | Default |
| --- | --- | --- |
| `-s, --scope <scope>` | Uninstall from scope: `user`, `project`, or `local` | `user` |
| `--keep-data` | Preserve the plugin's [persistent data directory](#persistent-data-directory) |  |
| `--prune` | Also clean up auto dependencies no longer needed in this scope |  |
| `-y, --yes` | Skip `--prune` confirmation; required when stdin or stdout is not a TTY |  |
| `-h, --help` | Show command help |  |

**Aliases**: `remove`, `rm`

By default, uninstalling from the last remaining scope also deletes the plugin's `${CODEBUDDY_PLUGIN_DATA}` directory. Use `--keep-data` to preserve it — for example, when reinstalling after testing a new version.

### plugin prune

Clean up auto dependencies in the specified scope that are no longer depended on by any manually installed plugin.

```bash
codebuddy plugin prune [options]
```

| Option | Description | Default |
| --- | --- | --- |
| `-s, --scope <scope>` | Prune scope: `user`, `project`, or `local` | `user` |
| `--dry-run` | Only list plugins that would be pruned, without modifying settings and registry |  |
| `-y, --yes` | Skip confirmation; only lists candidates when stdin or stdout is not a TTY and this is not specified |  |
| `-h, --help` | Show command help |  |

### plugin enable

Enable a disabled plugin.

```bash
codebuddy plugin enable <plugin> [options]
```

**Arguments**:

- `<plugin>`: Plugin name, or `plugin-name@marketplace-name`.

**Options**:

| Option | Description | Default |
| --- | --- | --- |
| `-s, --scope <scope>` | Enable scope: `user`, `project`, or `local` | Auto-detect current installation scope |
| `-h, --help` | Show command help |  |

### plugin disable

Disable a plugin without uninstalling it.

```bash
codebuddy plugin disable <plugin> [options]
```

**Arguments**:

- `<plugin>`: Plugin name, or `plugin-name@marketplace-name`.

**Options**:

| Option | Description | Default |
| --- | --- | --- |
| `-s, --scope <scope>` | Disable scope: `user`, `project`, or `local` | Auto-detect current installation scope |
| `-h, --help` | Show command help |  |

### plugin update

Update a plugin to the latest version.

```bash
codebuddy plugin update <plugin> [options]
```

**Arguments**:

- `<plugin>`: Plugin name, or `plugin-name@marketplace-name`.

**Options**:

| Option | Description | Default |
| --- | --- | --- |
| `-s, --scope <scope>` | Update scope: `user`, `project`, `local`, or `managed` | `user` |
| `-h, --help` | Show command help |  |

### plugin list

List installed plugins and their versions, marketplace, enabled status, and dependency errors. `--json` can be used for scripts to read `dependencyErrors`.

```bash
codebuddy plugin list --json
```

### Marketplace Management

```bash
# Add a marketplace
codebuddy plugin marketplace add <source> [--name <name>]

# List marketplaces
codebuddy plugin marketplace list

# Update a marketplace
codebuddy plugin marketplace update <name>

# Remove a marketplace
codebuddy plugin marketplace remove <name>
```

**Marketplace source formats**:

```bash
# Local directory
codebuddy plugin marketplace add /path/to/marketplace

# GitHub shorthand
codebuddy plugin marketplace add owner/repo

# Git URL
codebuddy plugin marketplace add https://github.com/owner/repo.git

# HTTP URL (marketplace.json)
codebuddy plugin marketplace add https://example.com/marketplace.json
```

---

## VII. Debugging and Development Tools

### Debug Commands

Use `codebuddy --debug` to see plugin loading details:

**What it shows**:

- Which plugins are being loaded.
- Any errors in plugin manifests.
- Command, agent, and hook registration.
- MCP server initialization.

### Common Troubleshooting

| Issue | Cause | Solution |
| --- | --- | --- |
| Plugin not loaded | Invalid `plugin.json` | Run `codebuddy plugin validate` or `/plugin validate` to check `plugin.json`, skill/agent/command frontmatter, and `hooks/hooks.json` for syntax and schema errors |
| Command not appearing | Wrong directory structure | Ensure `commands/` is at the plugin root, not inside `.codebuddy-plugin/` |
| Hook not firing | Script not executable | Run `chmod +x script.sh` |
| MCP server fails | Missing `${CODEBUDDY_PLUGIN_ROOT}` | Use this variable for all plugin paths |
| Path errors | Using absolute paths | All paths must be relative and start with `./` |
| LSP `Executable not found in $PATH` | Language server not installed | Install the binary (e.g., `npm install -g typescript-language-server typescript`) |

### Common Error Messages

**Manifest validation errors**:

- `Invalid JSON syntax: Unexpected token } in JSON at position 142`: Check for missing commas, trailing commas, or unquoted strings.
- `Plugin has an invalid manifest file at .codebuddy-plugin/plugin.json. Validation errors: name: Required`: Missing required field.
- `Plugin has a corrupt manifest file at .codebuddy-plugin/plugin.json. JSON parse error: ...`: JSON syntax error.

**Plugin loading errors**:

- `Warning: No commands found in plugin my-plugin custom directory: ./cmds. Expected .md files or SKILL.md in subdirectories.`: The command path exists but contains no valid command files.
- `Plugin directory not found at path: ./plugins/my-plugin. Check that the marketplace entry has the correct path.`: The `source` path in `marketplace.json` points to a non-existent directory.
- `Plugin my-plugin has conflicting manifests: both plugin.json and marketplace entry specify components.`: Remove duplicate component definitions, or remove `strict: false` from the marketplace entry.

### Hook Troubleshooting

**Hook script not executing**:

1. Verify the script is executable: `chmod +x ./scripts/your-script.sh`.
2. Check the shebang line: the first line should be `#!/bin/bash` or `#!/usr/bin/env bash`.
3. Confirm the path uses `${CODEBUDDY_PLUGIN_ROOT}`: `"command": "${CODEBUDDY_PLUGIN_ROOT}/scripts/your-script.sh"`.
4. Test the script manually: `./scripts/your-script.sh`.

**Hook not firing on the expected event**:

1. Verify the event name (case-sensitive): `PostToolUse`, not `postToolUse`.
2. Check the matcher pattern matches the target tool: `"matcher": "Write|Edit"` for file operations.
3. Confirm the hook type is valid: `command`, `http`, `prompt`, or `agent`.

### MCP Server Troubleshooting

**Server does not start**:

1. Check that the command exists and is executable.
2. Verify all paths use the `${CODEBUDDY_PLUGIN_ROOT}` variable.
3. Check MCP server logs: `codebuddy --debug` shows initialization errors.
4. Test the server manually outside of CodeBuddy.

**Server tools do not appear**:

1. Ensure the server is correctly configured in `.mcp.json` or `plugin.json`.
2. Verify that the server correctly implements the MCP protocol.
3. Check for connection timeouts in the debug output.

### Directory Structure Errors

**Symptom**: The plugin loads but components (commands, agents, hooks) are missing.

**Correct structure**: Components must be at the plugin root, not inside `.codebuddy-plugin/`. Only `plugin.json` belongs in `.codebuddy-plugin/`.

```
my-plugin/
├── .codebuddy-plugin/
│   └── plugin.json      <- Only the manifest lives here
├── commands/             <- At root level
├── agents/               <- At root level
└── hooks/                <- At root level
```

If components are inside `.codebuddy-plugin/`, move them up to the plugin root.

**Debug checklist**:

1. Run `codebuddy --debug` and look for "loading plugin" messages.
2. Verify that each component directory is listed in the debug output.
3. Confirm that file permissions allow reading the plugin files.

---

## VIII. Version Management Reference

### Semantic Versioning

Follow semantic versioning for plugin releases:

```json
{
  "name": "my-plugin",
  "version": "2.1.0"
}
```

**Version format**: `MAJOR.MINOR.PATCH`

- **MAJOR**: Incompatible API changes.
- **MINOR**: Backwards-compatible feature additions.
- **PATCH**: Backwards-compatible bug fixes.

**Best practices**:

- Start the first stable release at `1.0.0`.
- Update the version in `plugin.json` before distributing changes.
- Record changes in a `CHANGELOG.md` file.
- Use pre-release versions (e.g., `2.0.0-beta.1`) for testing.

> **Note**: CodeBuddy uses the version to decide whether a plugin needs updating. If you change plugin code without bumping the version in `plugin.json`, existing users will not see the change due to caching.
>
> If the plugin is in a [marketplace](https://www.workbuddy.ai/docs/cli/plugin-marketplaces) directory, you can manage versions via `marketplace.json` and omit the `version` field from `plugin.json`.

### Versioned Cache

CodeBuddy calculates the cache key by the following priority:

1. `version` from `plugin.json`
2. `version` from the marketplace plugin entry
3. Commit SHA for Git sources; `git-subdir` also includes a subdirectory path hash
4. `unknown` when the version cannot be determined

Git plugins without an explicit version use the 12-character commit SHA as the cache directory name. When resolving tags via version constraints, the cache directory additionally includes a 12-character commit SHA suffix; constraint validation uses the separately recorded `resolvedVersion` and does not rely on the potentially stale manifest version.

Git marketplace plugins previously recorded as `unknown` are automatically migrated at startup: CodeBuddy resolves the commit SHA from the current marketplace checkout, materializes the source code into the corresponding SHA cache directory, and atomically updates `installed_plugins.json`. Old `unknown` directories are only marked as orphan; they are retained for at least 14 days, and are not deleted while they have the `.in_use` flag of an active session. Non-Git sources without an explicit version continue to use `unknown`.

---

## IX. Compatibility with Claude Code

The CodeBuddy plugin system is designed to be compatible with the Claude Code plugin specification, with the following differences:

### Naming Differences

| Concept | Claude Code | CodeBuddy |
| --- | --- | --- |
| Metadata directory | `.claude-plugin/` | `.codebuddy-plugin/` (priority), `.workbuddy-plugin/`, or `.claude-plugin/` (compatible) |
| Environment variable | `${CLAUDE_PLUGIN_ROOT}` | `${CODEBUDDY_PLUGIN_ROOT}` (priority) or `${CLAUDE_PLUGIN_ROOT}` (compatible) |
| Data directory variable | `${CLAUDE_PLUGIN_DATA}` | `${CODEBUDDY_PLUGIN_DATA}` (priority) or `${CLAUDE_PLUGIN_DATA}` (compatible) |

### Migration Guide

Migrating from Claude Code to CodeBuddy:

1. Optionally rename `.claude-plugin/` to `.codebuddy-plugin/`.
2. Optionally replace `${CLAUDE_PLUGIN_ROOT}` with `${CODEBUDDY_PLUGIN_ROOT}` in scripts.
3. Optionally replace `${CLAUDE_PLUGIN_DATA}` with `${CODEBUDDY_PLUGIN_DATA}`.

**Note**: Keeping the original names is fully compatible — CodeBuddy recognizes them automatically.

---

## Related Resources

- [Plugins](https://www.workbuddy.ai/docs/cli/plugins) – Tutorial and practical guide
- [Plugin Marketplaces](https://www.workbuddy.ai/docs/cli/plugin-marketplaces) – Creating and managing marketplaces
- [Skills](https://www.workbuddy.ai/docs/cli/skills) – Skill development details
- [Subagents](https://www.workbuddy.ai/docs/cli/sub-agents) – Agent configuration and capabilities
- [Hooks](https://www.workbuddy.ai/docs/cli/hooks) – Event handling and automation
- [MCP](https://www.workbuddy.ai/docs/cli/mcp) – External tool integration
- [Settings](https://www.workbuddy.ai/docs/cli/settings) – Plugin configuration options
