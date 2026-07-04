#!/bin/sh
# 一镜像两入口分叉：按 PROCESS 选择启动哪个 Node 进程入口。
# api（默认）= Fastify HTTP；worker = BullMQ 消费 + 租约对账。
# 任何无效 PROCESS 直接报错退出（不静默起错进程）。
set -eu

PROCESS="${PROCESS:-api}"

case "$PROCESS" in
  api)
    exec node apps/authoring/dist/processes/api.js
    ;;
  worker)
    exec node apps/authoring/dist/processes/worker.js
    ;;
  *)
    echo "[entrypoint] unknown PROCESS='$PROCESS' (expected api|worker)" >&2
    exit 64
    ;;
esac
