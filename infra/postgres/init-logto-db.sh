#!/bin/sh
# postgres 首次启动钩子（docker-entrypoint-initdb.d）：建 Logto 独立库（与业务库 agora 同实例、不同 database，技术方案 §6.1）。
# 幂等：库已存在则跳过。仅首次卷为空时由官方 entrypoint 调用一次。
set -eu

LOGTO_DB="${LOGTO_DB:-logto}"

# psql 由官方 postgres 镜像提供；POSTGRES_USER/POSTGRES_DB 为 entrypoint 注入的超级用户上下文。
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
SELECT 'CREATE DATABASE ${LOGTO_DB}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${LOGTO_DB}')\gexec
SQL

echo "[init-logto-db] ensured database '${LOGTO_DB}' exists"
