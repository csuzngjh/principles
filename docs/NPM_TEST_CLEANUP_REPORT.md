# NPM 测试配置清理报告

## 清理时间
2026-01-22

## 问题背景

### 发现的问题
用户观察到 `PostToolUse:Edit hook error`，退出码 254。

### 根本原因
1. `docs/PROFILE.json` 配置了自动测试：`"smoke": "npm test --silent"`
2. 每次 Write/Edit 操作后，`post_write_checks.sh` 会运行测试
3. 但项目根目录没有 `package.json`（这是一个纯 Claude 插件配置项目）
4. npm 找不到 package.json，报错 ENOENT，退出码 254
5. Hook 检测到失败，写入 `.pain_flag` 并报错

这导致了交接文档中提到的 **"Pain 洪水"** 问题：即使修改与测试无关的文件（如 markdown 文档），也会因为测试配置不存在而触发失败标记。

## 清理方案

### 原则
- 保留核心门禁功能（audit_level, risk_paths, gate）
- 移除测试相关配置（因为没有 npm/package.json）
- 修改 hook 脚本，在没有测试配置时静默跳过

### 修改清单

#### 1. docs/PROFILE.json
**移除内容**:
```json
"tests": {
  "on_change": "smoke",
  "on_risk_change": "unit",
  "commands": {
    "smoke": "npm test --silent",
    "unit": "npm test",
    "full": "npm test"
  }
},
"permissions": {
  "deny_skip_tests": true,  // 已移除
  "deny_unsafe_db_ops": true
}
```

**保留内容**:
```json
{
  "audit_level": "medium",
  "risk_paths": ["src/server/", "infra/", "db/"],
  "gate": {
    "require_plan_for_risk_paths": true,
    "require_audit_before_write": true
  },
  "permissions": {
    "deny_unsafe_db_ops": true
  }
}
```

#### 2. docs/ISSUE_LOG.md
- 清理了所有 npm test 相关的错误记录（3条）
- 重置为干净的模板状态

#### 3. .claude/hooks/post_write_checks.sh
**新增检查**:
```bash
# 检查是否配置了测试（如果没有 tests section 或 commands section，跳过测试）
if ! jq -e '.tests' "$PROFILE" > /dev/null 2>&1; then
  # 没有 tests 配置，静默跳过
  exit 0
fi

if ! jq -e '.tests.commands' "$PROFILE" > /dev/null 2>&1; then
  # 没有 tests.commands 配置，静默跳过
  exit 0
fi
```

**效果**:
- 如果 PROFILE.json 中没有 tests 或 tests.commands 配置，脚本会静默退出
- 不会报错，不会写入 pain_flag
- Edit/Write 操作正常完成

## 验证结果

### 测试场景
```bash
echo '{"tool_name":"Edit","tool_input":{"file_path":"/mnt/d/code/principles/test.txt"}}' | \
  bash .claude/hooks/post_write_checks.sh
```

### 测试结果
- ✅ 退出码: 0
- ✅ 没有报错
- ✅ 没有 pain_flag 生成

## 备份文件

清理过程中创建的备份：
- `docs/PROFILE.json.backup` - 原始配置
- `docs/ISSUE_LOG.md.backup` - 原始日志

如需恢复：
```bash
mv docs/PROFILE.json.backup docs/PROFILE.json
mv docs/ISSUE_LOG.md.backup docs/ISSUE_LOG.md
```

## 后续建议

### 如果将来需要添加测试
1. 确保项目有对应的测试框架（如 pytest、jest 等）
2. 更新 PROFILE.json 添加 tests 配置
3. 确保 `post_write_checks.sh` 中的测试命令可以执行

### 示例（Python 项目）
```json
{
  "tests": {
    "on_change": "smoke",
    "on_risk_change": "unit",
    "commands": {
      "smoke": "pytest -q",
      "unit": "pytest",
      "full": "pytest --cov"
    }
  }
}
```

## 核心价值

### 修复前
- ❌ 每次 Edit/Write 都触发 npm test 错误
- ❌ 生成无意义的 pain_flag
- ❌ 用户看到 "PostToolUse hook error"

### 修复后
- ✅ Edit/Write 操作正常完成
- ✅ 没有测试错误干扰
- ✅ 保留核心门禁功能

## 总结

✅ **成功解决了 "Pain 洪水" 问题**

通过清理不适用的测试配置，系统现在：
1. 不再因 npm test 配置而报错
2. 保留了核心的门禁和审计功能
3. Edit/Write 操作流畅无阻碍

---
**执行人**: Claude Code  
**执行时间**: 2026-01-22  
**状态**: ✅ 完成
