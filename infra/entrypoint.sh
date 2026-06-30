#!/bin/sh
# 一镜像四入口分叉（O-01）：按 PROCESS 选择启动哪个 Node 进程入口。
# api（默认）= Fastify HTTP；worker = BullMQ 消费；consumer = outbox 保序消费；sweeper = 后台对账。
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
  consumer)
    exec node apps/authoring/dist/processes/consumer.js
    ;;
  sweeper)
    exec node apps/authoring/dist/processes/sweeper.js
    ;;
  *)
    echo "[entrypoint] unknown PROCESS='$PROCESS' (expected api|worker|consumer|sweeper)" >&2
    exit 64
    ;;
esac
