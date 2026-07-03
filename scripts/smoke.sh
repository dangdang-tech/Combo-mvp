#!/usr/bin/env bash
# 端到端冒烟（O-05）。对已起栈的全栈做最小可用断言：进程活着 + 五依赖就绪 + 三条硬规则在协议面成立。
# 不依赖 Docker 本身：只要 API/Logto/MinIO 端点可达即可（CI 临时容器或 compose 起栈后均可跑）。
# 任一断言失败立即非零退出（set -e + 显式校验）。
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"
WEB_BASE="${WEB_BASE:-http://localhost}"
LOGTO_ISSUER="${LOGTO_ISSUER:-http://localhost:3001/oidc}"

pass() { printf '\033[1;32m[pass]\033[0m %s\n' "$*"; }
fail() {
  printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2
  exit 1
}
log() { printf '\033[1;34m[smoke]\033[0m %s\n' "$*"; }

command -v curl >/dev/null 2>&1 || fail "需要 curl"

# 0) 前置：API 必须可达；不可达多半是【未起栈（无 Docker）】，给清晰指引而非裸 curl 错误。
#    smoke 设计为「起栈后」跑（与 acceptance-smoke 的优雅 need-docker 退出不同：基础冒烟要求栈已起，失败即非零）。
if ! curl -fsS -o /dev/null --max-time 5 "${API_BASE}/health" 2>/dev/null; then
  fail "API（${API_BASE}）不可达——请先起 live 全栈：cp .env.compose.example .env && 填密钥 && ./scripts/start.sh（需 Docker）。"
fi

# 1) liveness：/health 200 且 status=ok
log "1 GET ${API_BASE}/health"
health="$(curl -fsS "${API_BASE}/health")" || fail "/health 不可达"
echo "$health" | grep -q '"status":"ok"' || fail "/health 未返回 status=ok：$health"
pass "/health = ok"

# 2) readiness：/ready 含五 required 依赖键
log "2 GET ${API_BASE}/ready"
ready="$(curl -fsS "${API_BASE}/ready")" || fail "/ready 不可达"
for dep in db redis_queue redis_hot minio logto llm; do
  echo "$ready" | grep -q "\"name\":\"${dep}\"" || fail "/ready 缺依赖键 ${dep}：$ready"
done
echo "$ready" | grep -q '"ready":true' || fail "/ready ready!=true（依赖未就绪）：$ready"
pass "/ready 五依赖结构齐全且 ready=true"

# 3) 绝不裸露错误码：未知路由 → ErrorEnvelope（userMessage 人话 + 不裸 code/堆栈）
#    不用 curl -f（-f 在 4xx/5xx 直接吞掉响应体，断言就拿不到 body 了）；显式取 状态码 + body。
log "3 GET ${API_BASE}/api/v1/__not_exist__（期望 404 ErrorEnvelope）"
code404="$(curl -sS -o /dev/null -w '%{http_code}' "${API_BASE}/api/v1/__not_exist__")" || fail "/api/v1/__not_exist__ 不可达"
[ "$code404" = "404" ] || fail "未知路由期望 404，实际 ${code404}"
body404="$(curl -sS "${API_BASE}/api/v1/__not_exist__")" || fail "/api/v1/__not_exist__ 不可达"
echo "$body404" | grep -q '"userMessage"' || fail "404 未返回 userMessage（裸露错误？）：$body404"
echo "$body404" | grep -q '"code"' && fail "404 body 含 code（违反对外不含 code，D1）：$body404"
echo "$body404" | grep -qi 'stack\|Error:' && fail "404 body 含堆栈/Error:（违反绝不裸露错误码）：$body404"
pass "未知路由返回 404 ErrorEnvelope（含 userMessage、无 code、无堆栈）"

# 4) 受保护路由未带 token → 401 ErrorEnvelope（/me 走 requireAuth；骨架期 verify 恒 null → 401）
#    旧版断言 501 是错的：/me 有鉴权前置守卫，无 token 必先被 401 拦下，到不了 501 占位 handler。
log "4 GET ${API_BASE}/api/v1/me（无 token，期望 401 ErrorEnvelope）"
code401="$(curl -sS -o /dev/null -w '%{http_code}' "${API_BASE}/api/v1/me")" || fail "/api/v1/me 不可达"
[ "$code401" = "401" ] || fail "/me 未带 token 期望 401，实际 ${code401}"
me="$(curl -sS "${API_BASE}/api/v1/me")" || fail "/api/v1/me 不可达"
echo "$me" | grep -q '"userMessage"' || fail "/me 401 未返回 ErrorEnvelope：$me"
echo "$me" | grep -q '"code"' && fail "/me 401 body 含 code（违反对外不含 code，D1）：$me"
echo "$me" | grep -qi 'stack\|Error:' && fail "/me 401 body 含堆栈/Error:（违反绝不裸露错误码）：$me"
pass "/api/v1/me 未带 token 返回 401 ErrorEnvelope（含 userMessage、无 code、无堆栈）"

# 5) Logto OIDC discovery 可达且 issuer 等于配置值、jwks_uri 存在（O-04 依赖口径；issuer 断言对齐 Codex#11）
log "5 GET ${LOGTO_ISSUER}/.well-known/openid-configuration"
disc_code="$(curl -sS -o /dev/null -w '%{http_code}' "${LOGTO_ISSUER}/.well-known/openid-configuration")" || fail "Logto discovery 不可达"
[ "$disc_code" = "200" ] || fail "Logto discovery 期望 200，实际 ${disc_code}"
disc="$(curl -sS "${LOGTO_ISSUER}/.well-known/openid-configuration")" || fail "Logto discovery 不可达"
echo "$disc" | grep -q '"issuer"' || fail "discovery 缺 issuer：$disc"
# issuer 严格等于 LOGTO_ISSUER（容忍冒号后空格的 pretty JSON）
echo "$disc" | grep -Eq "\"issuer\"[[:space:]]*:[[:space:]]*\"${LOGTO_ISSUER}\"" || fail "discovery issuer != ${LOGTO_ISSUER}（与配置不一致）：$disc"
echo "$disc" | grep -q '"jwks_uri"' || fail "discovery 缺 jwks_uri：$disc"
pass "Logto OIDC discovery issuer == ${LOGTO_ISSUER} 且含 jwks_uri"

# 6) Web 静态站可达（nginx 反代）—— 可选，WEB_BASE 不可达时跳过
log "6 GET ${WEB_BASE}/（可选）"
if curl -fsS -o /dev/null "${WEB_BASE}/" 2>/dev/null; then
  pass "Web 静态站可达"
else
  log "Web 未起或不可达，跳过（非阻塞）"
fi

pass "冒烟全部通过"
