#!/usr/bin/env bash
# 恢复固定 Cloud Review 槽位的预览专属 Secret。
# 只接受 combo-preview 自己的主机备份或工作负载环境；绝不读取生产 namespace。
set -euo pipefail

KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
NAMESPACE=combo-preview
SECRET_ROOT=/opt/combo-preview/secrets
ENV_SECRET=combo-preview-env
BOOTSTRAP_SECRET=combo-preview-bootstrap
PULL_SECRET=combo-preview-ghcr-pull
export KUBECONFIG

for command_name in chmod cp kubectl mkdir mktemp python3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "[cloud-review] Secret 恢复缺少命令：$command_name" >&2
    exit 69
  }
done

umask 077
mkdir -p "$SECRET_ROOT"
chmod 700 "$SECRET_ROOT"
raw_env_file="$(mktemp)"
filtered_env_file="$(mktemp)"
inspect_file="$(mktemp)"
candidate_env_file="$(mktemp)"
merged_env_file="$(mktemp)"
review_access_token="$(cat)"
preview_environment_captured=false
cleanup() {
  rm -f \
    "$raw_env_file" \
    "$filtered_env_file" \
    "$inspect_file" \
    "$candidate_env_file" \
    "$merged_env_file"
  unset review_access_token
}
trap cleanup EXIT

raw_environment_has_required_app_keys() {
  python3 - "$raw_env_file" <<'PY'
import sys

required = {
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "LOGTO_ISSUER",
    "LOGTO_JWKS_URI",
    "LOGTO_AUDIENCE",
}
values = {}
with open(sys.argv[1], encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.rstrip("\n")
        if "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name in required:
            values[name] = value
if any(not values.get(name) for name in required):
    raise SystemExit(1)
PY
}

extract_inspected_container_environment() {
  local workload_name="$1"
  local target_file="$2"
  python3 - \
    "$inspect_file" \
    "$target_file" \
    "$NAMESPACE" \
    "$workload_name" <<'PY'
import json
import sys

source, target, expected_namespace, expected_container = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    payload = json.load(handle)
labels = {}
for candidate in (
    payload.get("status", {}).get("labels", {}),
    payload.get("info", {}).get("config", {}).get("labels", {}),
):
    if isinstance(candidate, dict):
        labels.update(candidate)
if labels.get("io.kubernetes.pod.namespace") != expected_namespace:
    raise SystemExit(1)
if labels.get("io.kubernetes.container.name") != expected_container:
    raise SystemExit(1)
env = (
    payload.get("info", {})
    .get("runtimeSpec", {})
    .get("process", {})
    .get("env", [])
)
if not isinstance(env, list) or not env:
    raise SystemExit(1)
with open(target, "w", encoding="utf-8") as handle:
    for item in env:
        if isinstance(item, str) and "=" in item:
            handle.write(item)
            handle.write("\n")
PY
}

append_environment_fragment() {
  local source_file="$1"
  python3 - "$source_file" "$merged_env_file" <<'PY'
import sys

source, target = sys.argv[1:]
allowed = {
    "CORS_ORIGIN",
    "NODE_ENV",
    "LOG_LEVEL",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "REDIS_QUEUE_URL",
    "REDIS_HOT_URL",
    "S3_ENDPOINT",
    "S3_PUBLIC_ENDPOINT",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "S3_REGION",
    "LOGTO_ENDPOINT",
    "LOGTO_ISSUER",
    "LOGTO_JWKS_URI",
    "LOGTO_ADMIN_ENDPOINT",
    "LOGTO_DB_ALTERATION_TARGET",
    "LOGTO_APP_ID",
    "LOGTO_APP_SECRET",
    "LOGTO_REDIRECT_URI",
    "LOGTO_AUDIENCE",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "LLM_PROVIDER",
    "LLM_BASE_URL",
    "LLM_MODEL",
    "RUNTIME_LLM_PROVIDER",
    "RUNTIME_LLM_MODEL",
    "DEV_SESSION_SECRET",
}
aliases = {
    "MINIO_ROOT_USER": "S3_ACCESS_KEY",
    "MINIO_ROOT_PASSWORD": "S3_SECRET_KEY",
}
values = {}
with open(source, encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.rstrip("\n")
        if not line or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = aliases.get(name, name)
        if name in allowed and value and "\r" not in value:
            values[name] = value
if not values:
    raise SystemExit(1)
with open(target, "a", encoding="utf-8") as handle:
    for name in sorted(values):
        handle.write(f"{name}={values[name]}\n")
PY
}

capture_workload_fragment() {
  local workload_name="$1"
  local pod_name container_id

  pod_name="$(
    kubectl -n "$NAMESPACE" get pods \
      -l app="$workload_name" \
      --field-selector=status.phase=Running \
      -o 'jsonpath={.items[0].metadata.name}' 2>/dev/null || true
  )"
  if test -n "$pod_name" &&
    kubectl -n "$NAMESPACE" exec "$pod_name" -c "$workload_name" -- env > "$candidate_env_file" 2>/dev/null &&
    append_environment_fragment "$candidate_env_file"; then
    echo "[cloud-review] 找到预览 $workload_name Pod 配置片段"
    return 0
  fi

  command -v k3s >/dev/null 2>&1 || return 1
  while IFS= read -r container_id; do
    test -n "$container_id" || continue
    if ! k3s crictl inspect "$container_id" > "$inspect_file" 2>/dev/null; then
      continue
    fi
    if extract_inspected_container_environment "$workload_name" "$candidate_env_file" &&
      append_environment_fragment "$candidate_env_file"; then
      echo "[cloud-review] 找到上一代预览 $workload_name 容器配置片段"
      return 0
    fi
  done < <(k3s crictl ps -a --name "$workload_name" -q 2>/dev/null || true)

  return 1
}

print_missing_required_app_keys() {
  python3 - "$raw_env_file" <<'PY'
import sys

required = {
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "LOGTO_ISSUER",
    "LOGTO_JWKS_URI",
    "LOGTO_AUDIENCE",
}
present = set()
with open(sys.argv[1], encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.rstrip("\n")
        if "=" not in line:
            continue
        name, value = line.split("=", 1)
        if value:
            present.add(name)
missing = sorted(required - present)
print("[cloud-review] 预览配置片段仍缺少键：" + ", ".join(missing), file=sys.stderr)
PY
}

validate_public_oidc_metadata() {
  python3 - <<'PY'
import json
import sys
import urllib.request

url = "https://andkzt.logto.app/oidc/.well-known/openid-configuration"
expected = {
    "issuer": "https://andkzt.logto.app/oidc",
    "jwks_uri": "https://andkzt.logto.app/oidc/jwks",
}
try:
    with urllib.request.urlopen(url, timeout=10) as response:
        payload = json.load(response)
except Exception:
    print("[cloud-review] 无法验证预览使用的公开 OIDC metadata", file=sys.stderr)
    raise SystemExit(1)
for name, value in expected.items():
    if payload.get(name) != value:
        print(f"[cloud-review] 公开 OIDC metadata 的 {name} 不符合预期", file=sys.stderr)
        raise SystemExit(1)
PY
}

capture_preview_environment() {
  local workload_name pod_name container_id fragment_count

  if "$preview_environment_captured" && test -s "$raw_env_file"; then
    return 0
  fi

  for workload_name in api runtime; do
    pod_name="$(
      kubectl -n "$NAMESPACE" get pods \
        -l app="$workload_name" \
        --field-selector=status.phase=Running \
        -o 'jsonpath={.items[0].metadata.name}' 2>/dev/null || true
    )"
    if test -n "$pod_name" &&
      kubectl -n "$NAMESPACE" exec "$pod_name" -c "$workload_name" -- env > "$raw_env_file" 2>/dev/null &&
      raw_environment_has_required_app_keys; then
      preview_environment_captured=true
      echo "[cloud-review] 从仍在运行的预览 $workload_name Pod 恢复配置"
      return 0
    fi
  done

  command -v k3s >/dev/null 2>&1 || return 1
  for workload_name in api runtime; do
    while IFS= read -r container_id; do
      test -n "$container_id" || continue
      if ! k3s crictl inspect "$container_id" > "$inspect_file" 2>/dev/null; then
        continue
      fi
      if extract_inspected_container_environment "$workload_name" "$raw_env_file"; then
        if ! raw_environment_has_required_app_keys; then
          continue
        fi
        preview_environment_captured=true
        echo "[cloud-review] 从 K3s 保留的上一代预览 $workload_name 容器恢复配置"
        return 0
      fi
    done < <(k3s crictl ps -a --name "$workload_name" -q 2>/dev/null || true)
  done

  : > "$merged_env_file"
  fragment_count=0
  # 数据库与对象存储以仍挂载当前 PVC 的两个平台工作负载为唯一权威来源，
  # 不用可能滞后的业务容器值静默覆盖当前凭据。
  for workload_name in postgres minio; do
    if capture_workload_fragment "$workload_name"; then
      fragment_count=$((fragment_count + 1))
    fi
  done

  # 这些是公开、非敏感的预览路由/协议标识；数据库和对象存储凭据仍必须来自 combo-preview 自身。
  {
    printf '%s\n' \
      'LOG_LEVEL=info' \
      'CORS_ORIGIN=https://review.43-160-242-46.sslip.io' \
      'REDIS_QUEUE_URL=redis://redis-queue:6379/0' \
      'REDIS_HOT_URL=redis://redis-hot:6379/0' \
      'S3_ENDPOINT=http://minio:9000' \
      'S3_PUBLIC_ENDPOINT=https://review-s3.43-160-242-46.sslip.io' \
      'S3_REGION=us-east-1' \
      'LOGTO_ENDPOINT=https://andkzt.logto.app' \
      'LOGTO_ISSUER=https://andkzt.logto.app/oidc' \
      'LOGTO_JWKS_URI=https://andkzt.logto.app/oidc/jwks' \
      'LOGTO_REDIRECT_URI=https://review.43-160-242-46.sslip.io/api/v1/auth/callback' \
      'LOGTO_AUDIENCE=https://api.buildwithcombo.com'
  } >> "$merged_env_file"

  cp "$merged_env_file" "$raw_env_file"
  if raw_environment_has_required_app_keys; then
    validate_public_oidc_metadata
    preview_environment_captured=true
    echo "[cloud-review] 已从 $fragment_count 个预览工作负载聚合恢复配置"
    return 0
  fi
  print_missing_required_app_keys
  return 1
}

capture_app_secret_environment() {
  kubectl -n "$NAMESPACE" get secret "$ENV_SECRET" -o json > "$inspect_file"
  python3 - "$inspect_file" "$raw_env_file" <<'PY'
import base64
import json
import sys

source, target = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    payload = json.load(handle)
data = payload.get("data", {})
if not isinstance(data, dict) or not data:
    raise SystemExit(1)
with open(target, "w", encoding="utf-8") as handle:
    for name, encoded in data.items():
        value = base64.b64decode(encoded, validate=True).decode("utf-8")
        if "\n" in value or "\r" in value:
            raise SystemExit(1)
        handle.write(f"{name}={value}\n")
PY
}

filter_and_validate_app_environment() {
  python3 - "$raw_env_file" "$filtered_env_file" <<'PY'
import sys

source, target = sys.argv[1:]
allowed = {
    "CORS_ORIGIN",
    "NODE_ENV",
    "LOG_LEVEL",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "REDIS_QUEUE_URL",
    "REDIS_HOT_URL",
    "S3_ENDPOINT",
    "S3_PUBLIC_ENDPOINT",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "S3_REGION",
    "LOGTO_ENDPOINT",
    "LOGTO_ISSUER",
    "LOGTO_JWKS_URI",
    "LOGTO_ADMIN_ENDPOINT",
    "LOGTO_DB_ALTERATION_TARGET",
    "LOGTO_APP_ID",
    "LOGTO_APP_SECRET",
    "LOGTO_REDIRECT_URI",
    "LOGTO_AUDIENCE",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "LLM_PROVIDER",
    "LLM_BASE_URL",
    "LLM_MODEL",
    "RUNTIME_LLM_PROVIDER",
    "RUNTIME_LLM_MODEL",
}
required = {
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "LOGTO_ISSUER",
    "LOGTO_JWKS_URI",
    "LOGTO_AUDIENCE",
}
values = {}
with open(source, encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.rstrip("\n")
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name in allowed:
            values[name] = value
missing = sorted(name for name in required if not values.get(name))
if missing:
    print(
        "[cloud-review] 历史预览配置缺少必需键：" + ", ".join(missing),
        file=sys.stderr,
    )
    raise SystemExit(78)
with open(target, "w", encoding="utf-8") as handle:
    for name in sorted(values):
        handle.write(f"{name}={values[name]}\n")
PY
}

persist_app_backup() {
  cp "$filtered_env_file" "$SECRET_ROOT/app.env"
  chmod 600 "$SECRET_ROOT/app.env"
}

restore_app_secret() {
  if kubectl -n "$NAMESPACE" get secret "$ENV_SECRET" >/dev/null 2>&1; then
    capture_app_secret_environment
    filter_and_validate_app_environment
    persist_app_backup
    return
  fi

  if test -s "$SECRET_ROOT/app.env"; then
    cp "$SECRET_ROOT/app.env" "$raw_env_file"
    echo "[cloud-review] 从预览主机备份恢复 $ENV_SECRET"
  elif ! capture_preview_environment; then
    echo "[cloud-review] 无法从预览备份或工作负载片段恢复 app.env；拒绝生产回退" >&2
    exit 78
  fi

  filter_and_validate_app_environment
  kubectl -n "$NAMESPACE" create secret generic "$ENV_SECRET" \
    --from-env-file="$filtered_env_file"
  persist_app_backup
}

extract_environment_value() {
  local key_name="$1"
  local target_file="$2"
  python3 - "$raw_env_file" "$target_file" "$key_name" <<'PY'
import sys

source, target, wanted = sys.argv[1:]
value = None
with open(source, encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.rstrip("\n")
        if "=" not in line:
            continue
        name, candidate = line.split("=", 1)
        if name == wanted:
            value = candidate
if not value:
    raise SystemExit(1)
with open(target, "w", encoding="utf-8") as handle:
    handle.write(value)
PY
  chmod 600 "$target_file"
}

capture_bootstrap_backups() {
  local dev_session_secret_file="$1"
  local review_access_token_file="$2"
  kubectl -n "$NAMESPACE" get secret "$BOOTSTRAP_SECRET" -o json > "$inspect_file"
  python3 - \
    "$inspect_file" \
    "$dev_session_secret_file" \
    "$review_access_token_file" <<'PY'
import base64
import json
import sys

source, dev_target, review_target = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    payload = json.load(handle)
data = payload.get("data", {})
try:
    dev_value = base64.b64decode(data["DEV_SESSION_SECRET"], validate=True).decode("utf-8")
    review_value = base64.b64decode(data["REVIEW_ACCESS_TOKEN"], validate=True).decode("utf-8")
except (KeyError, UnicodeDecodeError, ValueError):
    raise SystemExit(1)
if not dev_value or "\n" in dev_value or "\r" in dev_value:
    raise SystemExit(1)
if len(review_value) != 64 or any(char not in "0123456789abcdef" for char in review_value):
    raise SystemExit(1)
with open(dev_target, "w", encoding="utf-8") as handle:
    handle.write(dev_value)
with open(review_target, "w", encoding="utf-8") as handle:
    handle.write(review_value)
PY
  chmod 600 "$dev_session_secret_file" "$review_access_token_file"
}

review_token_is_valid() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]]
}

apply_bootstrap_secret() {
  local dev_session_secret_file="$1"
  local review_access_token_file="$2"
  kubectl -n "$NAMESPACE" create secret generic "$BOOTSTRAP_SECRET" \
    --from-file=DEV_SESSION_SECRET="$dev_session_secret_file" \
    --from-file=REVIEW_ACCESS_TOKEN="$review_access_token_file" \
    --dry-run=client \
    -o yaml |
    kubectl apply -f - >/dev/null
}

restore_bootstrap_secret() {
  local dev_session_secret_file review_access_token_file
  dev_session_secret_file="$SECRET_ROOT/dev-session-secret"
  review_access_token_file="$SECRET_ROOT/review-access-token"

  if test -n "$review_access_token" && ! review_token_is_valid "$review_access_token"; then
    echo "[cloud-review] GitHub Environment 中的 Review token 格式错误" >&2
    exit 78
  fi

  if kubectl -n "$NAMESPACE" get secret "$BOOTSTRAP_SECRET" >/dev/null 2>&1; then
    capture_bootstrap_backups "$dev_session_secret_file" "$review_access_token_file"
    if review_token_is_valid "$review_access_token"; then
      printf '%s' "$review_access_token" > "$review_access_token_file"
      chmod 600 "$review_access_token_file"
      apply_bootstrap_secret "$dev_session_secret_file" "$review_access_token_file"
    fi
    return
  fi

  if ! test -s "$dev_session_secret_file"; then
    if ! capture_preview_environment ||
      ! extract_environment_value DEV_SESSION_SECRET "$dev_session_secret_file"; then
      python3 - "$dev_session_secret_file" <<'PY'
import secrets
import sys

with open(sys.argv[1], "w", encoding="utf-8") as handle:
    handle.write(secrets.token_hex(32))
PY
      chmod 600 "$dev_session_secret_file"
      echo "[cloud-review] 原 dev session 密钥不可恢复，已轮换预览专属密钥"
    else
      echo "[cloud-review] 从历史预览环境恢复 dev session 密钥"
    fi
  fi

  if ! review_token_is_valid "$review_access_token" &&
    test -s "$review_access_token_file"; then
    review_access_token="$(cat "$review_access_token_file")"
  fi
  if ! review_token_is_valid "$review_access_token"; then
    echo "[cloud-review] 预览 Review token 缺失或格式错误" >&2
    exit 78
  fi

  printf '%s' "$review_access_token" > "$review_access_token_file"
  chmod 600 "$review_access_token_file"
  apply_bootstrap_secret "$dev_session_secret_file" "$review_access_token_file"
}

kubectl apply -f /opt/combo-preview/infra/k8s/overlays/cloud-review/platform/namespace.yaml
restore_app_secret
restore_bootstrap_secret
kubectl -n "$NAMESPACE" get secret "$PULL_SECRET" >/dev/null 2>&1 || {
  echo "[cloud-review] 缺少预览专属 GHCR pull Secret，拒绝使用生产凭据回退" >&2
  exit 78
}

echo "[cloud-review] 预览专属 Secret 已就绪"
