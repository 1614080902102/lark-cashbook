#!/bin/bash
# launchd 用的 node 启动器：运行时加载 nvm，用当前 default 版本的 node 跑目标脚本。
# 这样定时任务永远跟随 nvm default 别名，升级 node 后无需重装 plist。
# 同时 nvm 会把 node 目录前插进 PATH，子进程（如 lark-cli 的 `env node`）也能找到 node。
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
exec node "$@"
