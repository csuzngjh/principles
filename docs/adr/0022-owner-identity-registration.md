# ADR-0022: Owner Identity Registration — Env-First, File-Fallback (`~/.pd/owner.json`)

> **Status**: Accepted（2026-08-29 Owner 评审通过，§6 四个问题全部确认）
> **Date**: 2026-08-29
> **Decider**: Owner
> **Context**: PRI-578 — Owner 身份目前只能通过两个未文档化的环境变量配置，没有任何登记入口
> **Related**: [ADR-0016](0016-pd-owned-user-config.md)（PD 不持久化原始凭据）；[ADR-0021](0021-anonymous-product-telemetry.md)（`~/.pd/product-telemetry.json` 机器级作用域先例）；PRI-583（`~/.pd/` 安装布局）；PRI-584~587（治理体验快照）；PR #1443 / #1445 / #1446（PRI-578 修复计划 PR-1/PR-2/PR-3-B）

## 1. Context

PRI-578 的原始缺口：Owner 身份 **100% 依赖环境变量**（`PD_OWNER_ID` + `PD_OWNER_CREDENTIAL_ID`），零登记入口、零用户文档。已核实的证据：

- **6 处 `process.env` 直读**分布在 3 个文件：`pd-console/src/server/index.ts:468-469`、`routes/governance.ts:43-44`、`pd-cli/src/commands/runtime-activation.ts:503-504`；另有 `routes/activations.ts:101` 消费 `authority.ownerActor`（其上游由 `index.ts:485` 的 `resolveOwnerConfigSnapshot` 装配）。
- 判定还需 `authConfig.isEnabled()`（`--token` 或 `PD_CONSOLE_TOKEN`）：`configured = authEnabled && ownerId && credentialId`。
- `.pd/config.yaml` schema **无 owner 键**；安装器 `create-principles-disciple` 零提及；pd-cli 无 owner 命令；Settings 页零提及；全库仅内部报告 `docs/implementation-reports/governance-experience-audit.md:72` 提到 `PD_OWNER_ID`。
- PR-3-B（#1446）已交付**引导命令 + 文档**（Focus 页可复制命令、`docs/runbooks/ops/owner-identity-configuration.md`）——那是引导，不是登记。

## 2. Decision

引入**安装级** Owner 身份登记文件 `~/.pd/owner.json`（host-neutral，复用 PRI-583 的 `~/.pd/` 布局），环境变量保持最高优先级。所有身份解析收敛到**单一 `OwnerIdentityResolver`**：

```
PD_OWNER_ID + PD_OWNER_CREDENTIAL_ID（env，最高——CI/运维场景）
  → ~/.pd/owner.json（安装级，人通过控制台/CLI 登记）
  → none
```

`owner.json` 形状：

```json
{ "schemaVersion": 1, "ownerId": "<owner-id>", "credentialId": "<credential-id>", "registeredAt": "2026-08-29T00:00:00.000Z" }
```

### 2.1 owner.json 不存什么（ADR-0016 §2.2 / §2.3 约束）

- `credentialId` 是 Owner 的**凭据标识**（用于身份展示/审计的 ID），**不是密钥本身**——语义与现有环境变量 `PD_OWNER_CREDENTIAL_ID` 一致（代码里只做非空判断）。
- **任何密钥/令牌值都不落盘**。若未来确需真正的凭据值，保持 env-only（或按 ADR-0016 §2.3 的 `apiKeyEnv` 模式只存环境变量名引用）。
- **ERR-045 预期行为**：字段名含 `credential` 段（`SECRET_KEY_SEGMENTS` 于 `pd-config-store.ts:49`），任何日志/配置回显路径都会自动脱敏该字段值——这是纵深防御，**不得**为了"绕过"脱敏而改名。控制台 UI 仍可展示该值（脱敏只作用于诊断/日志路径）。

### 2.2 作用域：安装级，非工作区级

Owner 是**人的身份**，不是某个工作区的属性：

- `~/.pd/` 是安装级目录（PRI-583：`install.json`、`runtime/`；ADR-0021 的 `product-telemetry.json` 同为机器级作用域先例）。
- 工作区级 `.pd/config.yaml` 保持工作区作用域；Owner 身份不得随工作区变化。
- 推论：登记一次，覆盖该安装上的所有工作区；注销 = 删除文件。

### 2.3 单一解析器（AGENTS.md P4）

用 `OwnerIdentityResolver` 替换 6 处零散 `process.env` 直读：

- `governance.ts:41` 的 `resolveOwnerConfigSnapshot(authConfig, resolver)`；
- `index.ts:468`、`runtime-activation.ts:503` 改为调用 resolver。

新增读来源**不构成第二个真相**：文档化的优先级链本身就是唯一权威——与 `DEFAULT_FEATURE_FLAGS` + config 覆盖同构（已有先例）。反而把 6 处 ad-hoc 读取收敛为 1 个可测试的解析器，是对 P4 的**加固**而非违反。

### 2.4 登记表面

- 控制台 Settings 新增「拥有者身份」区块：登记/注销，展示当前来源（env / file / none）与生效优先级；提交后**需重启控制台生效**（env 仍最高，UI 需说明）。
- MVP 不做 `pd owner` CLI 命令（Owner 评审决定，2026-08-29）；`pd doctor` 检查项留待 PR-4。

### 2.5 不新增 feature flag

`~/.pd/owner.json` 的**文件存在与否本身就是天然开关**（mvp-q-3：优先复用现有控制机制）。

## 3. MVP Questions

| 问 | 答 |
|---|---|
| q-1 skip 后果 | Owner 身份永远只能靠读源码/内部报告才配得出来；PRI-578 会在 30 天内再次被提出（2026-08-24 已提过一次） |
| q-2 观察方式 | Settings 显示「拥有者身份：已配置（来源 ~/.pd/owner.json）」；登记并重启后 Focus 页身份行变「已配置」，`rulecode_owner_decision` 不再被 `owner_identity_missing` 阻塞 |
| q-3 回滚 | 删除 `~/.pd/owner.json` 即回到未配置（env 未设时）；无需新 feature flag |
| q-4 情绪价值 | 降低失控感/不信任感——Owner 有真正的登记路径，而不是逆向工程环境变量 |

## 4. Consequences

正面：

- PRI-578 对交互式安装首次有了**真正的登记入口**（方案 A）。
- CI/运维场景的 env 用法不变（优先级最高），无破坏。
- 6 处零散 env 读收敛为 1 个可测试解析器（P4 加固）。
- Host-neutral（复用 PRI-583 布局）、跨工作区覆盖。

负面：

- 新增 `~/.pd/owner.json`——需在文档/安装器说明中提及（对已有 env 用户无迁移负担：env 继续生效）。
- env 与文件并存时以 env 为准——解析器优先级即文档；UI 展示来源避免困惑。
- `credentialId` 字段在日志中被 ERR-045 脱敏是**预期行为**，不得"修复"。

## 5. Non-Goals

- 不存储真正的凭据/令牌值。
- 不做工作区级 Owner 身份（人 ≠ 工作区）。
- 不做 env → 文件的自动迁移（env 设置期间始终优先）。
- 不新增 feature flag。
- 范围外：`pd doctor` 加 Owner 检查项（PR-4，单独）；文档落地（PR-3-B 已交付 runbook）。

## 6. 评审结论（2026-08-29 Owner 确认，ADR 由 Proposed → Accepted）

1. ✅ `credentialId` 按**标识符（非密钥）**处理，允许明文落盘（符合 ADR-0016 §2.3「存引用不存值」先例）；密钥值保持 env-only。
2. ✅ **安装级**作用域 `~/.pd/owner.json`（Owner 是人的身份，非工作区属性）。
3. ✅ 单一解析器 + 文档化优先级链**不违反 P4**（收敛即加固）。
4. ✅ MVP 只做控制台 Settings 入口；不做 `pd owner` CLI 命令。
