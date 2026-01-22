# Guardrails (Executable)

以下是可执行红线规则，任何情况下都不得违反：

## 测试红线
- 不允许跳过测试（除非 `docs/PROFILE.json` 的 `permissions.deny_skip_tests=false`）
- 任何代码改动必须有对应的验证步骤

## 数据安全红线
- 不允许执行破坏性 DB 操作（INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE 等）
- 不允许删除用户数据或配置文件（除非有明确的备份和回滚方案）

## 门禁红线
- 修改 `docs/PROFILE.json` 中 `risk_paths` 内的文件前：
  - 必须有 `docs/PLAN.md`（STATUS 不为 DRAFT）
  - 必须有 `docs/AUDIT.md`（RESULT 为 PASS）

## 可回滚性红线
- 所有改动必须可回滚：在 `docs/PLAN.md` 中写明 rollback 步骤
- 任何配置变更必须保留旧版本或提供恢复命令

## 权限红线
- 不允许绕过 hooks 的阻断（exit 2）
- 不允许修改 `.claude/rules/00-kernel.md`（内核规则是不变量）
