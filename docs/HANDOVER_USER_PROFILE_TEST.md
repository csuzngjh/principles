# 工作交接文档：用户画像与反盲从机制测试

## 1. 任务背景
为了修复系统架构中的 **归因断点 (Attribution Breakpoint)** 和实现 **反盲从 (Anti-Sycophancy)**，我们构建了一套用户画像闭环系统。
该系统允许主智能体根据用户指令的质量（Accept/Reject），自动调整用户在各领域的可信度分值，并记录用户的交互偏好。

## 2. 涉及变更
我们修改/创建了以下核心脚本：
- **`.claude/hooks/stop_evolution_update.sh`**: 
  - 新增逻辑：读取 `.user_verdict.json`（增量评价），使用 `jq` 将其累加合并到 `USER_PROFILE.json`（主数据库）。
  - 功能：实现分数的原子化累加、偏好的覆盖更新、历史记录的滚动保存。
- **`.claude/hooks/sync_user_context.sh`**: 
  - 新增逻辑：读取 `USER_PROFILE.json` 中的 `preferences` 字段。
  - 功能：将 JSON 数据编译为 `USER_CONTEXT.md` 中的自然语言指令（供 AI 阅读）。

## 3. 测试任务
需要验证这套“生产-处理-消费”的数据流是否通畅，特别是复杂的 `jq` 合并逻辑是否正确。

请创建并运行以下测试脚本 `tests/test_user_profile_loop.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== 集成测试：用户画像闭环 (User Profile Loop) ==="
echo ""

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

PROFILE="docs/USER_PROFILE.json"
VERDICT="docs/.user_verdict.json"
CONTEXT="docs/USER_CONTEXT.md"
HOOK_STOP=".claude/hooks/stop_evolution_update.sh"
HOOK_SYNC=".claude/hooks/sync_user_context.sh"

# 清理与初始化
rm -f "$PROFILE" "$VERDICT"
mkdir -p docs

# Step 1: 初始化空画像
echo '{"domains":{"frontend":0},"preferences":{},"history":[]}' > "$PROFILE"

# Step 2: 模拟 LLM 生成增量评价 (Mocking Step 9 of evolve-task)
echo "👉 Generating verdict..."
cat > "$VERDICT" <<EOF
{
  "updates": [
    {"domain": "frontend", "delta": 2, "reason": "Good React fix"},
    {"domain": "backend", "delta": -1, "reason": "Bad SQL"}
  ],
  "preferences": {
    "language": "zh-CN",
    "verbosity": "brief"
  }
}
EOF

# Step 3: 运行 Stop Hook (处理端)
echo "👉 Running stop_evolution_update.sh..."
bash "$HOOK_STOP"

# 验证 1: 分数累加
frontend_score=$(jq -r '.domains.frontend' "$PROFILE")
backend_score=$(jq -r '.domains.backend' "$PROFILE")

if [[ "$frontend_score" -eq 2 && "$backend_score" -eq -1 ]]; then
  echo "  ✅ Score accumulation passed (Frontend: $frontend_score, Backend: $backend_score)"
else
  echo "  ❌ Score accumulation failed"
  exit 1
fi

# 验证 2: 偏好合并
lang=$(jq -r '.preferences.language' "$PROFILE")
if [[ "$lang" == "zh-CN" ]]; then
  echo "  ✅ Preference merge passed"
else
  echo "  ❌ Preference merge failed"
  exit 1
fi

# Step 4: 运行 Sync Hook (消费端)
# Stop hook 内部应该已经触发了一次 sync，但我们这里显式跑一次确保测试覆盖
echo "👉 Running sync_user_context.sh..."
bash "$HOOK_SYNC"

# 验证 3: 上下文生成
if grep -q "Language: zh-CN" "$CONTEXT"; then
  echo "  ✅ Context generation passed (Found preference instruction)"
else
  echo "  ❌ Context generation failed (Missing preference)"
  exit 1
fi

echo ""
echo "🎉 All tests passed."
```

### 预期结果
所有验证步骤均应输出 `✅ ... passed`。

## 4. 关键文件路径
- Hook 1: `.claude/hooks/stop_evolution_update.sh`
- Hook 2: `.claude/hooks/sync_user_context.sh`
- 数据库: `docs/USER_PROFILE.json`
