#!/bin/sh
# 一次性 minio_mc 容器入口（O-02）：建 ObjectStore 四桶（70 §8.2）。minio healthy 后跑、跑完退。幂等可重入。
# 四桶：agora-raw（去敏快照）/ agora-artifacts（产物）/ agora-exports（导出）/ agora-experience（经验体语料）。
set -eu

S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}"
S3_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
S3_SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"

# 配置别名（重试等待 minio 起来；healthcheck 已 gate，这里只做容错重试）
i=0
until mc alias set local "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "[init-buckets] cannot reach minio at $S3_ENDPOINT" >&2
    exit 1
  fi
  sleep 2
done

for bucket in agora-raw agora-artifacts agora-exports agora-experience; do
  # mb 已存在不报错（--ignore-existing → 幂等）
  mc mb --ignore-existing "local/${bucket}"
  echo "[init-buckets] ensured bucket '${bucket}'"
done

echo "[init-buckets] done"
