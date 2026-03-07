#!/usr/bin/env bash
set -euo pipefail

# PreCompact Hook
# 触发时机：上下文即将被压缩（自动或手动）
# 目标：触发“痛定思痛”机制，防止在遗忘前丢失重要的负反馈信号

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
ISSUE_LOG="$PROJECT_DIR/docs/ISSUE_LOG.md"
PLAN="$PROJECT_DIR/docs/PLAN.md"
CHECKPOINT="$PROJECT_DIR/docs/CHECKPOINT.md"

# 1. 基础 Checkpoint (物理状态备份)
mkdir -p "$PROJECT_DIR/docs"
touch "$CHECKPOINT"
{
  echo "# Checkpoint [$(date -Iseconds)]"
  echo "Context compaction triggered."
} > "$CHECKPOINT"

# 2. 痛苦预判 (Heuristic Pain Detection)
# 脚本无法做高阶反思，但可以检测“物理指标”作为提示

pain_detected="false"
pain_reasons=""

# 指标A: Plan 状态滞后
# 如果 Plan 存在但不是 READY，或者还在 DRAFT，说明任务还没想清楚就做了很久
if [[ -f "$PLAN" ]]; then
  if grep -q "STATUS: DRAFT" "$PLAN"; then
    pain_detected="true"
    pain_reasons+=" - PLAN is still in DRAFT status after long context.\n"
  fi
fi

# 指标B: 频繁报错
# 检查 AUDIT_TRAIL.log (如果存在) 最近是否有大量 exit code != 0
# 这里简化处理：检查 .pain_flag 是否存在
if [[ -f "$PROJECT_DIR/docs/.pain_flag" ]]; then
  pain_detected="true"
  pain_reasons+=" - Unresolved pain flag detected.\n"
fi

# 3. 输出引导信息 (Metacognitive Trigger)
# 这部分 stdout 会显示给用户，也会留在压缩前的最后记忆中

echo "⚠️  **Context Compaction Triggered** ⚠️"
echo ""
echo "System is about to compress memory. Before details are lost:"

if [[ "$pain_detected" == "true" ]]; then
  echo "🚨 **Potential Pain Detected:**"
  echo -e "$pain_reasons"
  echo "👉 **RECOMMENDATION**: Run \
/reflection\n NOW."
  echo "   Use the reflection skill to capture why we are stuck before flushing memory."
  
  # 强制写入一个临时的提示文件，确保 SessionStart 能看到（如果是自动压缩后重启）
  echo "Pending Reflection: Compaction triggered while task was unstable." > "$PROJECT_DIR/docs/.pending_reflection"
else
  echo "✅ Status looks stable. Saving checkpoint."
  echo "   (Optional: Run \
/reflection\n if you feel the task went poorly)"
fi

exit 0