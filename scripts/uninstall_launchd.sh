#!/bin/bash
# 卸载财务报告定时任务（含早期版本的 daily/weekly/monthly 三任务）。
set -euo pipefail
LA_DIR="$HOME/Library/LaunchAgents"
for label in com.larkcashbook.remind com.larkcashbook.report com.larkcashbook.daily com.larkcashbook.weekly com.larkcashbook.monthly; do
  plist="$LA_DIR/$label.plist"
  if [ -f "$plist" ]; then
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    echo "已卸载并删除: $label"
  fi
done
echo "完成。"
