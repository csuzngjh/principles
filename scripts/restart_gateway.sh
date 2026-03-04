#!/bin/bash
# OpenClaw Gateway - Hard Restart Script
# --------------------------------------

echo "🦞 Principles Disciple - OpenClaw Hard Restart"
echo "------------------------------------------"

# 1. 尝试通过 systemd 优雅停止
echo "⏹️  Stopping openclaw-gateway.service..."
systemctl --user stop openclaw-gateway.service 2>/dev/null || true

# 2. 强力清理所有残留的 OpenClaw/Node 进程
# 这是解决“重启卡住”的关键步骤
echo "🔪 Cleaning up zombie processes..."
ps aux | grep openclaw | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null || true
ps aux | grep node | grep openclaw | awk '{print $2}' | xargs kill -9 2>/dev/null || true

# 3. 等待端口释放
echo "⏳ Waiting for port 18789 to be released..."
sleep 2

# 4. 重新启动服务
echo "🚀 Launching Gateway..."
# 使用 openclaw 原生命令启动，它会自动处理工作区加载
openclaw gateway start

echo "------------------------------------------"
echo "✅ Restart complete!"
echo "💡 Hint: Wait 5 seconds, then run 'openclaw plugins list' to verify."
