# Credential Inventory — PD 集成凭据台账（v0 草案）

> **状态**: Draft（Phase 1 Preparation 产物，待 Owner Review）
> **最后更新**: 2026-09-13
> **来源**: `docs/audit/PRI-782-integration-credential-reality-report.md`（Phase 0.1 Recovery Run）+ `docs/audit/credential-governance-phase1-preparation.md`
> **适用角色**: Owner / 仓库维护者

---

## 0. 这份台账是什么 / 不是什么

**是**：跨 5 个存储面的凭据**登记表**。每项记录用途、存储面、权限、消费方与轮换责任。

**不是**：

- ❌ 不是 Secret 存储。**本文件不含、也绝不允许包含任何 Secret 值、token 片段、密钥内容。**
- ❌ 不是轮换自动化系统（Phase 1 不建设任何新系统）。
- ❌ 不是权限授予依据。台账只**描述**现状，不改变任何权限。

**核心用途**：回答"哪些副本必须同时轮换"（P1-01 / P2-01）这类跨面耦合问题——
这类问题此前只能靠通读全仓才能发现。

**记录纪律**：

1. 只填**变量名**与**存储位置**，不填值。
2. 无法取证的一律标 `UNKNOWN`，并登记到第 3 节 UNKNOWN 清单。**禁止猜测。**
3. 消费方列**具体 `文件:行号`**，不用模糊描述。

---

## 1. 凭据台账

### 1.1 GitHub Secrets（消费面：`.github/workflows/**`）

| Credential | System | Purpose | Storage Location | Permission | Rotation |
|---|---|---|---|---|---|
| `GITHUB_TOKEN` | GitHub | CI 内仓库读写、PR 评论 | GitHub 平台临时注入 | 由 workflow `permissions` 决定 | 平台自动 |
| `LINEAR_API_KEY` | GitHub → Linear | `linear-sync.yml` 读状态 + 发提醒评论 | GitHub Secret | Linear API key（粒度 UNKNOWN） | Owner 手动（UNK-03） |
| `NPM_TOKEN` | GitHub → npm | 发布到 npm registry | GitHub Secret | npm publish（rw） | Owner 手动 |
| `NPM_READ_TOKEN` | GitHub → npm | CI 只读安装 | GitHub Secret | 意图只读（实际粒度 UNKNOWN） | Owner 手动（UNK-02） |
| `CLAWHUB_TOKEN` | GitHub → ClawHub | 同步 ClawHub marketplace | GitHub Secret | ClawHub API token | Owner 手动 |
| `CODECOV_TOKEN` | GitHub → Codecov | 上传覆盖率 | GitHub Secret | Codecov 项目级 | Owner 手动 |
| `SENSENOVA_API_KEY` | GitHub → LLM | E2E nightly LLM 调用 | GitHub Secret | API key（计费面） | Owner 手动 |
| `E2E_LLM_MODEL` | GitHub | E2E 模型名（**非敏感**） | GitHub Secret | N/A | 建议降级为普通变量（P2-04） |
| `CLOUDFLARE_API_TOKEN` | GitHub → Cloudflare | `deploy-website.yml` Pages 部署 | GitHub Secret | Cloudflare API token | Owner 手动 |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub → Cloudflare | 账户标识（半敏感） | GitHub Secret | N/A | Owner 手动 |
| `PD_RELEASE_SIGNING_KEY` | GitHub → PD 更新链 | `release-metadata.yml` 签名发布元数据 | GitHub Secret | ed25519 私钥 = **更新信任根** | Owner 手动（离线仪式，P1-03） |
| `PRODUCT_TELEMETRY_CLEANUP_TOKEN` | GitHub → Cloudflare | 定时 90 天保留清理 | GitHub Secret | 单一端点 Bearer | **必须与 Pages 侧同名项同步轮换**（P2-01） |

### 1.2 CNB 侧（消费面：`.cnb.yml`；密钥源：私有密钥仓库 `csuzngjh/pd-secrets`）

| Credential | System | Purpose | Storage Location | Permission | Rotation |
|---|---|---|---|---|---|
| `CNB_TOKEN` | CNB | 平台自动注入；`cnb-auto-deliver.mjs` 调 CNB API | **平台自动注入，构建结束销毁** | 可信事件 = 平台上限（`repo-code:rw` 级） | 平台自动 |
| `GITHUB_SYNC_TOKEN` | CNB → GitHub | T6/T7 桥推送分支 + 建 GitHub PR | CNB 私有密钥仓库 `csuzngjh/pd-secrets` → `imports` 注入 | fine-grained PAT：Contents RW + Pull requests RW（仅 `csuzngjh/principles`） | Owner 手动 |
| `GITHUB_SYNC_USERNAME` | CNB → GitHub | 固定占位 `x-access-token`（**非敏感**） | `pd-secrets/cnb-github-bridge.yml` | N/A | N/A |
| CNB 个人访问令牌 | CNB | Owner 手动镜像 GitHub → CNB | **Owner 本机**（不入库） | `repo-code:rw` + `repo-basic-info:r` | Owner 手动，建议 90 天（UNK-01） |
| `pd-secrets` 授权声明（`allow_slugs` / `allow_events` / `allow_branches`） | CNB | 密钥文件访问范围控制（**治理约束，非凭据本身**） | `pd-secrets/cnb-github-bridge.yml` | 声明式 glob | 随 `pd-secrets` 变更（UNK-07） |

### 1.3 Cloudflare Pages Secrets（消费面：`packages/website/functions/**`）

| Credential | System | Purpose | Storage Location | Permission | Rotation |
|---|---|---|---|---|---|
| `TELEMETRY_HMAC_SECRET` | Cloudflare | 遥测快照 HMAC | Pages Secret | 服务端 HMAC（≥32B hex） | Owner 手动 |
| `TELEMETRY_ABUSE_HMAC_SECRET` | Cloudflare | 滥用限流域分离 HMAC | Pages Secret | 独立 HMAC | Owner 手动（与上一项域分离） |
| `PRODUCT_SIGNALS_TOKEN` | Cloudflare | 维护者视图 `GET /product-signals` Bearer | Pages Secret | 维护者只读视图 | Owner 手动 |
| `PRODUCT_TELEMETRY_CLEANUP_TOKEN` | Cloudflare | 清理端点 Bearer | Pages Secret | 清理端点 | **必须与 GitHub Secret 同名项同步轮换**（P2-01） |
| `INGEST_TOKEN` | Cloudflare | 反馈中继反滥用门（**非安全边界**） | Pages Secret | 常数时间比较门 | Owner 手动（分发链路 UNK-06） |
| `LIN_API_KEY` | Cloudflare → Linear | 用户反馈中继建 issue | Pages Secret | Linear API key | **必须与 `LINEAR_API_KEY` 同步轮换**（P1-01） |
| `LIN_TEAM_ID` | Cloudflare → Linear | 反馈落哪个 Linear team | Pages Secret | 非敏感标识 | N/A |
| `CLOUDFLARE_API_TOKEN`（本地形态） | Cloudflare | 本地 `wrangler login` OAuth 长期会话 | **Owner 本机 wrangler 状态** | Cloudflare 账户级 | Owner 手动（P2-02） |

### 1.4 宿主 / 运行时 env（消费面：`packages/**`）

| Credential | System | Purpose | Storage Location | Permission | Rotation |
|---|---|---|---|---|---|
| `PD_CONSOLE_TOKEN` | PD Console | Console HTTP Bearer 认证 | Companion：OS keychain 加密持久化（`safeStorage`）或进程 env | 本地 Console | 重新生成即轮换 |
| `OPENAI_API_KEY` | LLM | `strong-model-gate` 强模型裁决 | 宿主 env | API key | Owner 手动 |
| `MINIMAX_CN_API_KEY` | LLM | `runtime-uat` | 宿主 env | API key | Owner 手动 |
| `OPENAI_BASE_URL` / `LMSTUDIO_API_KEY` | LLM | resolver 自定义端点 | 宿主 env 或 `.pd/config.yaml` | API key | Owner 手动 |
| 解析后的 `apiKeyEnv` 变量名 | PD Runtime | `runtime-adapter-resolver` 按名取 env | `.pd/config.yaml` 存**变量名**而非值 | 由 `.pd` 权限保护 | N/A |

### 1.5 OpenClaw 插件面

| Credential | System | Purpose | Storage Location | Permission | Rotation |
|---|---|---|---|---|---|
| （无独立凭据） | OpenClaw 插件 | 插件经宿主能力与 PD 运行时通信 | — | — | N/A |
| `PD_WORKSPACE_DIR` / `OPENCLAW_WORKSPACE` / `PD_STATE_DIR` | OpenClaw 插件 | 工作区定位（**非凭据**） | 宿主 env | 路径 | N/A |

> **正向边界**：插件面零外部集成凭据，只消费工作区路径 env。

---

## 2. 必须同步轮换的耦合组（本台账的核心价值）

| 组 | 成员 | 不同步的后果 |
|---|---|---|
| **Linear 双副本** | `LINEAR_API_KEY`（GitHub Secret）+ `LIN_API_KEY`（Pages Secret） | 漏改一侧 → 该侧**静默失效**：CI 提醒消失（仅 `::warning::`）或官网用户反馈静默丢失（用户不会重试） |
| **Telemetry 清理同名双面** | `PRODUCT_TELEMETRY_CLEANUP_TOKEN`（GitHub Secret + Pages Secret） | 漏改一侧 → 定时清理或清理端点失效 |
| **NPM 回退对** | `NPM_READ_TOKEN` || `NPM_TOKEN`（`publish-npm.yml:314,730`、`release-metadata.yml:120`） | 回退生效时"只读安装"实际用发布令牌 → **只读分离未落地**（P1-02） |
| **Cloudflare 双形态** | `CLOUDFLARE_API_TOKEN`（GitHub Secret）+ wrangler OAuth（本机） | 权限边界未声明，轮换只做一半（P2-02） |

---

## 3. UNKNOWN 登记（不猜测，待 Owner 取证后回填）

| ID | UNKNOWN | 为何无法由 Agent 取证 | 影响 |
|---|---|---|---|
| UNK-01 | CNB 个人令牌的数量 / scope / 到期 | 需登录 CNB 个人设置 | §1.2 该行填不全 |
| UNK-02 | `NPM_READ_TOKEN` 是否真只读 | 需登录 npm 查看 token 粒度 | §2 NPM 回退对判定 |
| UNK-03 | Linear key 的实际权限粒度 | 需登录 Linear | §1.1 / §1.3 Linear 行 |
| UNK-04 | GitHub Secrets 的 `updated_at` | 需 `gh secret list`（本环境无 gh 凭据） | 无法推算轮换周期 |
| UNK-06 | `INGEST_TOKEN` 的分发链路 | 无仓库内文档；需平台侧确认 | §1.3 该行 |
| UNK-07 | `pd-secrets` 的 `allow_*` 现值 | 需读私有密钥仓库 | §1.2 授权声明行 |
| UNK-08 | Cloudflare Pages Secrets 的实际设置面 | 需 `wrangler pages secret list` | 无法确认是否存在台账未登记的项 |
| UNK-09 | 各凭据的**到期时间**（普遍缺失） | 多数凭据为无限期 PAT/key | 无法排轮换计划 |

> 回填方式：Owner 登录对应后台后，把值写入本表对应单元格（**只写粒度/日期，不写值**）。

---

## 4. 维护约定

1. **新增凭据时必须同时更新本台账**（PR 检查项，非门禁——Phase 1 不新增门禁）。
2. **轮换凭据时必须检查第 2 节耦合组**。
3. 值永不入本文件；本文件可安全提交到公开仓库。
4. 本台账的描述性事实以代码为准；发现漂移时以 `文件:行号` 证据修正本文件。

---

## 5. 证据索引

| 消费方证据 | 路径 |
|---|---|
| GitHub workflows | `.github/workflows/*.yml` |
| CNB 桥 imports | `.cnb.yml:263,368` |
| 桥运行时消费 | `scripts/dev/cnb-auto-deliver.mjs:21-22` |
| Pages Functions | `packages/website/functions/**` |
| Console 认证 | `packages/pd-console/src/server/config/AuthConfig.ts` |
| CNB 接入 runbook | `docs/runbooks/CNB_CLOUD_WORKER.md` §1.1、§4.4.1 |
| Phase 0.1 审计 | `docs/audit/PRI-782-integration-credential-reality-report.md` |
