#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR
readonly SHA_RE='^[0-9a-f]{40}$'
readonly DIGEST_RE='^sha256:[0-9a-f]{64}$'

ENVIRONMENT=''
FRESH_RESET=0
MANIFEST=''
MANIFEST_DIGEST=''
MIGRATIONS=''
FOUNDATION_YAML=''
INIT_YAML=''
MIGRATE_YAML=''
APPS_YAML=''
WEB_ASSETS=''
KUBECONFIG_PATH=${KUBECONFIG:-"$HOME/.kube/config"}
EVIDENCE_ROOT=${COMBO_RELEASE_EVIDENCE_ROOT:-"$HOME/data/combo-releases/goal-a"}
MUTATION_LOCK=${COMBO_MUTATION_LOCK:-"$HOME/data/combo-release-mutation.lock"}
K3S_STORAGE_ROOT=${COMBO_K3S_STORAGE_ROOT:-"$HOME/data/k3s/storage"}

status() { printf '[release] %s\n' "$1"; }
fail() {
  printf '[release] FAIL: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: deploy-release.sh
  --environment preview|production
  --fresh-reset
  --manifest release.json
  --manifest-digest sha256:...
  --migrations migration-files.txt
  --foundation-yaml rendered-foundation.yaml
  --init-yaml rendered-init.yaml
  --migrate-yaml rendered-migrate.yaml
  --apps-yaml rendered-apps.yaml
  --web-assets web-asset-manifest.json
EOF
  exit 2
}

while (($# > 0)); do
  case "$1" in
    --fresh-reset)
      FRESH_RESET=1
      shift
      ;;
    --environment | --manifest | --manifest-digest | --migrations | --foundation-yaml | \
      --init-yaml | --migrate-yaml | --apps-yaml | --web-assets)
      (($# >= 2)) || usage
      case "$1" in
        --environment) ENVIRONMENT=$2 ;;
        --manifest) MANIFEST=$2 ;;
        --manifest-digest) MANIFEST_DIGEST=$2 ;;
        --migrations) MIGRATIONS=$2 ;;
        --foundation-yaml) FOUNDATION_YAML=$2 ;;
        --init-yaml) INIT_YAML=$2 ;;
        --migrate-yaml) MIGRATE_YAML=$2 ;;
        --apps-yaml) APPS_YAML=$2 ;;
        --web-assets) WEB_ASSETS=$2 ;;
      esac
      shift 2
      ;;
    *) usage ;;
  esac
done

case "$ENVIRONMENT" in
  preview)
    NAMESPACE=combo-review
    ENV_SECRET=combo-preview-env
    PULL_SECRET=combo-preview-ghcr-pull
    PUBLIC_ORIGIN=https://review.43-160-242-46.sslip.io
    [[ -n "$FOUNDATION_YAML" && -n "$INIT_YAML" ]] ||
      fail 'Preview requires fresh foundation and init manifests'
    LEGACY_DEPLOYMENTS=(api consumer redis-hot runtime sweeper web worker)
    DEPLOYMENT_RE='^(api|consumer|redis-hot|runtime|sweeper|web|worker|release-redis-hot|release-[0-9a-f]{12}-(api|runtime|web|worker))$'
    ;;
  production)
    NAMESPACE=combo
    ENV_SECRET=combo-env
    PULL_SECRET=ghcr-pull
    PUBLIC_ORIGIN=https://agora.43-160-242-46.sslip.io
    [[ -n "$FOUNDATION_YAML" && -n "$INIT_YAML" ]] ||
      fail 'Production requires fresh foundation and init manifests'
    LEGACY_DEPLOYMENTS=(api redis-hot runtime web worker)
    DEPLOYMENT_RE='^(api|redis-hot|runtime|web|worker|release-redis-hot|release-[0-9a-f]{12}-(api|runtime|web|worker))$'
    ;;
  *) usage ;;
esac
((FRESH_RESET == 1)) || fail 'this deployment requires --fresh-reset'

for command in node jq sha256sum flock kubectl cmp awk install mktemp realpath grep mv \
  rm dirname sleep seq tr sort sudo curl stat date; do
  command -v "$command" >/dev/null 2>&1 || fail "missing host command: $command"
done
[[ -x "$SCRIPT_DIR/switch-release-traffic.sh" ]] ||
  fail 'release traffic controller is missing or not executable'

K=(kubectl --kubeconfig "$KUBECONFIG_PATH")
source_sha=''
release_id=''
migration_head=''
built_at=''
web_asset_digest=''
api_image=''
runtime_image=''
web_image=''
PREFIX=''
metadata_name=''
work=''
release_directory=''
traffic_evidence=''
inventory_deployments=''
inventory_statefulsets=''
inventory_jobs=''
inventory_configmaps=''
pvc_inventory=''
mutation_started=0
deployment_succeeded=0
REUSE_COMPLETED=0

validate_migrations() {
  local expected=(
    0000_baseline_schema.sql
    0001_expired_upload_reconciliation.sql
    0002_drop_stream_events.sql
    0003_turns.sql
    0004_studio_sessions.sql
    0005_capability_current_ui.sql
    0006_one_running_turn_per_session.sql
  )
  local actual=()
  mapfile -t actual <"$MIGRATIONS"
  ((${#actual[@]} == ${#expected[@]})) ||
    fail 'migration file list must contain exactly 0000 through 0006'
  local index
  for index in "${!expected[@]}"; do
    [[ "${actual[$index]}" == "${expected[$index]}" ]] ||
      fail 'migration file list differs from the exact 0000 through 0006 contract'
  done
  [[ "${actual[-1]}" == "$migration_head" ]] ||
    fail 'migration file list does not reach the release migration head'
}

validate_inputs() {
  local file verified_digest verified_web_digest
  for file in "$MANIFEST" "$MIGRATIONS" "$FOUNDATION_YAML" "$INIT_YAML" \
    "$MIGRATE_YAML" "$APPS_YAML" "$WEB_ASSETS"; do
    [[ -f "$file" && ! -L "$file" ]] || fail "input is not a regular file: $file"
  done
  [[ "$MANIFEST_DIGEST" =~ $DIGEST_RE ]] || fail 'invalid release manifest digest'
  verified_digest=$(node "$SCRIPT_DIR/release-manifest.mjs" verify \
    --manifest "$MANIFEST" --digest "$MANIFEST_DIGEST")
  [[ "$verified_digest" == "$MANIFEST_DIGEST" ]] ||
    fail 'release manifest verifier returned another digest'

  source_sha=$(jq -er '.sourceSha' "$MANIFEST")
  release_id=$(jq -er '.releaseId' "$MANIFEST")
  migration_head=$(jq -er '.migrationHead' "$MANIFEST")
  built_at=$(jq -er '.builtAt' "$MANIFEST")
  web_asset_digest=$(jq -er '.webAssetManifest' "$MANIFEST")
  api_image=$(jq -er '.images.api' "$MANIFEST")
  runtime_image=$(jq -er '.images.runtime' "$MANIFEST")
  web_image=$(jq -er '.images.web' "$MANIFEST")
  [[ "$source_sha" =~ $SHA_RE ]] || fail 'manifest source SHA is invalid'
  [[ "$release_id" == "release-$source_sha" ]] || fail 'manifest release identity is invalid'
  PREFIX="release-${source_sha:0:12}-"
  metadata_name="combo-release-meta-${source_sha:0:12}"

  verified_web_digest=$(node "$SCRIPT_DIR/web-asset-manifest.mjs" verify \
    --manifest "$WEB_ASSETS" --digest "$web_asset_digest")
  [[ "$verified_web_digest" == "$web_asset_digest" ]] ||
    fail 'Web asset manifest verifier returned another digest'
  validate_migrations
}

secret_has_key() {
  local secret=$1 key=$2
  # Only key names are requested. Secret payloads never leave the API server.
  # shellcheck disable=SC2016
  "${K[@]}" -n "$NAMESPACE" get secret "$secret" \
    -o 'go-template={{range $key, $_ := .data}}{{$key}}{{"\n"}}{{end}}' |
    grep -Fxq "$key"
}

validate_secret_keys() {
  local key
  for key in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB S3_ACCESS_KEY S3_SECRET_KEY \
    LOGTO_ISSUER LOGTO_JWKS_URI LOGTO_AUDIENCE; do
    secret_has_key "$ENV_SECRET" "$key" ||
      fail "$ENV_SECRET is missing required key $key"
  done
  secret_has_key "$PULL_SECRET" .dockerconfigjson ||
    fail "$PULL_SECRET is missing its registry key"
  if [[ "$ENVIRONMENT" == preview ]]; then
    secret_has_key combo-preview-bootstrap DEV_SESSION_SECRET ||
      fail 'combo-preview-bootstrap is missing DEV_SESSION_SECRET'
  else
    for key in LOGTO_ENDPOINT LOGTO_APP_ID LOGTO_APP_SECRET LOGTO_REDIRECT_URI; do
      secret_has_key "$ENV_SECRET" "$key" ||
        fail "$ENV_SECRET is missing required key $key"
    done
  fi
}

validate_rendered_phase() {
  local phase=$1 file=$2
  "${K[@]}" apply --dry-run=server -f "$file" -o json |
    node "$SCRIPT_DIR/verify-rendered-release.mjs" \
      --manifest "$MANIFEST" \
      --manifest-digest "$MANIFEST_DIGEST" \
      --environment "$ENVIRONMENT" \
      --phase "$phase" >/dev/null
}

metadata_matches() {
  local file=$1
  jq -e \
    --arg environment "$ENVIRONMENT" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg builtAt "$built_at" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg webAssets "$web_asset_digest" '
      .schemaVersion == 1
      and .environment == $environment
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .builtAt == $builtAt
      and .releaseManifestDigest == $manifestDigest
      and .webAssetManifest == $webAssets
    ' "$file" >/dev/null 2>&1
}

reuse_completed_release() {
  REUSE_COMPLETED=0
  [[ -d "$release_directory" && ! -L "$release_directory" ]] || return 0
  cmp -s "$MANIFEST" "$release_directory/release.json" || return 0
  cmp -s "$MIGRATIONS" "$release_directory/migration-files.txt" || return 0
  cmp -s "$WEB_ASSETS" "$release_directory/web-asset-manifest.json" || return 0
  [[ "$(tr -d '\n' <"$release_directory/release.sha256")" == "$MANIFEST_DIGEST" ]] ||
    return 0
  jq -e \
    --arg environment "$ENVIRONMENT" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" '
      .schemaVersion == 1
      and .status == "passed"
      and .environment == $environment
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .checks.freshFoundation == true
      and .checks.exactMigrations == true
      and .checks.applicationImages == true
      and .checks.publicTraffic == true
      and .checks.legacyCleanup == true
    ' "$release_directory/deploy-evidence.json" >/dev/null 2>&1 || return 0

  local name expected desired ready public_version
  for name in api worker runtime web; do
    case "$name" in
      api | worker) expected=$api_image ;;
      runtime) expected=$runtime_image ;;
      web) expected=$web_image ;;
    esac
    [[ "$("${K[@]}" -n "$NAMESPACE" get "deployment/${PREFIX}${name}" \
      -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null)" == "$expected" ]] ||
      return 0
    desired=$("${K[@]}" -n "$NAMESPACE" get "deployment/${PREFIX}${name}" \
      -o jsonpath='{.spec.replicas}' 2>/dev/null) || return 0
    ready=$("${K[@]}" -n "$NAMESPACE" get "deployment/${PREFIX}${name}" \
      -o jsonpath='{.status.readyReplicas}' 2>/dev/null) || return 0
    [[ "$desired" =~ ^[0-9]+$ && "$ready" == "$desired" ]] || return 0
  done
  public_version="$work/reuse-public-version.json"
  curl --fail --silent --show-error --max-time 15 \
    "$PUBLIC_ORIGIN/version.json" >"$public_version" 2>/dev/null || return 0
  metadata_matches "$public_version" || return 0
  REUSE_COMPLETED=1
}

capture_inventory() {
  inventory_deployments="$work/deployments.json"
  inventory_statefulsets="$work/statefulsets.json"
  inventory_jobs="$work/jobs.json"
  inventory_configmaps="$work/configmaps.json"
  pvc_inventory="$work/pvcs.jsonl"

  "${K[@]}" -n "$NAMESPACE" get deployments -o json >"$inventory_deployments"
  "${K[@]}" -n "$NAMESPACE" get statefulsets -o json >"$inventory_statefulsets"
  "${K[@]}" -n "$NAMESPACE" get jobs -o json >"$inventory_jobs"
  "${K[@]}" -n "$NAMESPACE" get configmaps -o json >"$inventory_configmaps"

  jq -e --arg allowed "$DEPLOYMENT_RE" '
    [.items[].metadata.name | select(test($allowed) | not)] | length == 0
  ' "$inventory_deployments" >/dev/null ||
    fail 'namespace contains an unapproved Deployment'
  jq -e '
    [.items[].metadata.name
      | select(test("^(postgres|redis-queue|minio|release-postgres|release-redis-queue|release-minio)$") | not)]
    | length == 0
  ' "$inventory_statefulsets" >/dev/null ||
    fail 'namespace contains an unapproved StatefulSet'
  jq -e '
    [.items[].metadata.name
      | select(test("^(migrate|minio-init|release-minio-init|release-[0-9a-f]{12}-migrate)$") | not)]
    | length == 0
  ' "$inventory_jobs" >/dev/null ||
    fail 'namespace contains an unapproved Job'

  local storage_root_real claim_json claim volume pv_json reclaim path path_real
  storage_root_real=$(sudo -n realpath -e "$K3S_STORAGE_ROOT")
  : >"$pvc_inventory"
  while IFS= read -r claim; do
    [[ "$claim" =~ ^(data-(release-)?(postgres|redis-queue|minio)-0|combo-preview-(postgres|redis-queue|minio)-data-(postgres|redis-queue|minio)-0)$ ]] ||
      fail "namespace contains an unapproved PVC: $claim"
    claim_json=$("${K[@]}" -n "$NAMESPACE" get "pvc/$claim" -o json)
    [[ "$(jq -er '.spec.storageClassName' <<<"$claim_json")" == local-path ]] ||
      fail "PVC $claim is not local-path"
    volume=$(jq -er '.spec.volumeName' <<<"$claim_json")
    pv_json=$("${K[@]}" get "pv/$volume" -o json)
    reclaim=$(jq -er '.spec.persistentVolumeReclaimPolicy' <<<"$pv_json")
    [[ "$reclaim" == Delete ]] || fail "PV $volume does not have Delete reclaim policy"
    path=$(jq -er '.spec.local.path // .spec.hostPath.path' <<<"$pv_json")
    path_real=$(sudo -n realpath -e "$path")
    [[ "$path_real" == "$storage_root_real/"* ]] ||
      fail "PV $volume escaped the dedicated K3s storage root"
    jq -n \
      --arg claim "$claim" \
      --arg claimUid "$(jq -er '.metadata.uid' <<<"$claim_json")" \
      --arg volume "$volume" \
      --arg volumeUid "$(jq -er '.metadata.uid' <<<"$pv_json")" \
      --arg path "$path_real" \
      '{claim: $claim, claimUid: $claimUid, volume: $volume, volumeUid: $volumeUid, path: $path}' \
      >>"$pvc_inventory"
  done < <("${K[@]}" -n "$NAMESPACE" get pvc -o json |
    jq -r '.items[].metadata.name' | sort)
}

fence_writers() {
  local name
  status 'fencing every allowlisted writer'
  if [[ -n "$inventory_jobs" && -f "$inventory_jobs" ]]; then
    while IFS= read -r name; do
      "${K[@]}" -n "$NAMESPACE" delete "job/$name" \
        --ignore-not-found --wait=true --timeout=120s >/dev/null 2>&1 || true
    done < <(jq -r '.items[].metadata.name' "$inventory_jobs")
  fi
  "${K[@]}" -n "$NAMESPACE" delete "job/${PREFIX}migrate" job/release-minio-init \
    --ignore-not-found --wait=true --timeout=120s >/dev/null 2>&1 || true
  while IFS= read -r name; do
    [[ "$name" =~ $DEPLOYMENT_RE ]] || continue
    "${K[@]}" -n "$NAMESPACE" scale "deployment/$name" --replicas=0 >/dev/null 2>&1 || true
  done < <("${K[@]}" -n "$NAMESPACE" get deployments -o json 2>/dev/null |
    jq -r '.items[].metadata.name' 2>/dev/null || true)
  for name in postgres redis-queue minio release-postgres release-redis-queue release-minio; do
    "${K[@]}" -n "$NAMESPACE" scale "statefulset/$name" --replicas=0 \
      >/dev/null 2>&1 || true
  done
}

wait_for_removed_storage() {
  local volume path removed
  while IFS= read -r row; do
    volume=$(jq -r '.volume' <<<"$row")
    path=$(jq -r '.path' <<<"$row")
    removed=0
    for _ in $(seq 1 90); do
      if ! "${K[@]}" get "pv/$volume" >/dev/null 2>&1 &&
        ! sudo -n test -e "$path"; then
        removed=1
        break
      fi
      sleep 2
    done
    ((removed == 1)) ||
      fail "local-path provisioner did not remove exact PV storage $volume"
  done <"$pvc_inventory"
}

fresh_reset_release_data() {
  local name
  local release_foundation=(release-postgres release-redis-queue release-redis-hot release-minio)
  local release_claims=(
    data-release-postgres-0
    data-release-redis-queue-0
    data-release-minio-0
  )
  local legacy_claims=(data-postgres-0 data-redis-queue-0 data-minio-0)
  legacy_claims+=(
    combo-preview-postgres-data-postgres-0
    combo-preview-redis-queue-data-redis-queue-0
    combo-preview-minio-data-minio-0
  )
  local business_names=(api worker runtime web)
  : "${release_foundation[*]}${business_names[*]}"

  fence_writers

  while IFS= read -r name; do
    if [[ "$name" =~ ^release-[0-9a-f]{12}-(api|runtime|web|worker)$ ]]; then
      "${K[@]}" -n "$NAMESPACE" delete "deployment/$name" \
        --ignore-not-found --wait=true --timeout=180s >/dev/null
    fi
  done < <(jq -r '.items[].metadata.name' "$inventory_deployments")

  "${K[@]}" -n "$NAMESPACE" delete deployment/release-redis-hot \
    --ignore-not-found --wait=true --timeout=180s >/dev/null
  "${K[@]}" -n "$NAMESPACE" delete \
    statefulset/postgres statefulset/redis-queue statefulset/minio \
    statefulset/release-postgres statefulset/release-redis-queue statefulset/release-minio \
    --ignore-not-found --wait=true --timeout=180s >/dev/null
  "${K[@]}" -n "$NAMESPACE" delete \
    service/postgres service/redis-queue service/redis-hot service/minio \
    service/release-postgres service/release-redis-queue service/release-redis-hot \
    service/release-minio \
    --ignore-not-found --wait=true --timeout=120s >/dev/null
  "${K[@]}" -n "$NAMESPACE" delete \
    configmap/postgres-config configmap/redis-queue-config configmap/redis-hot-config \
    configmap/minio-init-script configmap/release-redis-queue-config \
    configmap/release-redis-hot-config configmap/release-minio-init-script \
    --ignore-not-found --wait=true --timeout=120s >/dev/null

  while IFS= read -r name; do
    [[ "$name" =~ ^combo-release-meta-[0-9a-f]{12}$ ]] || continue
    "${K[@]}" -n "$NAMESPACE" delete "configmap/$name" \
      --ignore-not-found --wait=true --timeout=120s >/dev/null
  done < <(jq -r '.items[].metadata.name' "$inventory_configmaps")

  for name in "${release_claims[@]}" "${legacy_claims[@]}"; do
    "${K[@]}" -n "$NAMESPACE" delete "pvc/$name" \
      --ignore-not-found --wait=true --timeout=180s >/dev/null
  done
  wait_for_removed_storage
}

apply_release_metadata() {
  "${K[@]}" -n "$NAMESPACE" create configmap "$metadata_name" \
    --from-literal=COMBO_ENVIRONMENT="$ENVIRONMENT" \
    --from-literal=COMBO_SOURCE_SHA="$source_sha" \
    --from-literal=COMBO_RELEASE_ID="$release_id" \
    --from-literal=COMBO_BUILT_AT="$built_at" \
    --from-literal=COMBO_RELEASE_MANIFEST_DIGEST="$MANIFEST_DIGEST" \
    --from-literal=COMBO_WEB_ASSET_MANIFEST="$web_asset_digest" \
    --from-literal=EXPECTED_MIGRATION_HEAD="$migration_head" \
    --dry-run=client -o json |
    jq \
      --arg sourceSha "$source_sha" \
      --arg releaseId "$release_id" \
      --arg digest "$MANIFEST_DIGEST" '
        .immutable = true
        | .metadata.labels["combo.build/release-metadata"] = "true"
        | .metadata.annotations["combo.build/source-sha"] = $sourceSha
        | .metadata.annotations["combo.build/release-id"] = $releaseId
        | .metadata.annotations["combo.build/release-manifest-digest"] = $digest
      ' |
    "${K[@]}" apply -f - >/dev/null
}

apply_foundation() {
  local workload
  status 'creating fresh PostgreSQL, Redis, and MinIO'
  "${K[@]}" apply -f "$FOUNDATION_YAML" >/dev/null
  for workload in statefulset/release-postgres statefulset/release-redis-queue \
    statefulset/release-minio deployment/release-redis-hot; do
    "${K[@]}" -n "$NAMESPACE" rollout status "$workload" --timeout=600s
  done

  "${K[@]}" -n "$NAMESPACE" delete job/release-minio-init \
    --ignore-not-found --wait=true --timeout=120s >/dev/null
  "${K[@]}" apply -f "$INIT_YAML" >/dev/null
  if ! "${K[@]}" -n "$NAMESPACE" wait --for=condition=complete \
    job/release-minio-init --timeout=300s; then
    "${K[@]}" -n "$NAMESPACE" logs job/release-minio-init --tail=200 >&2 || true
    fail 'bucket initialization and synthetic object smoke failed'
  fi
}

run_migration() {
  status 'running the exact 0000 through 0006 migration set'
  "${K[@]}" -n "$NAMESPACE" delete "job/${PREFIX}migrate" \
    --ignore-not-found --wait=true --timeout=120s >/dev/null
  "${K[@]}" apply -f "$MIGRATE_YAML" >/dev/null
  if ! "${K[@]}" -n "$NAMESPACE" wait --for=condition=complete \
    "job/${PREFIX}migrate" --timeout=600s; then
    "${K[@]}" -n "$NAMESPACE" logs "job/${PREFIX}migrate" --tail=200 >&2 || true
    fail 'migration failed; business manifests were not applied'
  fi

  local actual_migrations="$work/actual-migrations.txt"
  # Credentials are expanded only inside the PostgreSQL container.
  # shellcheck disable=SC2016
  "${K[@]}" -n "$NAMESPACE" exec release-postgres-0 -- sh -euc '
    export PGPASSWORD="$POSTGRES_PASSWORD"
    psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At \
      -c "SELECT filename FROM schema_migrations ORDER BY filename"
  ' >"$actual_migrations"
  cmp -s "$MIGRATIONS" "$actual_migrations" ||
    fail 'fresh database migration ledger differs from 0000 through 0006'

  [[ "$("${K[@]}" -n "$NAMESPACE" get "job/${PREFIX}migrate" \
    -o jsonpath='{.spec.template.spec.containers[0].image}')" == "$api_image" ]] ||
    fail 'migration Job does not use the release API image'
  "${K[@]}" -n "$NAMESPACE" get pods -l "job-name=${PREFIX}migrate" -o json |
    jq -e --arg image "$api_image" '
      [.items[]
        | select(.status.containerStatuses != null)
        | .status.containerStatuses[]
        | select(.state.terminated.exitCode == 0)
        | (.imageID | sub("^docker-pullable://"; "") | sub("^docker://"; ""))]
      | length >= 1 and all(. == $image)
    ' >/dev/null || fail 'migration Pod digest or completion evidence is invalid'
}

assert_release_metadata() {
  local file=$1 label=$2
  metadata_matches "$file" || fail "$label does not identify the release"
}

expected_image() {
  case "$1" in
    api | worker) printf '%s' "$api_image" ;;
    runtime) printf '%s' "$runtime_image" ;;
    web) printf '%s' "$web_image" ;;
  esac
}

apply_apps() {
  local name expected desired verified output endpoint
  status 'applying API, Worker, Runtime, and Web after migration'
  "${K[@]}" apply -f "$APPS_YAML" >/dev/null
  for name in api worker runtime web; do
    "${K[@]}" -n "$NAMESPACE" rollout status "deployment/${PREFIX}${name}" \
      --timeout=600s || fail "release ${name} rollout failed"
    expected=$(expected_image "$name")
    [[ "$("${K[@]}" -n "$NAMESPACE" get "deployment/${PREFIX}${name}" \
      -o jsonpath='{.spec.template.spec.containers[0].image}')" == "$expected" ]] ||
      fail "Deployment ${PREFIX}${name} does not use the release image"
    desired=$("${K[@]}" -n "$NAMESPACE" get "deployment/${PREFIX}${name}" \
      -o jsonpath='{.spec.replicas}')
    verified=0
    for _ in $(seq 1 60); do
      if "${K[@]}" -n "$NAMESPACE" get pods \
        -l "combo.build/release-track=release-v1,app=${PREFIX}${name}" -o json |
        jq -e --arg image "$expected" --argjson desired "$desired" '
          [.items[] | select(.metadata.deletionTimestamp == null)] as $pods
          | ($pods | length) == $desired
          and all($pods[];
            (.status.containerStatuses | length) == 1
            and all(.status.containerStatuses[];
              .ready == true
              and ((.imageID | sub("^docker-pullable://"; "") | sub("^docker://"; "")) == $image)
            )
          )
        ' >/dev/null; then
        verified=1
        break
      fi
      sleep 2
    done
    ((verified == 1)) || fail "live ${name} Pods do not use the immutable release digest"
  done

  for endpoint in version.json runtime-config.json try/runtime-config.json \
    api/v1/version api/v1/runtime/version; do
    output="$work/$(tr '/' '-' <<<"$endpoint").json"
    "${K[@]}" -n "$NAMESPACE" exec "deployment/${PREFIX}web" -- \
      wget -qO- "http://127.0.0.1/$endpoint" >"$output"
    assert_release_metadata "$output" "live $endpoint"
  done
  "${K[@]}" -n "$NAMESPACE" exec "deployment/${PREFIX}web" -- \
    wget -qO /dev/null http://127.0.0.1/health
  "${K[@]}" -n "$NAMESPACE" exec "deployment/${PREFIX}web" -- \
    wget -qO /dev/null http://127.0.0.1/ready

  local live_web_asset_digest
  live_web_asset_digest=$("${K[@]}" -n "$NAMESPACE" exec "deployment/${PREFIX}web" -- \
    sha256sum /usr/share/nginx/html/web-asset-manifest.json | awk '{print "sha256:" $1}')
  [[ "$live_web_asset_digest" == "$web_asset_digest" ]] ||
    fail 'live Web asset manifest digest differs from the release'

  local asset_path
  asset_path=$(jq -er '
    first(.assets[] | select(.application == "web" and (.path | startswith("assets/"))) | .path)
  ' "$WEB_ASSETS")
  "${K[@]}" -n "$NAMESPACE" exec "deployment/${PREFIX}web" -- \
    wget -qO /dev/null "http://127.0.0.1/$asset_path"
  if "${K[@]}" -n "$NAMESPACE" exec "deployment/${PREFIX}web" -- \
    wget -qO /dev/null http://127.0.0.1/assets/combo-missing-deadbeef.js; then
    fail 'a missing hashed Web asset returned success'
  fi
}

switch_release_traffic() {
  traffic_evidence="$work/traffic-evidence.json"
  "$SCRIPT_DIR/switch-release-traffic.sh" \
    --environment "$ENVIRONMENT" \
    --manifest "$MANIFEST" \
    --manifest-digest "$MANIFEST_DIGEST" \
    --evidence-output "$traffic_evidence"
}

cleanup_legacy() {
  local name
  local legacy_deployments=(api consumer redis-hot runtime sweeper web worker)
  local legacy_statefulsets=(postgres redis-queue minio)
  local legacy_services=(api runtime web postgres redis-queue redis-hot minio)
  local legacy_jobs=(migrate minio-init)
  local legacy_configmaps=(
    postgres-config
    redis-queue-config
    redis-hot-config
    minio-init-script
    combo-preview-web-review
  )
  local legacy_claims=(data-postgres-0 data-redis-queue-0 data-minio-0)
  legacy_claims+=(
    combo-preview-postgres-data-postgres-0
    combo-preview-redis-queue-data-redis-queue-0
    combo-preview-minio-data-minio-0
  )

  status 'removing only the captured legacy release plane after successful traffic cutover'
  for name in "${legacy_deployments[@]}"; do
    "${K[@]}" -n "$NAMESPACE" delete "deployment/$name" \
      --ignore-not-found --wait=true --timeout=180s >/dev/null
  done
  for name in "${legacy_statefulsets[@]}"; do
    "${K[@]}" -n "$NAMESPACE" delete "statefulset/$name" \
      --ignore-not-found --wait=true --timeout=180s >/dev/null
  done
  for name in "${legacy_services[@]}"; do
    "${K[@]}" -n "$NAMESPACE" delete "service/$name" \
      --ignore-not-found --wait=true --timeout=120s >/dev/null
  done
  for name in "${legacy_jobs[@]}"; do
    "${K[@]}" -n "$NAMESPACE" delete "job/$name" \
      --ignore-not-found --wait=true --timeout=120s >/dev/null
  done
  for name in "${legacy_configmaps[@]}"; do
    "${K[@]}" -n "$NAMESPACE" delete "configmap/$name" \
      --ignore-not-found --wait=true --timeout=120s >/dev/null
  done
  for name in "${legacy_claims[@]}"; do
    "${K[@]}" -n "$NAMESPACE" delete "pvc/$name" \
      --ignore-not-found --wait=true --timeout=120s >/dev/null
  done

  for name in "${LEGACY_DEPLOYMENTS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "deployment/$name" >/dev/null 2>&1 ||
      fail "legacy Deployment $name remains after cleanup"
  done
}

write_release_evidence() {
  local stage checkpoint_stage deployments_json migration_json
  stage=$(mktemp -d "$EVIDENCE_ROOT/$ENVIRONMENT/.${release_id}.XXXXXX")
  install -m 0644 "$MANIFEST" "$stage/release.json"
  install -m 0644 "$MIGRATIONS" "$stage/migration-files.txt"
  install -m 0644 "$WEB_ASSETS" "$stage/web-asset-manifest.json"
  install -m 0644 "$FOUNDATION_YAML" "$stage/foundation.yaml"
  install -m 0644 "$INIT_YAML" "$stage/init.yaml"
  install -m 0644 "$MIGRATE_YAML" "$stage/migrate.yaml"
  install -m 0644 "$APPS_YAML" "$stage/apps.yaml"
  install -m 0644 "$traffic_evidence" "$stage/traffic-evidence.json"
  printf '%s\n' "$MANIFEST_DIGEST" >"$stage/release.sha256"
  chmod 0644 "$stage/release.sha256"

  deployments_json=$("${K[@]}" -n "$NAMESPACE" get \
    "deployment/${PREFIX}api" "deployment/${PREFIX}worker" \
    "deployment/${PREFIX}runtime" "deployment/${PREFIX}web" -o json |
    jq '[.items[] | {
      name: .metadata.name,
      generation: .metadata.generation,
      observedGeneration: .status.observedGeneration,
      replicas: .status.replicas,
      readyReplicas: .status.readyReplicas,
      image: .spec.template.spec.containers[0].image
    }] | sort_by(.name)')
  migration_json=$("${K[@]}" -n "$NAMESPACE" get "job/${PREFIX}migrate" -o json |
    jq '{
      name: .metadata.name,
      uid: .metadata.uid,
      image: .spec.template.spec.containers[0].image,
      completionTime: .status.completionTime
    }')
  jq -n \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg completedAt "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" \
    --argjson deployments "$deployments_json" \
    --argjson migration "$migration_json" \
    --slurpfile traffic "$traffic_evidence" '{
      schemaVersion: 1,
      status: "passed",
      environment: $environment,
      namespace: $namespace,
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      deployments: $deployments,
      migration: $migration,
      traffic: $traffic[0],
      checks: {
        freshFoundation: true,
        exactMigrations: true,
        applicationImages: true,
        publicTraffic: true,
        legacyCleanup: true
      },
      completedAt: $completedAt
    }' >"$stage/deploy-evidence.json"
  chmod 0644 "$stage/deploy-evidence.json"
  (
    cd "$stage"
    sha256sum release.json release.sha256 migration-files.txt web-asset-manifest.json \
      foundation.yaml init.yaml migrate.yaml apps.yaml traffic-evidence.json \
      deploy-evidence.json >SHA256SUMS
  )
  chmod 0644 "$stage/SHA256SUMS"
  [[ ! -e "$release_directory" ]] || fail 'release evidence directory already exists'
  mv "$stage" "$release_directory"

  checkpoint_stage="$work/checkpoint.json"
  jq -n \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg evidencePath "$release_directory" '{
      schemaVersion: 1,
      status: "passed",
      environment: $environment,
      namespace: $namespace,
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      evidencePath: $evidencePath
    }' >"$checkpoint_stage"
  install -m 0644 "$checkpoint_stage" "$EVIDENCE_ROOT/$ENVIRONMENT/current.json"
}

on_exit() {
  local rc=$?
  trap - EXIT
  if ((rc != 0 && mutation_started == 1 && deployment_succeeded == 0)); then
    fence_writers || true
  fi
  [[ -z "$work" ]] || rm -rf -- "$work"
  exit "$rc"
}
trap on_exit EXIT

validate_inputs
install -d -m 0750 "$EVIDENCE_ROOT" "$EVIDENCE_ROOT/$ENVIRONMENT"
install -d -m 0750 "$(dirname "$MUTATION_LOCK")"
exec 9>"$MUTATION_LOCK"
flock -n 9 || fail 'another environment mutation is running'

"${K[@]}" get namespace "$NAMESPACE" >/dev/null
validate_secret_keys
status 'server-side validating and allowlisting every rendered phase'
validate_rendered_phase foundation "$FOUNDATION_YAML"
validate_rendered_phase init "$INIT_YAML"
validate_rendered_phase migrate "$MIGRATE_YAML"
validate_rendered_phase apps "$APPS_YAML"

work=$(mktemp -d)
release_directory="$EVIDENCE_ROOT/$ENVIRONMENT/$release_id"
reuse_completed_release
if ((REUSE_COMPLETED == 1)); then
  status "$ENVIRONMENT already runs the verified $release_id"
  exit 0
fi

capture_inventory
mutation_started=1
fresh_reset_release_data
apply_release_metadata
apply_foundation
run_migration
apply_apps
switch_release_traffic
cleanup_legacy
write_release_evidence
deployment_succeeded=1
status "$ENVIRONMENT fresh release $release_id is complete"
