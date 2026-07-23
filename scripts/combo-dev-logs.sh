#!/usr/bin/env bash
# 只做失败关闭的日志覆盖与泄漏检查；任何情况下都不回显原始日志或标记值。
set -Eeuo pipefail
umask 077
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

readonly NAMESPACE='combo-preview'
readonly KUBECONFIG_PATH='/etc/combo-dev/dispatcher.kubeconfig'
readonly TIME_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
K=(kubectl --request-timeout=30s --kubeconfig "$KUBECONFIG_PATH")
WORK=''

status() { printf '[combo-dev-logs] %s\n' "$1"; }
fail() { printf '[combo-dev-logs] FAIL: %s\n' "$1" >&2; exit 1; }
blocked() { printf '[combo-dev-logs] BLOCKED: %s\n' "$1" >&2; exit 2; }
cleanup() { [[ -z "$WORK" ]] || rm -rf -- "$WORK"; }
trap cleanup EXIT

pod_for_app() {
  local app=$1 json count name
  json=$(mktemp "$WORK/pods.XXXXXX.json")
  "${K[@]}" -n "$NAMESPACE" get pods -l "app=$app" -o json >"$json" 2>/dev/null || return 2
  count=$(jq '[.items[] | select(.status.phase == "Running") | select(all(.status.containerStatuses[]?; .ready == true))] | length' "$json" 2>/dev/null) || return 2
  [[ "$count" == 1 ]] || return 1
  name=$(jq -r '.items[] | select(.status.phase == "Running") | select(all(.status.containerStatuses[]?; .ready == true)) | .metadata.name' "$json" 2>/dev/null) || return 2
  [[ "$name" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || return 2
  printf '%s' "$name"
}

main() {
  local since='' marker_file='' arg marker mode app container pod corpus combined rc
  while (($#)); do
    arg=$1; shift
    case "$arg" in
      --since-time) since=${1:?}; shift ;;
      --marker-file) marker_file=${1:?}; shift ;;
      *) fail '未知参数。' ;;
    esac
  done
  [[ "$since" =~ $TIME_RE ]] || blocked '缺少合法的验收时间窗口。'
  [[ -f "$marker_file" ]] || blocked '缺少合成泄漏标记文件。'
  mode=$(stat -c '%a' "$marker_file" 2>/dev/null) || blocked '无法读取标记文件权限。'
  [[ "$mode" == 600 || "$mode" == 400 ]] || blocked '合成标记文件权限不安全。'
  marker=$(cat "$marker_file") || blocked '无法读取合成标记。'
  [[ "$marker" =~ ^[A-Za-z0-9._-]{20,128}$ ]] || blocked '合成标记格式不合法。'

  WORK=$(mktemp -d)
  combined="$WORK/all.log"
  : >"$combined"

  while read -r app container; do
    set +e
    pod=$(pod_for_app "$app")
    rc=$?
    set -e
    case $rc in 0) ;; 1) blocked '必需日志源没有唯一就绪 Pod。' ;; *) blocked '必需日志源状态不可读。' ;; esac
    corpus="$WORK/$app.log"
    "${K[@]}" -n "$NAMESPACE" logs "$pod" -c "$container" --since-time="$since" --tail=5000 --limit-bytes=8388608 >"$corpus" 2>/dev/null || blocked '至少一个必需日志源不可读。'
    cat "$corpus" >>"$combined"
  done <<'SOURCES'
api api
worker worker
runtime runtime
web web
postgres postgres
redis-queue redis
redis-hot redis
minio minio
SOURCES

  grep -Fq 'route not found' "$WORK/api.log" || blocked 'API 当前窗口缺少预期活动证据。'
  grep -Fq 'route not found' "$WORK/runtime.log" || blocked 'Runtime 当前窗口缺少预期活动证据。'
  grep -Fq 'pipeline finished' "$WORK/worker.log" || blocked 'Worker 当前窗口缺少真实任务完成证据。'

  if grep -Fq -- "$marker" "$combined"; then fail '合成凭据标记出现在日志中。'; fi
  if grep -Eiq '(authorization[" :=]+(bearer|basic)[[:space:]]+[A-Za-z0-9._~+/-]+|cookie[" :=]+[^[:space:]]+=|cb_session=|x-amz-(credential|signature)=|[?&](access_token|token|pairing_code|code)=)' "$combined"; then
    fail '日志命中凭据或签名材料模式。'
  fi

  status 'PASS sources=8 activity=3 redaction=PASS'
}

main "$@"
