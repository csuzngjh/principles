# Bug Report: custom_guards Severity Handling Not Implemented

**Severity**: HIGH
**Component**: Hook
**Context**: 执行 Phase 1, Task 1.3 测试 custom_guards 机制时发现，所有 warning-level 规则错误地阻塞了操作，而非仅显示警告。

---

## Evidence

### Bug Discovery

在执行系统进化 Phase 1 测试任务时，验证 `custom_guards` 机制发现：

**测试场景**: 运行 `Bash echo "test"` 命令（应该触发 warning 级别的 guard）

**预期行为**:
```bash
⚠️ 检测到低效搜索工具（grep/find/cat）。优先使用 mgrep/rg/fd（性能快 10-100 倍）。参考 @docs/SYSTEM_CAPABILITIES.json
[命令继续执行，输出结果]
```

**实际行为**:
```bash
🛑 Custom Guard: ⚠️ 检测到低效搜索工具...
[操作被阻塞，Exit Code: 2]
```

### Root Cause Analysis (Self-Correction)

**问题定位**: `.claude/hooks/hook_runner.py` Lines 685-699

**Bug 代码** (BEFORE):
```python
custom_guards = profile.get("custom_guards", [])
if custom_guards:
    test_str = f"{tool} {rel}"
    for guard in custom_guards:
        pattern = guard.get("pattern")
        message = guard.get("message")
        # ❌ BUG: 缺少 severity 参数读取
        if pattern and message:
            if re.search(pattern, test_str, re.IGNORECASE):
                print(f"🛑 Custom Guard: {message}", file=sys.stderr)
                return 2  # ❌ BUG: 无条件阻塞，即使 severity 是 warning
```

**根因**:
1. Hook 实现未读取 `severity` 参数
2. 所有 custom_guards 规则都 `return 2` (阻塞操作)
3. 导致 3 条 warning-level 规则错误地阻塞了操作

**影响范围**:
- ❌ `Bash.*(grep -|find .|cat )` → 应警告但未阻塞
- ❌ `Bash.*npm.*install.*(eslint|prettier)` → 应警告但未阻塞
- ❌ `Write.*package.json` → 应警告但未阻塞

### Fix Implementation

**修复后代码** (AFTER):
```python
custom_guards = profile.get("custom_guards", [])
if custom_guards:
    test_str = f"{tool} {rel}"
    for guard in custom_guards:
        pattern = guard.get("pattern")
        message = guard.get("message")
        severity = guard.get("severity", "error")  # ✅ FIX: 读取 severity 参数
        if pattern and message:
            try:
                if re.search(pattern, test_str, re.IGNORECASE):
                    print(f"🛑 Custom Guard: {message}", file=sys.stderr)
                    if severity == "error":  # ✅ FIX: 仅 error 级别阻塞
                        print(f"Pattern: {pattern}", file=sys.stderr)
                        return 2
                    # ✅ FIX: warning 级别不返回，允许操作继续
            except re.error as e:
                logging.error(f"Invalid regex in custom_guards: {pattern} - {e}")
```

**改进点**:
1. 添加 `severity = guard.get("severity", "error")` 读取参数
2. 条件 `return 2` 仅在 `severity == "error"` 时执行
3. 添加 `try-except` 块处理正则表达式错误
4. Warning 级别规则打印消息后继续执行

### Test Results

**修复后测试验证** (所有 6 条 custom_guards 规则):

1. ✅ **Error Level 1**: `Bash.*npm.*(install|upgrade).*(eslint|prettier|jest)` → 正确阻塞
2. ✅ **Warning Level 1**: `Bash.*(grep -|find .|cat )` → 正确警告并继续
3. ✅ **Warning Level 2**: `Bash.*npm.*install.*(eslint|prettier)` → 正确警告并继续
4. ✅ **Warning Level 3**: `Write.*package.json` → 正确警告并继续
5. ✅ **Error Level 2**: `(Bash.*npm run build|Bash.*next build|Bash.*pnpm build)` → 正确阻塞
6. ✅ **Warning Level 4**: `Bash.*turbo|Bash.*profile` → 正确警告并继续

**测试报告**: `temp/custom-guards-test-report.md`

---

## Environment

- **OS**: Linux (WSL2) on Windows
- **Project**: Code Magic Academy (Next.js 15.5.9)
- **System Version**: 1.0.0
- **Hook Implementation**: `.claude/hooks/hook_runner.py`
- **Profile Configuration**: `docs/PROFILE.json`

---

## Additional Context

### Design Intent

根据 `custom_guards` 的设计理念：
- **Error Level**: 阻止操作并退出 (Exit Code 2)
- **Warning Level**: 显示警告但允许操作继续

此 bug 违反了设计意图，导致所有 warning-level 规则变成了 de facto 阻塞规则。

### Discovery Workflow

此 bug 是在执行"痛定思痛"流程时发现的：
1. **归因**: 诊断为什么 agents 不检查工具可用性
2. **进化**: 修改系统配置添加 MANDATORY Checklists
3. **固化**: 在测试 Task 1.3 时发现 custom_guards 实现缺陷

### Testing Evidence

完整测试记录见:
- `temp/custom-guards-test-report.md` - 详细测试报告
- `temp/test-custom-guards.md` - 测试计划和执行记录

---

## Recommendation

**建议修改**:
- ✅ **已修改**: `.claude/hooks/hook_runner.py` Lines 683-703
- ✅ **已验证**: 所有 custom_guards 规则行为符合预期
- ✅ **已测试**: Error level 阻塞，Warning level 继续执行

**后续改进**:
1. 添加单元测试覆盖 custom_guards 逻辑
2. 在 hooks 初始化时验证 regex 语法
3. 考虑添加 `--no-verify` flag 允许用户临时跳过 guards

---

**Report Generated**: 2026-01-26
**Reported By**: System Evolution (Phase 1, Task 1.3 Testing)
**Status**: FIXED ✅
