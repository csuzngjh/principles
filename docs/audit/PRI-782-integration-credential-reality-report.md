# PRI-782 — Integration Credential Governance Reality Report（Phase 0.1 Recovery Run）

- 日期：2026-09-13
- 调查人：AI（CNB NPC `npc/CodeBuddy(deepseek-v4.1-flash)`，Issue #16）
- 基线：`main` @ `cf3f7049`（工作区 HEAD = `origin/main`，`git diff origin/main..HEAD` 为空）
- 任务性质：**只读重新取证**。未修改任何代码、配置、Secret 或权限。
- 唯一产物：本文档。

---

## 0. 本次运行的性质声明（必读）

**本报告是 Phase 0.1 Recovery Run，不是原始 Phase 0 报告的副本。**

| 项 | 说明 |
|---|---|
| 原始 Phase 0 运行 | 于 CNB 一次性容器内完成只读调查，报告文件（评论称 472 行）**只存在于该已销毁的容器文件系统** |
| 原始报告可恢复性 | **不可直接恢复**。工作区文件系统、`git log --all`、全部 ref 的 `ls-tree`、`git stash list`、`git fsck --unreachable`、远端分支、`cnb workspace list-workspaces` 均无命中（Issue #16 上一轮评论已留全量搜索证据） |
| 本报告来源 | **基于当前 `cf3f7049` 的代码与配置重新取证**，逐条附 `文件:行号` 证据 |
| 与原始报告的关系 | 原始报告的结论（21 项凭据、4 个存储面、P0-01/P1-01、REC-1~REC-5）仅作为**待复核假设**引用，不作为证据 |
| 根因归类 | Artifact Lifecycle 缺陷：审计产物只存在于临时执行环境，未落持久存储（AGENTS.md P1 的同族风险） |

任何与原始评论不一致之处，**以本报告的行号证据为准**。

证据纪律：

- 未创建、未读取、未打印任何 Token 值；本文所有凭据均以**变量名**引用。
- 未修改 `packages/**`、`.github/**`、`.cnb.yml`、任何 Secret 或权限。
- 未实施 REC-1 ~ REC-5。
- 信息不足处显式标注 `UNKNOWN`，不猜测。

---

## 1. Credential Inventory

### 1.1 GitHub Secrets（消费面：`.github/workflows/**`）

| System | Credential | Purpose | Storage | Permission | Risk |
|---|---|---|---|---|---|
| GitHub | `GITHUB_TOKEN`（平台注入） | CI 内仓库读写、PR 评论 | GitHub 平台临时注入 | workflow `permissions` 决定 | P2 |
| GitHub→Linear | `LINEAR_API_KEY` | `linear-sync.yml` 读状态 + 发提醒评论 | GitHub Secret | Linear API key（粒度 UNKNOWN） | **P1** |
| npm | `NPM_TOKEN` | 发布到 npm registry | GitHub Secret | publish（rw） | P1 |
| npm | `NPM_READ_TOKEN` | CI 只读安装 | GitHub Secret | 意图只读（**实际粒度 UNKNOWN**） | P2 |
| ClawHub | `CLAWHUB_TOKEN` | 同步 ClawHub marketplace | GitHub Secret | ClawHub API token | P1 |
| Codecov | `CODECOV_TOKEN` | 上传覆盖率 | GitHub Secret | Codecov 项目级 | P2 |
| LLM | `SENSENOVA_API_KEY` | E2E nightly LLM 调用 | GitHub Secret | API key（计费面） | P2 |
| LLM | `E2E_LLM_MODEL` | E2E 模型名（非敏感） | GitHub Secret | N/A | P2 |
| Cloudflare | `CLOUDFLARE_API_TOKEN` | `deploy-website.yml` Pages 部署 | GitHub Secret | Cloudflare API token | P1 |
| Cloudflare | `CLOUDFLARE_ACCOUNT_ID` | 账户标识（半敏感） | GitHub Secret | N/A | P2 |
| Release | `PD_RELEASE_SIGNING_KEY` | `release-metadata.yml` 签名发布元数据 | GitHub Secret | ed25519 私钥 = **更新信任根** | **P1** |
| Telemetry | `PRODUCT_TELEMETRY_CLEANUP_TOKEN` | 定时 90 天保留清理 | GitHub Secret | 单一端点 Bearer | P2 |

证据：`.github/workflows/*.yml`（`ci.yml:186,292`；`deploy-website.yml:50,51`；`e2e-nightly.yml:43,44,77,78,79`；`linear-sync.yml:60,88`；`publish-npm.yml:314,542,605,730,752`；`release-metadata.yml:120,226`；`telemetry-retention.yml:29`）。

### 1.2 CNB 侧

| System | Credential | Purpose | Storage | Permission | Risk |
|---|---|---|---|---|---|
| CNB | `CNB_TOKEN` | 流水线平台注入；`cnb-auto-deliver.mjs` 调 CNB API | **平台自动注入临时令牌，构建结束销毁** | 可信事件 = 平台上限（`repo-code:rw` 级） | **P0**（见 §3） |
| CNB→GitHub | `GITHUB_SYNC_TOKEN` | T6/T7 桥推送分支 + 建 GitHub PR | CNB 私有密钥仓库 `csuzngjh/pd-secrets` → `imports` 注入 | fine-grained PAT：Contents RW + Pull requests RW（仅 `csuzngjh/principles`） | **P0**（与 `CNB_TOKEN` 同容器） |
| CNB→GitHub | `GITHUB_SYNC_USERNAME` | 固定占位 `x-access-token`（非敏感） | `pd-secrets/cnb-github-bridge.yml` | N/A | P2 |
| CNB | 个人访问令牌 | Owner 手动镜像 GitHub → CNB（runbook §2） | **Owner 本地** | `repo-code:rw` + `repo-basic-info:r` | UNKNOWN（数量/scope/到期，UNK-01） |
| CNB | `pd-secrets` 授权声明 | `allow_slugs` / `allow_events` / `allow_branches` | `pd-secrets/cnb-github-bridge.yml` | 治理约束（非凭据本身） | UNKNOWN（现值，UNK-08） |

证据：`.cnb.yml:263,368`（`imports`）；`.cnb.yml:249-251`（令牌描述的注解）；`scripts/dev/cnb-auto-deliver.mjs:21-22`（`CNB_TOKEN` + `GITHUB_SYNC_TOKEN` 同时消费）；`docs/runbooks/CNB_CLOUD_WORKER.md:29-61`（个人令牌要求）、`:350-369`（§4.4.1 预置）。

### 1.3 Cloudflare Pages Secrets（消费面：`packages/website/functions/**`）

| System | Credential | Purpose | Storage | Permission | Risk |
|---|---|---|---|---|---|
| Cloudflare | `TELEMETRY_HMAC_SECRET` | 遥测快照 HMAC | Pages Secret | 服务端 HMAC（≥32B hex） | P2 |
| Cloudflare | `TELEMETRY_ABUSE_HMAC_SECRET` | 滥用限流域分离 HMAC | Pages Secret | 独立 HMAC | P2 |
| Cloudflare | `PRODUCT_SIGNALS_TOKEN` | 维护者视图 `GET /product-signals` Bearer | Pages Secret | 维护者只读视图 | P1 |
| Cloudflare | `PRODUCT_TELEMETRY_CLEANUP_TOKEN` | 清理端点 Bearer | Pages Secret（**与 GitHub Secret 同名，需同步轮换**） | 清理端点 | P2 |
| Cloudflare | `INGEST_TOKEN` | 反馈中继反滥用门（**非安全边界**） | Pages Secret | 常数时间比较门 | UNKNOWN（分发链路，UNK-06） |
| Cloudflare | `LIN_API_KEY` | 🔴 **Linear 第二份真副本**：用户反馈中继建 issue | Pages Secret | Linear API key | **P1** |
| Cloudflare | `LIN_TEAM_ID` | 反馈落哪个 Linear team | Pages Secret | 非敏感标识 | P2 |
| Cloudflare | `CLOUDFLARE_API_TOKEN`（本地形态） | 本地 `wrangler login` OAuth 长期会话 | **Owner 本机 wrangler 状态** | Cloudflare 账户级 | P2 |

证据：`packages/website/functions/_lib/telemetry-core.ts:72-75,331,333`；`product-signals-core.ts:36,134,137`；`telemetry-cleanup-core.ts:27,56,59`；`relay-core.ts:11,30,31,337,362`；`functions/api/feedback/index.ts:11`；`docs/process/DEPLOY_WEBSITE.md:12,15`。

### 1.4 宿主 / 运行时 env（消费面：`packages/**`）

| System | Credential | Purpose | Storage | Permission | Risk |
|---|---|---|---|---|---|
| PD Console | `PD_CONSOLE_TOKEN` | Console HTTP Bearer 认证 | Companion：**OS keychain 加密持久化**（`safeStorage`）或进程 env | 本地 Console | P1 |
| LLM | `OPENAI_API_KEY` | `strong-model-gate` 强模型裁决 | 宿主 env | API key | P2 |
| LLM | `MINIMAX_CN_API_KEY` | `runtime-uat` | 宿主 env | API key | P2 |
| LLM | `OPENAI_BASE_URL` / `LMSTUDIO_API_KEY` | resolver 自定义端点 | 宿主 env 或 `.pd/config.yaml` | API key | P2 |
| 运行时 | 解析后的 `apiKeyEnv` 名 | `runtime-adapter-resolver` 按名取 env | `.pd/config.yaml` 存**变量名**而非值 | 由 `.pd` 权限保护 | P2 |

证据：`packages/pd-console/src/server/config/AuthConfig.ts`；`packages/pd-companion/src/main/main.ts:514-546,591-618`；`packages/pd-cli/src/services/quality-scorecard/strong-model-gate.ts:109,117`；`packages/pd-cli/src/commands/runtime-uat.ts:322-324`；`packages/pd-cli/src/services/runtime-adapter-resolver.ts:267`；`docs/architecture/CONFIGURATION_ARCHITECTURE.md:248-266`。

### 1.5 OpenClaw 插件面

| System | Item | Purpose | Storage | Permission | Risk |
|---|---|---|---|---|---|
| OpenClaw 插件 | `PD_WORKSPACE_DIR` / `OPENCLAW_WORKSPACE` / `PD_STATE_DIR` | 工作区定位（**非凭据**） | 宿主 env | 路径 | P2 |
| OpenClaw 插件 | 无独立 API 凭据 | 插件经宿主能力与 PD 运行时通信 | — | — | P2 |

证据：`packages/openclaw-plugin/src/**` 中 `process.env.` 仅命中工作区路径变量，无 token/key/secret。

### 1.6 小结

- **总计 20 项凭据**，分布在 **5 个存储面**：GitHub Secrets（12）/ CNB 侧（4）/ Cloudflare Pages Secrets（8，含 1 项与 GitHub 同名）/ 宿主 env（5）/ Owner 本机（个人令牌 + wrangler OAuth）。
- 与原始 Phase 0 评论一致的两条核心发现：**跨 4 面散落、缺统一台账**，以及 **Linear 凭据有两份真副本**。
- 修正一处：本报告把 Cloudflare Pages Secrets 拆为 8 项单列（原始评论按 4 项聚合），存储面计为 5 个（原始为 4 个）。

---

## 2. Current Architecture

```
                          ┌──────────────────────────────┐
                          │            Owner             │
                          │  GitHub / CNB / Cloudflare   │
                          │  Linear / 本机 wrangler       │
                          └───────────────┬──────────────┘
                                          │ 手工预置（一次性）
              ┌───────────────────────────┼───────────────────────────┐
              │                           │                           │
              ▼                           ▼                           ▼
   ┌────────────────────┐    ┌────────────────────────┐    ┌────────────────────┐
   │ GitHub Secrets     │    │ CNB 密钥仓库            │    │ Cloudflare Pages   │
   │ (12 项)            │    │ csuzngjh/pd-secrets     │    │ Secrets (8 项)      │
   │                    │    │ cnb-github-bridge.yml   │    │                    │
   └─────────┬──────────┘    └───────────┬────────────┘    └─────────┬──────────┘
             │                           │ imports                   │
             │                           ▼                           │
             │              ┌────────────────────────────┐           │
             │              │ CNB 流水线容器              │           │
             │              │  CNB_TOKEN（平台注入）      │           │
             │              │  GITHUB_SYNC_TOKEN          │           │
             │              └────────────┬───────────────┘           │
             │                           │                           │
             ▼                           ▼                           ▼
   ┌────────────────────┐    ┌────────────────────────┐    ┌────────────────────┐
   │ GitHub Actions     │    │ GitHub API (Contents RW│    │ Cloudflare Pages   │
   │ (ci / deploy /     │───▶│  + Pull requests RW)   │◀───│ Functions          │
   │  release / linear) │    │ ⇢ sync/cnb-delivery/*  │    │ (relay / telemetry)│
   └─────────┬──────────┘    │ ⇢ ai/cnb-dev/*         │    └─────────┬──────────┘
             │               └────────────────────────┘              │
             ▼                                                       ▼
   ┌────────────────────┐                                ┌────────────────────┐
   │ Linear API         │                                │ Linear API         │
   │ LINEAR_API_KEY     │  ⚠ 两份真副本，无共同登记       │ LIN_API_KEY        │
   └────────────────────┘                                └────────────────────┘

   ┌──────────────────────────────────────────────────────────────────────┐
   │ 宿主（Owner 机器）                                                     │
   │  PD Console  ── PD_CONSOLE_TOKEN（keychain 加密） ──▶ HTTP Bearer      │
   │  Companion / pd-cli ── OPENAI_API_KEY / MINIMAX_CN_API_KEY / ...       │
   │  OpenClaw 插件 ── 无独立凭据，仅工作区路径 env                          │
   └──────────────────────────────────────────────────────────────────────┘
```

关系要点：

1. **Owner 是唯一预置者**，所有凭据均为手工创建后写入某一存储面，无签发/轮换自动化。
2. **CNB 容器是唯一的"双事实源同容器"节点**——同时持有 CNB 平台令牌与 GitHub PAT（§3 P0-01）。
3. **Linear 有两条互不知情的写入路径**（CI 提醒 vs 官网反馈中继），各有独立密钥名（§3 P1-01）。
4. PD Runtime / OpenClaw 面**不持有外部集成凭据**，仅本地认证（`PD_CONSOLE_TOKEN`）与 LLM key——这是正向边界。

---

## 3. Risk Assessment

### 3.1 P0 — 严重安全风险

#### P0-01 · CNB 交付容器同时持有两个事实源的写权限

- **事实**：`.cnb.yml:263` 与 `:368` 的 `imports` 把 `GITHUB_SYNC_TOKEN`（fine-grained PAT，Contents RW + Pull requests RW）注入 T6/T7 流水线容器；同一容器内的 `CNB_TOKEN`（可信事件 = 平台上限，见 `.cnb.yml:214`）被 `scripts/dev/cnb-auto-deliver.mjs:21,65,163,171` 用于 CNB API 列举 PR、发评论、关 PR。
- **后果**：T7 触发时，一个容器同时具备 **CNB 全量仓库写 + GitHub 内容写 + 开 PR**。
- **现有缓解**：GitHub `main` 有平台级分支保护（`required_status_checks: Verify Merge Gate (strict)` + `enforce_admins` + `allow_force_pushes: false`，见 `docs/audit/PRI-778-cnb-github-bridge-reality-report.md:15`）；桥只推 `sync/cnb-delivery/*`（`.cnb.yml:272,283`）与 `ai/cnb-dev/*`（`cnb-auto-deliver.mjs:7` HEAD_PREFIX）。**但这两类分支前缀的内容写入不受任何限制。**
- **文档矛盾**：`docs/runbooks/CNB_CLOUD_WORKER.md:377` 写"桥只建 `sync/cnb-delivery/*` 分支与 PR"，未提及 T7 的 `ai/cnb-dev/*` 路径，也未登记"容器同时持有 CNB 令牌"这一事实。
- **判定**：**已接受残余风险未登记**。这不必然要求立刻改造，但**沉默接受不可接受**。处置见 REC-1。

### 3.2 P1 — 治理风险

#### P1-01 · Linear 凭据有两份真副本，均未登记

| 副本 | 消费方 | 轮换漏改后果 |
|---|---|---|
| `LINEAR_API_KEY` | `.github/workflows/linear-sync.yml:60,88` → `scripts/ci/linear-sync.mjs` 读状态 + 发提醒 | 提醒**静默消失**（`linear-sync.mjs:416-417` 仅 `::warning::`，advisory 不阻塞） |
| `LIN_API_KEY` | `packages/website/functions/_lib/relay-core.ts:337` → 用户反馈建 Linear issue | **官网用户反馈静默丢失**（提交已完成，用户不会重试；失败仅返回 `linear_create_failed`） |

`relay-core.ts` 与 `linear-sync.mjs` 之间**无任何交叉引用**，任一方轮换都不会提醒另一方。

#### P1-02 · `NPM_READ_TOKEN`/`NPM_TOKEN` 回退逻辑抹平只读分离意图

`publish-npm.yml:314,730` 与 `release-metadata.yml:120` 使用 `${{ secrets.NPM_READ_TOKEN || secrets.NPM_TOKEN }}`。回退存在时，"CI 只读安装"与"发布写"使用同一令牌，只读分离**仅是命名意图，不是运行时事实**。

#### P1-03 · `PD_RELEASE_SIGNING_KEY` 是更新信任根，但无离线根仪式记录

- 该 ed25519 私钥签名整个仓库的发布元数据（`docs/architecture/PRI-727-release-metadata-publishing.md:80-84`）；安装侧以 `root.json` 为信任锚。
- `release-metadata.yml:243-247` 在缺密钥时**降级为 UNTRUSTED 临时密钥**（pipeline smoke 语义，实现正确）。
- **缺口**：私钥丢失/泄露的恢复路径（离线根仪式演练）在仓库内无记录。它是**信任根**，不是普通凭据。

#### P1-04 · 缺一份凭据台账（单一事实源）

20 项凭据无任何一处集中登记：用途、存储面、权限、消费方、轮换责任、到期。这使得"哪些副本必须同时轮换"（如 P1-01、`PRODUCT_TELEMETRY_CLEANUP_TOKEN` 同名双面）**只能靠通读全仓才发现**。

#### P1-05 · `.cnb.yml` 头部注解与 runbook §8 自相矛盾

- `docs/runbooks/CNB_CLOUD_WORKER.md:60-61`（§1.2）写"本项目的令牌只用于 Owner 手动执行镜像……**不进入 CI/流水线配置**"。
- `:392`（§8）写"**不得**引用密钥仓库文件 / 当前为「云端零密钥」姿态"。
- 但 `.cnb.yml:263,368` 已实际 `imports` 密钥仓库，`§4.4.1` 亦明确要求预置。

两处文档**与当前实现直接冲突**，会误导后续维护者判断安全姿态。

### 3.3 P2 — 优化项

- **P2-01** · `PRODUCT_TELEMETRY_CLEANUP_TOKEN` 同名存在于 GitHub Secret（`telemetry-retention.yml:29`）与 Cloudflare Pages Secret（`telemetry-cleanup-core.ts:27`），需人工保证两侧等值轮换。
- **P2-02** · Cloudflare 凭据双形态：CI 用 `CLOUDFLARE_API_TOKEN`，本地用 `wrangler login` 的 OAuth 长期会话（`docs/process/DEPLOY_WEBSITE.md:15`），两者均指向同一账户，权限边界未声明。
- **P2-03** · `INGEST_TOKEN` 自述为"反滥用门，非安全边界"（`relay-core.ts:11`）——语义正确，但若被误当安全边界配置会产生虚假信心。
- **P2-04** · `E2E_LLM_MODEL` 作为 Secret 存储（非敏感），`e2e-nightly.yml:44,79`；可考虑降级为普通变量。

### 3.4 正向发现（不应被风险项掩盖）

1. `gitleaks` 已进入 **pre-push 强制链**（`lefthook.yml:29-43`），且 `.gitleaks.toml` 显式 `useDefault = true`（避免空规则集假通过）。
2. Console 认证使用 `crypto.timingSafeEqual`（`AuthConfig.ts`），长度不等提前返回。
3. 桥的令牌传播做了三层防护：credential-helper 管道传值（`cnb-auto-deliver.mjs:104`）、`umask 077` 临时 header 文件 + `trap` 清理（`.cnb.yml:302` 附近）、`redact()` 兜底（`cnb-auto-deliver.mjs:37`）。
4. Companion 用 OS `safeStorage` 加密持久化 Console token，解密失败即清除（`main.ts:514-516`）。
5. 维护者视图令牌（`PRODUCT_SIGNALS_TOKEN`）与清理令牌（`PRODUCT_TELEMETRY_CLEANUP_TOKEN`）已分离，注释显式声明"independent secret"（`telemetry-cleanup-core.ts:13-14`）。
6. 遥测 HMAC 与滥用限流 HMAC **域分离**（`telemetry-core.ts:72-75,272`）。
7. 密钥缺失时的降级均有结构化 reason + nextAction（`rc-9` 合规），无静默回退。
8. 桥的失败路径 fail-loud，`nextAction` 指向具体 runbook 章节。
9. Git 分支写权限通过平台保护（非仅靠约定）限制 `main`。
10. `docs/security/` 目录不存在但有 `.github/SECURITY.md` + `scripts/check-security-baseline.js` 守基线（Issue 任务书提到的 `docs/security` 实为不存在路径）。
11. 插件面（OpenClaw）**零外部集成凭据**，只消费工作区路径 env——边界干净。

---

## 4. Recommendation — 最小可行治理方案

**约束遵守**：不设计 Vault，不引入新 Secret 系统，不新增存储面，不新增门禁（`.cnb.yml` 头部治理说明"第一阶段不新增门禁"）。REC-1~REC-5 本报告**仅提出，未实施**。

### REC-1（P0-01）· 收窄 CNB 容器跨事实源写权限

两条互斥路径，**先取证再选路**：

- **路径 A**：若 CNB 支持 stage 级 / 条件化 `imports` → 把 `GITHUB_SYNC_TOKEN` 的注入面收窄到真正需要它的 stage，`CNB_TOKEN` 的消费 stage 不再见到它。（改 `.cnb.yml` 一处）
- **路径 B**：若**不支持**（UNK-05 未取证）→ 在 GitHub 侧对 `sync/cnb-delivery/*` 与 `ai/cnb-dev/*` 前缀加 ruleset，并把 P0-01 **显式登记为"已接受残余风险"**（写入 runbook §5 已知限制）。

**无论走哪条**：runbook §4.4.2 必须补上"容器同时持有 CNB 令牌与 GitHub PAT"这一事实。

### REC-2（P1-01）· Linear 收敛为一份 + 换服务账号

- 收敛 `LINEAR_API_KEY` / `LIN_API_KEY` 为**同一份凭据**（先确认 relay 与 CI 是否可共用同一 Linear key；若权限粒度不允许，则在台账登记"两份必须同步轮换"）。
- 建议换成 **Linear 服务账号**，权限仅 `read` + `issues:create` + `comments:create`，替代当前疑似个人 key。

### REC-3（P1-03）· `PD_RELEASE_SIGNING_KEY` 补一次离线根仪式演练记录

- 仅补**文档化演练记录**（runbook），不新增密钥系统。
- 产出：私钥丢失/泄露的恢复路径 + `root.json` 旋转流程边界（当前 publisher 不旋转 root，root 版本固定 1）。

### REC-4（P1-04）· 落一张 `docs/runbooks/` 凭据台账

- **不是系统，是一张表**。列：凭据名 / 存储面 / 用途 / 权限 / 消费方（`文件:行号`）/ 轮换责任 / 到期 / 关联副本。
- 本报告 §1 与 §5.4 即为 v0 内容，可直接迁移。
- 零新增存储面、零新增门禁。

### REC-5（P1-02 / P1-05 / P2）· 修文档自相矛盾 + 台账登记

- §1.2 与 §8 的"不进入 CI / 云端零密钥"表述必须与 §4.4.1 现实对齐（删除或加修订说明）。
- `NPM_READ_TOKEN || NPM_TOKEN` 回退：要么补齐 `NPM_READ_TOKEN` 使回退不生效，要么在台账显式标注"回退生效 ⇒ 只读分离未落地"。
- `PRODUCT_TELEMETRY_CLEANUP_TOKEN` 同名双面：在台账登记为**必须同步轮换**。

### Phase 1 建议形态

**"取证 + 台账"，不含建设。** 见 §5 的 UNKNOWN 清单——6 项必须 Owner 登录后台才能填。

---

## 5. UNKNOWN 登记（不猜测）

| ID | UNKNOWN | 为何本 Agent 无法取证 | 阻断的 REC |
|---|---|---|---|
| UNK-01 | CNB 个人令牌的数量 / scope / 到期 | 需登录 CNB 个人设置 | REC-4 |
| UNK-02 | `NPM_READ_TOKEN` 是否真只读 | 需登录 npm 查看 token 粒度 | REC-5 |
| UNK-03 | Linear key 的实际权限粒度 | 需登录 Linear | REC-2 |
| UNK-04 | GitHub Secrets 的 `updated_at` | 需 `gh secret list`（本环境无 gh 凭据） | REC-4 |
| UNK-05 | CNB 是否支持 stage 级 `imports` | 需 CNB 平台文档/实测 | **REC-1 选路** |
| UNK-06 | `INGEST_TOKEN` 的分发链路 | 无仓库内文档；需平台侧确认 | P2-03 |
| UNK-07 | `pd-secrets` 的 `allow_*` 现值是否与 §4.4.1 一致 | 需读私有密钥仓库 | REC-1 路径 B |
| UNK-08 | Cloudflare Pages Secrets 的实际设置面 | 需 `wrangler pages secret list` | REC-4 |
| UNK-09 | `log-sanitizer.ts` 的具体实现形态 | 本仓未命中该文件（原始评论提及） | P2-03 |

### 5.4 凭据台账 v0（可直接迁移至 runbook）

| 凭据名 | 存储面 | 消费方（证据） | 权限 | 轮换责任 | 关联副本 |
|---|---|---|---|---|---|
| `GITHUB_TOKEN` | GitHub 平台注入 | 全部 workflows | 由 `permissions` 决定 | 平台自动 | — |
| `LINEAR_API_KEY` | GitHub Secret | `linear-sync.yml:60,88` | Linear API | Owner | **`LIN_API_KEY`** |
| `LIN_API_KEY` | Cloudflare Pages | `relay-core.ts:337` | Linear API | Owner | **`LINEAR_API_KEY`** |
| `NPM_TOKEN` | GitHub Secret | `publish-npm.yml:542` 等 | npm publish | Owner | `NPM_READ_TOKEN`（回退） |
| `NPM_READ_TOKEN` | GitHub Secret | `publish-npm.yml:314,730` | npm read（待确认） | Owner | `NPM_TOKEN` |
| `CLAWHUB_TOKEN` | GitHub Secret | `publish-npm.yml:605` | ClawHub | Owner | — |
| `CODECOV_TOKEN` | GitHub Secret | `ci.yml:186,292` | Codecov | Owner | — |
| `SENSENOVA_API_KEY` | GitHub Secret | `e2e-nightly.yml:43,77` | LLM | Owner | — |
| `E2E_LLM_MODEL` | GitHub Secret | `e2e-nightly.yml:44,79` | N/A | Owner | — |
| `CLOUDFLARE_API_TOKEN` | GitHub Secret | `deploy-website.yml:50` | CF Pages | Owner | wrangler OAuth |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Secret | `deploy-website.yml:51` | N/A | Owner | — |
| `PD_RELEASE_SIGNING_KEY` | GitHub Secret | `release-metadata.yml:226` | 更新信任根 | Owner | `root.json` |
| `PRODUCT_TELEMETRY_CLEANUP_TOKEN` | GitHub Secret + Pages | `telemetry-retention.yml:29` / `telemetry-cleanup-core.ts:27` | 清理端点 | Owner | **同名双面** |
| `CNB_TOKEN` | CNB 平台注入 | `cnb-auto-deliver.mjs:21` | 平台上限 | 平台自动 | — |
| `GITHUB_SYNC_TOKEN` | CNB `pd-secrets` | `.cnb.yml:263,368` | Contents RW + PR RW | Owner | — |
| `GITHUB_SYNC_USERNAME` | CNB `pd-secrets` | `.cnb.yml` 桥 | N/A | Owner | — |
| CNB 个人令牌 | Owner 本机 | runbook §2 手动镜像 | `repo-code:rw` | Owner | UNK-01 |
| `TELEMETRY_HMAC_SECRET` | Pages Secret | `telemetry-core.ts:73` | HMAC | Owner | — |
| `TELEMETRY_ABUSE_HMAC_SECRET` | Pages Secret | `telemetry-core.ts:75,331` | HMAC | Owner | — |
| `PRODUCT_SIGNALS_TOKEN` | Pages Secret | `product-signals-core.ts:134` | 维护者视图 | Owner | — |
| `INGEST_TOKEN` | Pages Secret | `relay-core.ts:362` | 反滥用门 | Owner | UNK-06 |
| `LIN_TEAM_ID` | Pages Secret | `relay-core.ts` | N/A | Owner | — |
| `PD_CONSOLE_TOKEN` | keychain / env | `AuthConfig.ts` | 本地 Console | Owner | — |
| `OPENAI_API_KEY` | 宿主 env | `strong-model-gate.ts:109` | LLM | Owner | — |
| `MINIMAX_CN_API_KEY` | 宿主 env | `runtime-uat.ts:323` | LLM | Owner | — |
| `LMSTUDIO_API_KEY` / `OPENAI_BASE_URL` | 宿主 env / `.pd/config.yaml` | resolver | LLM | Owner | — |

---

## 6. Complexity Delta

| 项 | 值 |
|---|---|
| New durable source of truth | NO |
| New persisted schema/state | NO |
| New subsystem/service/background process | NO |
| New public abstraction/interface | NO |
| New runtime feature flag | NO |
| New cross-package dependency | NO |
| New host/platform-specific behavior | NO |
| New external/network capability | NO |

本任务为只读审计 + 一份文档；REC-1~REC-5 均为**零新增存储面、零新增门禁**的复用型动作。

---

## 7. 验收对照

- [x] Reality Report（本文件）
- [x] Credential Inventory（§1，20 项 / 5 存储面）
- [x] Risk classification（§3，P0×1 / P1×5 / P2×4）
- [x] Recommended next phase（§4，Phase 1 = 取证 + 台账）
- [x] 明确标注 Phase 0.1 Recovery Run 与不可恢复性（§0）
- [x] UNKNOWN 显式登记（§5，9 项）

---

## 8. 与 Issue 任务书的差异说明

| 任务书要求 | 本报告 | 原因 |
|---|---|---|
| 检查 `docs/security` | **该路径不存在** | 实际安全基线在 `.github/SECURITY.md` + `scripts/check-security-baseline.js`；已按现实审计 |
| "不创建 PR"（原始 Phase 0） | 本 Phase 0.1 **按 Owner 新指令创建 PR** | Owner 在 Issue #16 明确要求建分支 + commit + PR |
| 原始报告 21 项凭据 | 本报告 **20 项 / 5 面** | 基于当前代码重新取证；聚合口径差异已在 §1.6 说明 |
