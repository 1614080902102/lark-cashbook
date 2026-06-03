#!/bin/bash
# 安装财务定时任务（macOS launchd）：
#   com.larkcashbook.remind  每天 22:00  -> remind.js（记账提醒）
#   com.larkcashbook.report  每天 23:59  -> run_scheduled.js（日报 / 周报(周日) / 月报(月末)）
# 重复运行可覆盖更新。
set -euo pipefail

PROJ_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
LAUNCHER="$PROJ_DIR/scripts/node-launcher.sh"
LARK_DIR="$(dirname "$(command -v lark-cli)")"
LA_DIR="$HOME/Library/LaunchAgents"
LOG="$PROJ_DIR/logs/push.log"
mkdir -p "$PROJ_DIR/logs" "$LA_DIR"

if [ -z "$NODE_BIN" ]; then echo "找不到 node"; exit 1; fi
echo "node: $NODE_BIN"
echo "lark-cli dir: $LARK_DIR"
echo "project: $PROJ_DIR"

# 参数：label  脚本名  Hour  Minute
make_job() {
  local label="$1" script="$2" hour="$3" minute="$4"
  local plist="$LA_DIR/$label.plist"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$LAUNCHER</string>
    <string>$PROJ_DIR/scripts/$script</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJ_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$LARK_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$hour</integer>
    <key>Minute</key><integer>$minute</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
  echo "已安装: $label ($hour:$(printf '%02d' "$minute")) -> $plist"
}

make_job com.larkcashbook.remind remind.js 22 0
make_job com.larkcashbook.report run_scheduled.js 23 59

echo "完成。日志写到 $LOG"
echo "查看状态: launchctl list | grep com.larkcashbook"
