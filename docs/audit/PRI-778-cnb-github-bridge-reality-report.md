# PRI-778 — CNB → GitHub Delivery Bridge Reality Report（Phase 0）

- 日期：2026-09-12
- 调查人：AI（P1 / P2.1 Reality Audit）
- 基线：GitHub `main` @ `e6a1f271`；CNB `main` @ `173e1d035`
- **结论先行：方案成立。** `pull_request.merged` 为 CNB 官方事件且属可信语义；官方 `git-sync` 插件适配推送半程；GitHub main 有平台级保护（force push 被禁、Verify Merge Gate 强制），"不 push main"同时具备治理与平台双重约束。**当前已存在真实滞留载荷**（PRI-701，`173e1d035`），桥的第一票就是它。

---

## 任务书四问

### 1. Canonical 约束

- **GitHub 是唯一事实源**：单向镜像方向 GitHub → CNB（runbook §2 方案A）；PR 合并权在 GitHub（AGENTS §23「Never push directly to main / Owner performs final merge」）；CNB 侧合并只是提案落地（runbook §4.3）。
- **不允许自动 push GitHub main——且这是平台强制的**（实测 `GET /branches/main/protection`）：`required_status_checks: Verify Merge Gate (strict)` + `enforce_admins: true` + `allow_force_pushes: false` + `allow_deletions: false`。直推 main 无法预过 CI 检查 ⇒ 实际只能走 PR。桥的设计因此**只推 `sync/cnb-delivery/*` 分支 + 开 PR**。

### 2. 当前 CNB

- `.cnb.yml` 事件面（`$:` 全局 + `main:` 定时）：T1 `pull_request`（只读审查）、T2 `"crontab: 0 2 * * 1"`、T3/T3b `web_trigger_audit`/`api_trigger_audit`、T5/T5b `web_trigger_dev`/`api_trigger_dev`（PRI-767/768）。
- **`pull_request.merged` 官方支持**（trigger-rule 文档）：a 合并到 b 时触发 **b 分支下的** `pull_request.merged`——配置取自目标分支 main ⇒ **可信事件语义**，可引用密钥仓库文件（不可信事件的 `allow_events` 显式声明要求不适用）；workspace 代码版本 = **合并后的 commit**（正是要桥接的对象）。
- 新桥挂 `main: pull_request.merged:`，只处理 base=main 的合并——普通 PR 事件（T1）不受影响。

### 3. 已存在的同步机制

- **无自动化**。GitHub → CNB 是手动单向镜像（runbook §2 方案A-2 手动档；今日已执行过一次快进 `f9e9dfd7 → fbdc56332`）；CNB → GitHub 方向为零——**且已经产生真实滞留**：
  - CNB main（`173e1d035`）= `fbdc56332` + **PRI-701 census**（CNB 合并请求 #3，Owner 已在 CNB 合并；5 文件 +1071 行，全部落在 `.cnb/`、`docs/`、`scripts/`——Developer 章程允许范围内，零 packages ✓）；
  - GitHub main（`7b8836ef9`）已另行前进（#1638、#1641）。
  - 两端真分叉 ⇒ 桥的第一票就是把 `173e1d035` 送到 GitHub。

### 4. CNB 官方 git-sync 插件是否适合？

**适合（推送半程）。** [tencentcom/git-sync](https://cnb.cool/cnb/plugins/tencentcom/git-sync)（官方，MIT）：`settings` 支持 `target_url` / `auth_type: https` / `username` / `password`（官方建议令牌存密钥仓库经 `imports` 注入）/ `branch`（只推指定分支）/ `force: false`。创建 GitHub PR 的后半程插件不覆盖，用一段 curl 脚本（GitHub REST `POST /pulls`），令牌经**临时 header 文件**传递（umask 077 + trap 清理），命令行与日志零令牌暴露。

### 密钥仓库机制（安全设计的平台依据）

`.cnb.yml` 的 `imports: https://cnb.cool/<slug>/-/blob/main/<file>` 把密钥仓库文件（.yml/.json/key=value）解析注入为环境变量；跨仓库私有文件须在文件内声明 `allow_slugs` / `allow_events` / `allow_branches` 四字段。本设计：

- 密钥仓库：`csuzngjh/pd-secrets`（私有），文件 `cnb-github-bridge.yml`；
- 变量名（任务书指定）：`GITHUB_SYNC_TOKEN`（fine-grained PAT，仅 `csuzngjh/principles`，Contents RW + Pull requests RW）+ `GITHUB_SYNC_USERNAME`（固定占位 `x-access-token`）；
- `allow_slugs: "csuzngjh/principles"`、`allow_events: pull_request.merged`、`allow_branches: main`——最小授权；
- 令牌生命周期内不进 git 历史、不进 PR/评论、不进日志（header 文件模式 + 插件 settings 引用）。

### Owner 一次性预置（代码无法代劳的部分）

1. GitHub：创建 fine-grained PAT（Repository access: Only `csuzngjh/principles`；Permissions: Contents=RW, Pull requests=RW）；
2. CNB：创建私有密钥仓库 `csuzngjh/pd-secrets`，在 `main` 分支放 `cnb-github-bridge.yml`（内容模板见 runbook §4.4），填入 PAT 值；
3. 预置完成前，若 CNB 发生合并，桥流水线会在 imports 解析处 **fail-loud**（不会静默跳过）——这是有意的，失败信息给出 nextAction。

---

## 与既有任务的关系

- PRI-767/768（Developer 入口）的产物生命周期写着"落地 GitHub = Owner 认可后人工移植"——本桥就是该步骤的自动化（触发条件：CNB 合并后）；
- 不引入双向同步：桥只做 CNB → GitHub；GitHub → CNB 的镜像回同步仍是独立机制（方案A-2 手动档 / 待批 A-2a GHA）；
- 范围：`.cnb.yml`、`docs/runbooks/CNB_CLOUD_WORKER.md`、本报告；零 packages、零 .github、零业务代码。
