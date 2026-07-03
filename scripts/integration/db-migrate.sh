#!/usr/bin/env bash
# 集成：业务迁移端到端（O-05 / O-07）。对一个可达的 PostgreSQL 跑全部迁移，断言 10 个迁移文件全部记账、
# 且关键基表 + 后置 FK 闭合存在（脊柱 §11.E/§11.G）。CI 用临时 PG 容器即可（不需 Docker compose 全栈）。
# 入参：DATABASE_URL（必填，指向可达 PG）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

log() { printf '\033[1;34m[it:db]\033[0m %s\n' "$*"; }
fail() {
  printf '\033[1;31m[it:db:fail]\033[0m %s\n' "$*" >&2
  exit 1
}

: "${DATABASE_URL:?需设置 DATABASE_URL（指向可达 PostgreSQL）}"
command -v pnpm >/dev/null 2>&1 || fail "需要 pnpm"
command -v psql >/dev/null 2>&1 || fail "需要 psql（断言 schema 用）"

# 1) 跑迁移
log "执行迁移 ..."
pnpm -C "$ROOT_DIR" -F @cb/db migrate

# 2) 断言 10 个迁移文件全部记账
log "断言 schema_migrations 记账数 = 迁移文件数 ..."
expected="$(find "${ROOT_DIR}/db/migrations" -name '*.sql' | wc -l | tr -d ' ')"
applied="$(psql "$DATABASE_URL" -tAc 'SELECT count(*) FROM schema_migrations')"
[ "$applied" = "$expected" ] || fail "记账数 ${applied} != 迁移文件数 ${expected}"
log "记账 ${applied}/${expected} ✓"

# 3) 断言关键基表存在
for tbl in users jobs idempotency_keys drafts raw_snapshots session_segments \
  capability_candidates candidate_evidence capabilities capability_versions \
  publications marketplace_listings outbox_events consumer_cursors dead_events notifications; do
  exists="$(psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.${tbl}') IS NOT NULL")"
  [ "$exists" = "t" ] || fail "缺基表 ${tbl}"
done
log "关键基表齐全 ✓"

# 4) 断言后置血缘 FK 闭合存在（§11.E/§11.G 固定约束名抽样）
for fk in fk_drafts_snapshot fk_drafts_version fk_drafts_batch fk_pairings_draft \
  fk_capabilities_current_version fk_publications_capability_version fk_listings_capability_version; do
  exists="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM pg_constraint WHERE conname='${fk}'")"
  [ "$exists" = "1" ] || fail "缺后置 FK 约束 ${fk}（实际 ${exists}）"
done
log "后置 FK 闭合约束齐全 ✓"

# 5) 幂等：再跑一次不应报错、不应重复记账
log "二次迁移（幂等）..."
pnpm -C "$ROOT_DIR" -F @cb/db migrate
applied2="$(psql "$DATABASE_URL" -tAc 'SELECT count(*) FROM schema_migrations')"
[ "$applied2" = "$expected" ] || fail "二次迁移后记账数变化 ${applied2} != ${expected}"

log "迁移集成全部通过 ✓"
