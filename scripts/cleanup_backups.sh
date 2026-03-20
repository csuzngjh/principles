#!/bin/bash
# 备份目录
BACKUP_DIR="/home/csuzngjh/clawd/.backups"
# 备份文件名模式
PATTERN="*-openclaw-backup.tar.gz"

# 统计并清理旧备份
echo "Checking for old OpenClaw backups in $BACKUP_DIR..."
# 按修改时间从新到旧排序，跳过最新的第一个文件，其余全部删除
ls -t $BACKUP_DIR/$PATTERN | tail -n +2 | xargs -r rm -v

echo "Cleanup complete. Latest backup preserved."
