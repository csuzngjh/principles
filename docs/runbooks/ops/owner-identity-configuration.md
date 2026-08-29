# Owner 身份配置（PD_OWNER_ID / PD_OWNER_CREDENTIAL_ID / ~/.pd/owner.json）

> **状态**: Active
> **最后更新**: 2026-08-29
> **关联代码**: `principles-core/src/runtime-v2/owner-identity.ts`（单一 resolver）、`pd-console/src/server/routes/owner-identity.ts`（登记 API）、`pd-console/src/server/routes/governance.ts`（`resolveOwnerConfigSnapshot`）、`pd-cli/src/commands/runtime-activation.ts`
> **关联工单**: PRI-578（Owner 身份引导式登记入口）、PRI-584~587（治理体验快照）
> **适用角色**: Owner / 控制台运维

---

## 1. 这是什么

Owner 身份是 PD 治理体系中的**唯一权威决策者**。ADR-0022 定义了唯一的身份解析链（single resolver）：

```
完整 env 对（PD_OWNER_ID + PD_OWNER_CREDENTIAL_ID 都已设置且非空）
  →  ~/.pd/owner.json（安装级文件登记，Console Settings 写入）
  →  无身份
```

- `PD_OWNER_ID`：Owner 的标识（如 `owner@example.com` 或 `owner-alice`）。
- `PD_OWNER_CREDENTIAL_ID`：Owner 的凭据**标识/引用**——不是密钥本身；真正的秘密是控制台 token（`--token` / `PD_CONSOLE_TOKEN`）或未来的凭据值。

### 身份解析真值表（fail-closed）

| 场景 | 结果 |
| --- | --- |
| 两个 env 变量都不存在 | 读取 `~/.pd/owner.json`；文件也没有 → 无身份 |
| 两个 env 变量都设置且非空 | 使用 env 身份（最高优先级） |
| 只设置了其中一个（哪怕另一个非空在文件里） | **无效（invalid_env），fail-closed**——绝不回退到文件身份 |
| 任一 env 变量被显式设置但为空/纯空白 | 同上，视为一次无效的 env override 尝试 |
| `~/.pd/owner.json` 读取失败（非「不存在」的文件系统错误） | 返回可诊断错误（`owner_identity_read_failed`），**绝不**解释成「未登记」 |

部分 env 对绝不能静默回退文件身份：运维可能正在把身份从旧 Owner（磁盘上的 owner.json）迁移到新 Owner（env），漏配一个变量时 PD 继续以旧 Owner 身份执行治理是权限归属事故。fail-closed 时 `ownerIdentityConfiguration` 一律为 `missing`。

### 登记存在 ≠ 治理就绪（两个独立概念）

- **Registration（登记）**：身份从哪来——env / file / 无 / env 配置无效。
- **Governance readiness（治理就绪）**：当前能否执行 Owner 治理动作。在身份完整之外，还要求：

```
ownerIdentityConfiguration = 身份解析有效 && 控制台令牌认证已启用 ? 'configured' : 'missing'
```

即**三个条件缺一不可**：

1. 身份解析有效（完整 env 对，或文件登记；部分 env 对无效）；
2. **PD 控制台的令牌认证已启用**——启动 `pd-console` 时传 `--token <value>`，或设置环境变量 `PD_CONSOLE_TOKEN`；
3. env 变量变更需重启控制台（env 只在进程启动时读取；文件登记即时生效，每次调用都会重新解析）。

Console Settings 的「Owner identity」区块会分别显示 Registration（登记来源）与 Governance（就绪状态 + 未就绪原因和下一步动作）。

## 2. 什么时候需要配

- 治理体验快照（Focus 页）显示「拥有者身份：未配置」；
- Console Settings 显示 Registration 已登记但 Governance 未就绪；
- RuleCode 决策入口被阻塞，原因 `owner_identity_missing`；
- 需要行使 Owner 治理动作：审批/晋升 RuleCode 激活、紧急暂停等。

## 3. 如何配置

**推荐路径：Console Settings → Owner identity 区块**，填入 Owner ID 与 Credential ID 后点「登记」，写入 `~/.pd/owner.json`（仅存标识符，不含密钥，文件权限 0600）。也可以手动放置该文件，schema（`schemaVersion: 1`，含 `ownerId` / `credentialId` / `registeredAt`）以 `principles-core/src/runtime-v2/owner-identity.ts` 为准。

CI / 自动化场景改用 env 对（设置后**必须重启** OpenClaw 与 PD 控制台）：

> 占位符 `<owner-id>` / `<credential-id>` 换成你自己的值。

### Windows（PowerShell，用户级持久化）

```powershell
[Environment]::SetEnvironmentVariable('PD_OWNER_ID', '<owner-id>', 'User')
[Environment]::SetEnvironmentVariable('PD_OWNER_CREDENTIAL_ID', '<credential-id>', 'User')
```

写入的是当前 Windows 用户的持久环境变量，新开的进程都会继承。

### macOS / Linux（bash，写入 profile）

```bash
echo 'export PD_OWNER_ID="<owner-id>"' >> ~/.bashrc
echo 'export PD_OWNER_CREDENTIAL_ID="<credential-id>"' >> ~/.bashrc
source ~/.bashrc
```

使用 zsh 的用户把 `~/.bashrc` 换成 `~/.zshrc`。

### 启用控制台令牌认证

```bash
# 启动 pd-console 时带 --token，或设置环境变量
export PD_CONSOLE_TOKEN="<console-token>"
```

## 4. 如何验证

1. 重启 OpenClaw 与 PD 控制台；
2. 打开 Console Settings → Owner identity：Registration 显示登记来源（environment / `~/.pd/owner.json` / 未登记 / 环境变量配置无效），Governance 显示「就绪」或「未就绪 + 原因 + 下一步动作」；
3. Focus 页 → 治理体验摘要 → 身份行显示「拥有者身份：已配置」；
4. 治理动作明细中 `rulecode_owner_decision` 不再因 `owner_identity_missing` 被阻塞。

若出现 `owner_identity_invalid_env`：补齐或成对删除 env 变量后重启；此时文件登记同样不生效，属预期 fail-closed 行为。

## 5. 安全注意

- `PD_CONSOLE_TOKEN` 是**敏感凭据**：不要提交进代码仓库、不要写进共享的配置文件、不要出现在截图或进程列表中。
- `PD_OWNER_CREDENTIAL_ID` 是凭据的**标识符/引用**（非密钥本身，见 ADR-0022）：它用于身份展示与审计，本身可随 `~/.pd/owner.json` 明文存放、可在控制台展示；但它字段名含 `credential` 段，仍会被 ERR-045 在日志/配置回显路径自动脱敏——这是纵深防御，属预期行为。
- **绝不要**把真正的 token/密钥写进 `~/.pd/owner.json`——该文件只存标识符。
- 环境变量属于主机级配置，**不要**把它们写进 `.pd/config.yaml`（该文件不是凭据存放处）。
- 撤销 Owner 身份：删除 `~/.pd/owner.json`（Console Settings 的「注销」按钮或手动删除）或移除对应环境变量（env 方式）并重启即可；无需其他操作。

## 6. 与其他文档的关系

- 治理体验快照的完整解释：`docs/implementation-reports/governance-experience-audit.md`（内部报告）。
- RuleHost 日常运维（激活、回滚、排障）：`docs/runbooks/ops/rulehost-owner-runbook.md`。
