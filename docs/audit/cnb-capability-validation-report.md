# CNB 能力验证报告（Phase 1）

> 状态：验证完成，供 Owner 评审
> 方法：**只以 CNB 官方文档为准**，不假设 API 或配置（任务书 Phase 1 明确要求）
> 验证日期：2026-09-12
> 验证来源：见 §6 文档清单
> 相关：[CNB 环境兼容性报告](./cnb-environment-compatibility-report.md)

---

## 0. 结论摘要

任务书要求逐项确认的五项能力，**全部存在且可用**，但**两项需要修正理解**：

| # | 任务书要求确认的能力 | 验证结论 | 备注 |
|---|---|---|---|
| 1 | Workspace（云原生开发） | ✅ 支持 | 点击仓库分支页按钮一键创建；支持 WebIDE / VS Code / Cursor |
| 2 | Dockerfile 自定义开发环境 | ✅ 支持 | 仓库根 `.ide/Dockerfile`；另有 `.cnb.yml` 的 `docker.build` 显式声明方式 |
| 3 | VS Code / Web IDE | ✅ 支持 | WebIDE 内置；VS Code/Cursor 经 Remote-SSH（需镜像内含 `openssh-server`） |
| 4 | AI Agent 使用方式 | ✅ 支持 | **NPC** 机制 + 内置任务 `npc:go`；**默认只读** |
| 5 | 自动化任务方式 | ✅ 支持 | 事件触发 + 定时任务 + 手动/API 触发 + NPC 事件，共 5 类 |

**两项需修正的理解**：

- **M1**：任务书把 AI Agent 与自动化当成两个独立能力看待。CNB 的实际模型是**同一个机制**：NPC（Non-Player Character）既是"AI Agent 角色"，也是"自动化任务"的执行体。`npc:go` 可挂在**任意**事件的流水线上（不限于 `@` 评论）。
- **M2**：任务书假设可以"直接建立云端开发节点"。CNB 的**容量/权限主体是组织（organization）**，不存在个人仓库。接入是 Owner 侧动作（见兼容性报告 §5.4）。

---

## 1. Workspace（云原生开发）

**验证：支持。**

| 维度 | 官方事实 |
|---|---|
| 定位 | 基于云原生构建的远程开发方案 |
| 连接方式 | WebIDE、VS Code、Cursor 等客户端 |
| 声明式 | 基于 Docker 生态，**通过 Dockerfile 声明开发环境，与代码同源管理** |
| 启动 | 仓库分支页右上角「云原生开发」按钮，一键创建，**无需额外配置** |
| 资源 | 按需获取，闲置自动回收 |

**启动按钮可定制**（`.cnb/settings.yml`）：

```yaml
workspace:
  launch:
    button:
      name: 云原生启动
      description: 启动远程开发，快速体验云端环境
      cpus: 8
      disabled: false
      autoOpenWebIDE: false
```

**推论**：即使在完全没有任何 CNB 配置的仓库上，云原生开发也能一键启动（走默认流水线 + 默认镜像）。因此 Phase 3 的配置是**为 PD 定制**，而不是"让 workspace 能启动"的前提。

---

## 2. Dockerfile 自定义开发环境

**验证：支持，且有两种官方途径。**

### 途径 A：仓库根 `.ide/Dockerfile`（隐式，推荐）

官方表述：
> 如果通过指定镜像无法满足需求，可以自行编写 Dockerfile 来自定义开发环境。在仓库根目录下增加 `.ide/Dockerfile` 文件……**如果未自定义启动流水线，启动开发环境时使用默认流水线创建开发环境。默认流水线会优先使用 `.ide/Dockerfile` 构建一个镜像，作为开发环境基础镜像。**
> 注意：启动开发环境的默认流水线中，同时配置了默认镜像和 `.ide/Dockerfile`，如果 `.ide/Dockerfile` 不存在或**构建失败，会使用默认镜像**作为开发环境基础镜像。

### 途径 B：`.cnb.yml` 的 `vscode` 事件显式声明

```yaml
$:
  vscode:
    - docker:
        build: .ide/Dockerfile              # 与 image 二选一，也可同时指定 image 作为回退
        image: cnbcool/default-dev-env:latest   # 构建失败时的回退镜像
      services:
        - vscode
        - docker
      stages:
        - name: install deps
          script: npm install
```

**容器模式**：镜像中**已安装 `code-server`** ⇒ **单容器模式**；**未安装** ⇒ **双容器模式**。两者均为官方支持。

**判定**：本设计采用 **A + B 并置**——提供 `.ide/Dockerfile`（环境定义），并在 `.cnb.yml` 用 `vscode` 事件显式声明 `build` + 回退 `image` + 环境校验 stage（满足 Phase 3 的版本验证要求）。

---

## 3. VS Code / Web IDE

**验证：支持。**

| 客户端 | 机制 | 镜像要求 |
|---|---|---|
| Web IDE | CNB 内置 WebIDE，由 `services: [vscode]` 提供 | 无 |
| VS Code / Cursor | Remote-SSH 连接开发环境 | 镜像需安装并启用 `openssh-server` |
| 自动打开 | `.cnb/settings.yml` 的 `workspace.launch.button.autoOpenWebIDE` | — |

官方 Dockerfile 示例中安装 `openssh-server` 的注释原文：
> 安装 ssh 服务，用于支持 VSCode 等客户端通过 Remote-SSH 访问开发环境

**判定**：Dockerfile 必须包含 `openssh-server`，否则退化为"仅 WebIDE"。本设计已覆盖。

---

## 4. AI Agent 使用方式

**验证：支持。核心机制 = NPC（Non-Player Character）。**

### 4.1 什么是 NPC

> NPC（Non-Player Character）是云原生构建中的**自动化角色**——虚拟智能助手，可以替你回复评论、协作代码等。
> 云原生构建把用户操作分为两类：手动点击、编辑的**页面交互**，以及 NPC 代你完成的**自动化交互**。后者的操作者身份统一显示为 **`NPC`**，与真人区分。

### 4.2 委托代理模型（治理语义）

| 术语 | 含义 |
|---|---|
| 当事人 principal | 发起委托的用户（`@` 提及者）；平台按其角色签发临时令牌 |
| 代理人 agent | 受托执行任务的 NPC，以当事人名义在限定范围内代办 |
| 代理权 delegated authority | **限时**（仅本次任务）+ **限地**（仅当前仓库）+ **限权**（角色上限与 scope 收窄）；任务结束自动终止 |

### 4.3 能力分层

| 层级 | 能力 | 触发条件 |
|---|---|---|
| L1 自动回复 | 回答问题、给代码审查意见（文字） | 默认 |
| L2 工作模式 | 写代码、推代码、建分支、发 PR、按评审意见修改 | **需显式开启「替我上班」**，且需仓库 开发者及以上 权限 |
| L3 自定义行为 | 自定义角色人设与运行方式 | `.cnb/settings.yml` + `.cnb.yml` |

**关键**：官方明确 **"默认情况下，NPC 只能读代码、写评论"**。写权限必须显式授予。
→ 这与任务书 Phase 2「ONLY READ / ANALYZE」「Agent 默认只读」**天然同构**，无需 PD 自建权限层。

### 4.4 两类 NPC

| 类型 | 提及方式 | 配置位置 |
|---|---|---|
| 系统 NPC（`CodeBuddy`） | `@CodeBuddy` | 开箱即用 |
| 自定义 NPC | `@<仓库路径>(角色名)` | 本仓库 `.cnb/settings.yml` 的 `npc.roles` |

### 4.5 定义自定义 NPC（本设计采用）

```yaml
# .cnb/settings.yml
npc:
  roles:
    - name: 专家
      slogan: 专业解答，高效协助
      prompt: |
        你以"专家"自称，致力于提供专业、准确的技术解答。
```

- `name`：`@` 提及用的角色名
- `slogan`：展示在 NPC 卡片/榜单
- `prompt`：系统提示词

**三步定制**：① 定义角色（必选，只做这步就能用）→ ② 自定义行为（`.cnb.yml`）→ ③ 自定义运行环境（Dockerfile）。

### 4.6 内置任务 `npc:go`

```yaml
$:
  pull_request:
    - docker:
        image: cnbcool/default-npc:latest
      stages:
        - name: npc go
          type: npc:go
          options:
            role: 代码审查员
            systemPrompt: 你是一个专业的代码审查员，请审查代码变更并给出改进建议
            userPrompt: 审查本次 PR 的代码变更，给出改进建议
```

已知 `options` 字段：`role`、`systemPrompt`、`userPrompt`、`model`、`supportImage`。

**⚠️ 未能验证的机制（1 项，需 CNB 侧确认）**：官方文档**未**说明 `npc:go` 的执行产物是否包含"在 workspace 写入文件"。已知其产物为**评论回复**；文件写入能力未文档化。
→ 影响：定时任务无 Issue/PR 可评论时，报告的落地方式存在不确定性。本设计的处置见 Phase 2 设计文档 §4.3 与 §7 待确认项。

**模型选择**：`npc:go` 的 `model` 字段可指定模型；未指定时走平台默认。`supportImage` 的默认值依赖是否自定义 `model`（自定义模型**不继承**平台默认的图片能力，回落 `false`）。

### 4.7 Skills 加载目录

NPC 镜像会自动加载：
- 用户级：`~/.agents/skills`、`~/.codebuddy/skills`
- 项目级：`.agents/skills`、`.codebuddy/skills`

同名 **项目级优先**。官方自定义 NPC 镜像示例预装 `@cnbcool/cnb-cli` + `skills` CLI + `cnb-skill`。

---

## 5. 自动化任务方式

**验证：支持 5 类事件来源。**

### 5.1 事件类型总表（官方）

| 类别 | 事件名 |
|---|---|
| Git 操作 | `push`、`commit.add`、`branch.create`、`branch.delete` |
| Pull Request | `pull_request`、`pull_request.update`、`pull_request.target`、`pull_request.mergeable`、`pull_request.merged`、`pull_request.approved`、`pull_request.changes_requested`、`pull_request.comment` |
| Tag | `tag_push`、`auto_tag`、`tag_deploy.*` |
| 页面操作 | `web_trigger`（含 `web_trigger_*`）、`vscode` |
| API 请求 | `api_trigger`（含 `api_trigger_*`） |
| **定时任务** | `"crontab: <POSIX cron>"` |
| Issue | `issue.open/close/reopen/update/update.*/comment` |
| NPC | `issue.comment@npc`、`pull_request.comment@npc` |

### 5.2 定时任务（对应"长时间运行任务"）

```yaml
main:
  "crontab: 30 5,17 * * *":
    - name: nightly-build-and-test
      stages:
        - name: run-tests
          script: echo "Running scheduled tasks..."
```

| 维度 | 事实 |
|---|---|
| 分支 | **必须是明确的单一分支名**，不支持 glob |
| 时区 | 系统时区 `Asia/Shanghai` |
| **最小间隔** | **5 分钟**（低于此不可提交） |
| 执行身份 | 最后**添加或修改**该配置的用户（Last Modifier） |
| 代码版本 | 指定分支 `HEAD` |
| 删除 | 移除该 `crontab:` 条目 |

**⚠️ 风险**：若负责人被移出仓库，其定时任务将**执行失败**。→ 需在 runbook 中标注"配置变更者即负责人"。

### 5.3 手动触发

```yaml
$:
  web_trigger:
    - docker:
        image: cnbcool/default-npc:latest
      stages:
        - name: npc go
          type: npc:go
          options:
            role: 小助
            userPrompt: $userPrompt     # 读取页面输入框
```

### 5.4 不可信事件与安全边界（对治理很关键）

官方将 **PR 相关事件、Issue 相关事件、NPC 事件** 列为**不可信事件**，并施加：

| 措施 | 内容 |
|---|---|
| `CNB_TOKEN` 权限收窄 | 未开工作模式的 NPC 事件：`repo-code:r`、`repo-pr:r`、`repo-issue:rw`、`repo-notes:rw`、`registry-package:r` |
| 文件引用显式声明 | 不可信事件引用外部文件时，被引用文件须经 `allow_events` 声明 |
| 分支来源 | PR 事件的流水线配置**取自源分支**（可能被未授权用户修改） |

可信事件（`push`/`tag_push`/`pull_request.target`/`api_trigger`）则持有 `repo-code:rw` 等完整权限。

**治理建议（已采纳进设计）**：云端流水线一律走**只读**姿态；不引用密钥仓库文件；不用 `imports` 引入敏感文件。

### 5.5 制品/报告上传

CNB 官方插件 `cnbcool/attachments:latest`：

```yaml
- name: 上传附件到 Commit
  image: cnbcool/attachments:latest
  settings:
    attachments:
      - "./cloud-audit-report.md"
    ttl: 30     # 天；不传默认永久
```

- 不指定 `tag`/`commit` 时，默认挂到 `$CNB_COMMIT`（本次触发 commit 的附件）
- 支持数组、逗号分隔、glob、否定模式
- 下载地址：`${CNB_API_ENDPOINT}/${CNB_REPO_SLUG}/-/commit-assets/download/${CNB_COMMIT}/<file>`

→ 这是**审计报告不落主分支**的落地机制（治理上关键：报告不写回 main）。

### 5.6 Pipeline 可配置项（官方语法）

`name`、`runner`(tags/cpus)、`docker`(image/build/devcontainer/volumes)、`git`(enable/submodules/**lfs**)、`services`、`env`、`imports`、`label`、`stages`、`failStages`、`endStages`、`ifNewBranch`、`ifModify`、`breakIfModify`、`retry`、`allowFailure`、`lock`、`sandbox`

**注意 `git.lfs` 存在** —— 对 PD 的 LFS 资产直接有用；`CNB_HAS_LFS_FILES` 可用于条件判断。

### 5.7 官方能力清单中"不提供"的项（避免误用）

- ❌ **SSH 访问仓库**：CNB 不支持 SSH，统一 HTTPS + 访问令牌
- ❌ **个人仓库**：仓库必须归属组织
- ❌ 定时任务的多分支 glob

---

## 6. 验证来源

| # | 文档 | URL |
|---|---|---|
| 1 | CNB 文档首页（能力总览） | https://docs.cnb.cool/zh/ |
| 2 | 云原生开发介绍 | https://docs.cnb.cool/zh/workspaces/intro.html |
| 3 | 自定义开发环境 | https://docs.cnb.cool/zh/workspaces/custom-dev-env.html |
| 4 | NPC（AI Agent 核心） | https://docs.cnb.cool/zh/build/npc.html |
| 5 | 语法手册（`.cnb.yml`） | https://docs.cnb.cool/zh/build/grammar.html |
| 6 | 触发规则（事件全表） | https://docs.cnb.cool/zh/build/trigger-rule.html |
| 7 | 定时任务 | https://docs.cnb.cool/zh/build/crontab.html |
| 8 | 默认环境变量 | https://docs.cnb.cool/zh/build/build-in-env.html |
| 9 | 内置任务（`npc:go`/`cnb:apply`/`cnb:trigger`） | https://docs.cnb.cool/zh/build/internal-steps.html |
| 10 | attachments 插件 | https://cnb.cool/cnb/plugins/cnbcool/attachments |
| 11 | 仓库迁移/同步实践（社区） | https://cnb.cool/reason195/New/-/issues/1 |

---

## 7. 与任务书假设的差异汇总

| # | 任务书表述 | 官方能力现实 | 处置 |
|---|---|---|---|
| M1 | 把「AI Agent 使用方式」与「自动化任务方式」列为两项独立能力 | 实为同一机制（NPC）；`npc:go` 可挂任意事件 | 设计中统一用 NPC + `npc:go`，不引入第二个 Agent 框架 |
| M2 | 隐含"可直接建立云端开发节点" | 必须归属组织；无个人仓库；需实名 | 标注为 Owner 前置动作（兼容性报告 §5.4） |
| M3 | Phase 6 要求"创建 PR" | CNB 与 GitHub 是两个平台。单向镜像下 CNB 侧无 PR | **PR 建在 GitHub**（PD 既有流程）；CNB 侧以定时/手动触发驱动 |
| M4 | 假设存在 `pnpm-lock.yaml` | 仓库为 npm workspaces | 以仓库为准（兼容性报告 §4.1 C1） |

---

## 8. 能力验证判定

**CNB 完全具备承载 PD 只读型 Cloud Agent Worker 的官方能力**，且其安全模型（默认只读 + 委托代理 + 不可信事件收窄）与 PD 治理原则方向一致。

唯一**未能通过文档确认**的机制是 §4.6 的「`npc:go` 是否能在 workspace 写入报告文件」。该点不影响立项，但影响定时任务的报告落地方式，列为 CNB 接入后的**首个待确认项**。
