#!/usr/bin/env bash
# 集成：业务迁移端到端（O-05 / O-07）。对一个可达的 PostgreSQL 跑全部迁移，断言迁移文件全部记账、
# 九张基线表齐全、关键命名约束存在。CI 用临时 PG 容器即可（不需 Docker compose 全栈）。
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

# 2) 断言迁移文件全部记账
log "断言 schema_migrations 记账数 = 迁移文件数 ..."
expected="$(find "${ROOT_DIR}/db/migrations" -name '*.sql' | wc -l | tr -d ' ')"
applied="$(psql "$DATABASE_URL" -tAc 'SELECT count(*) FROM schema_migrations')"
[ "$applied" = "$expected" ] || fail "记账数 ${applied} != 迁移文件数 ${expected}"
log "记账 ${applied}/${expected} ✓"

# 3) 断言九张基线表齐全（db/migrations/0000_baseline_schema.sql）
for tbl in users tasks uploads capabilities sessions messages stream_events artifacts audit_llm_calls; do
  exists="$(psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.${tbl}') IS NOT NULL")"
  [ "$exists" = "t" ] || fail "缺基表 ${tbl}"
done
log "九张基线表齐全 ✓"

# 4) 断言关键命名约束存在（基线固定约束名抽样：状态 CHECK、消息序唯一键）
for con in ck_tasks_step ck_tasks_status ck_uploads_status ck_sessions_status ck_messages_role uq_messages_session_seq; do
  exists="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM pg_constraint WHERE conname='${con}'")"
  [ "$exists" = "1" ] || fail "缺命名约束 ${con}（实际 ${exists}）"
done
# account 大小写唯一性靠函数唯一索引（不在 pg_constraint 里），单独断言
uq_idx="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM pg_indexes WHERE indexname='uq_users_account_lower'")"
[ "$uq_idx" = "1" ] || fail "缺唯一索引 uq_users_account_lower（实际 ${uq_idx}）"
log "关键命名约束齐全 ✓"

# 5) 幂等：再跑一次不应报错、不应重复记账
log "二次迁移（幂等）..."
pnpm -C "$ROOT_DIR" -F @cb/db migrate
applied2="$(psql "$DATABASE_URL" -tAc 'SELECT count(*) FROM schema_migrations')"
[ "$applied2" = "$expected" ] || fail "二次迁移后记账数变化 ${applied2} != ${expected}"

log "迁移集成全部通过 ✓"
