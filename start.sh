#!/bin/sh
# 启动本地提示词库。既可手动运行，也由 launchd 常驻任务调用。
set -eu
cd "$(dirname "$0")"
NODE_BIN="${PLIB_NODE:-node}"
if [ ! -f data/library.db ]; then
  "$NODE_BIN" --disable-warning=ExperimentalWarning scripts/import.mjs
fi
# exec 让 launchd 直接跟踪 Node 进程，崩溃时能准确拉起，不留下中间 npm/shell 进程。
exec "$NODE_BIN" --disable-warning=ExperimentalWarning server.mjs
