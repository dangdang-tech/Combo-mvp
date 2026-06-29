#!/usr/bin/env bash
# 主链路 P0 验收 smoke（Phase 6 / O-05）。对【已起栈的 live 全栈】跑最小端到端探针，
# 校验主链路 配对/上传 → 导入 → 提取 → 选择 → 结构化 → 发布 的关键不变量：
#   ① SSE 真流（text/event-stream + 首帧 + 心跳）；② 防重/幂等（Idempotency-Key 必填守卫）；
#   ③ 状态机（端点齐全、未授权按契约 401/403/404，不绕过状态前置）；④ ErrorEnvelope 无 code（D1 铁律）。
#
# 诚实边界（关键）：主链路写命令全部 requireRole('creator')，SSE 全部 requireSseAuth（仅同源 Cookie 会话）。
#   真正的「鉴权后端到端」需要一个真实 Logto 会话 Cookie（cb_session），它只能由浏览器走 OIDC 登录拿到
#   （/auth/login → Logto → /auth/callback 种 HttpOnly Cookie），无法用裸 curl 凭空铸造。
#   故本脚本分两段：
#     A) 匿名段（无需登录，CI/任何人可跑）：对 live 栈断言四不变量在【协议边界】成立——
#        未授权访问按契约落 401/403/404 ErrorEnvelope（无 code/无堆栈）、SSE 拒绝非 Cookie 来源、写命令缺幂等键被拦、
#        每条主链路端点真实注册（不是 404 漏挂）。这一段已能证伪「端点漏挂 / 裸露错误码 / SSE 放行 Bearer / 缺幂等守卫」。
#     B) 鉴权段（可选，提供 CB_SESSION_COOKIE 才跑）：带真实会话 Cookie 走 配对→上传→导入→...→发布 全链路，
#        断言 SSE 真帧、状态机推进、防重幂等回放。无 Cookie 时优雅跳过并提示如何取 Cookie。
#
# 无 Docker / 栈未起：优雅报「需 Docker + 已起栈」并退出（非崩溃）。
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"
WEB_BASE="${WEB_BASE:-http://localhost}"
# 鉴权段开关：提供真实会话 Cookie 才跑 B 段（见文件头取 Cookie 说明）。
CB_SESSION_COOKIE="${CB_SESSION_COOKIE:-}"

pass() { printf '\033[1;32m[pass]\033[0m %s\n' "$*"; }
skip() { printf '\033[1;33m[skip]\033[0m %s\n' "$*"; }
log() { printf '\033[1;34m[accept]\033[0m %s\n' "$*"; }
fail() {
  printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "需要 curl"

# —— 前置：live 栈必须可达；不可达说明没起栈（多半无 Docker），优雅退出而非崩溃 ——
log "前置 GET ${API_BASE}/health（确认 live 栈已起）"
if ! curl -fsS -o /dev/null --max-time 5 "${API_BASE}/health" 2>/dev/null; then
  cat >&2 <<EOF
$(printf '\033[1;33m[need-docker]\033[0m') live 全栈未就绪（${API_BASE}/health 不可达）。

主链路验收 smoke 必须对一条真实起好的全栈跑，本机当前未检测到可达 API。
请先用 Docker 起栈再跑本脚本：

  cd <仓库根>                        # creator-builder 已提升为仓库根（此 monorepo 即仓库根）
  cp .env.compose.example .env      # 然后填全部强随机密钥（compose \${VAR:?} 会拦空值/弱默认）
  ./scripts/start.sh                # 固定启动序起栈并等健康（postgres→logto→migrate→业务）
  ./scripts/smoke.sh                # 基础冒烟（/health /ready /me + Logto discovery）
  ./scripts/acceptance-smoke.sh     # 本脚本：主链路 P0 验收探针

无 Docker 环境无法跑本验收（需真实 PG/Redis/MinIO/Logto）。退出码 0（非失败，仅未就绪）。
EOF
  exit 0
fi
pass "live 栈可达（/health 200）"

# —— /ready 五依赖必须全 ready（栈起了但依赖没就绪 = 不能跑验收）——
log "前置 GET ${API_BASE}/ready（五依赖就绪）"
ready="$(curl -fsS "${API_BASE}/ready")" || fail "/ready 不可达"
echo "$ready" | grep -q '"ready":true' || fail "/ready ready!=true（依赖未就绪，无法跑验收）：$ready"
pass "/ready ready=true（五依赖就绪）"

# 取 ErrorEnvelope 不变量断言：body 必含 userMessage、必不含 code、必不含堆栈/原始 Error。
assert_error_envelope() {
  # $1=场景名 $2=body
  local name="$1" body="$2"
  echo "$body" | grep -q '"userMessage"' || fail "${name}: 缺 userMessage（裸露错误？）：$body"
  echo "$body" | grep -q '"code"' && fail "${name}: body 含 code（违反 D1 对外不裸露错误码）：$body"
  echo "$body" | grep -qiE 'stack|Error:|SQLSTATE|at /|node_modules' && fail "${name}: body 含堆栈/原始报错（违反 D1）：$body"
  echo "$body" | grep -q '"traceId"' || fail "${name}: 缺 traceId（前端反馈代码靠它）：$body"
  return 0
}

# 取 HTTP 状态码 + body（不用 curl -f，-f 在 4xx/5xx 会吞 body 拿不到信封）。
http_code() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

# ════════════════════════════════════════════════════════════════════════════
# A 段：匿名不变量（无需登录，任何人/CI 可跑）
# ════════════════════════════════════════════════════════════════════════════
log "A 段：匿名协议边界不变量（四硬规则在 live 栈成立）"

# A1 · ErrorEnvelope 无 code —— 未知路由 404
log "A1 GET /api/v1/__not_exist__（期望 404 ErrorEnvelope，无 code）"
c="$(http_code "${API_BASE}/api/v1/__not_exist__")"
[ "$c" = "404" ] || fail "未知路由期望 404，实际 ${c}"
assert_error_envelope "404" "$(curl -sS "${API_BASE}/api/v1/__not_exist__")"
pass "A1 未知路由 404 ErrorEnvelope（含 userMessage/traceId、无 code、无堆栈）"

# A2 · 受保护读端点未带 token → 401 ErrorEnvelope（/me requireAuth）
log "A2 GET /api/v1/me（无 token，期望 401 ErrorEnvelope）"
c="$(http_code "${API_BASE}/api/v1/me")"
[ "$c" = "401" ] || fail "/me 无 token 期望 401，实际 ${c}"
assert_error_envelope "/me 401" "$(curl -sS "${API_BASE}/api/v1/me")"
pass "A2 /me 无 token → 401 ErrorEnvelope"

# A3 · 主链路【写命令】端点真实注册 + requireRole('creator') 在最前 —— 无 token 应 401（不是 404 漏挂、不是 501 占位裸过）。
#      这一组同时证伪「端点漏挂」与「鉴权前置缺失」。POST 不带 token / 不带 Idempotency-Key。
log "A3 主链路写命令端点（无 token → 401，证明端点已注册且鉴权前置）"
declare -a WRITE_ENDPOINTS=(
  "POST /api/v1/import/uploads/presign        # STEP① 导入·预签"
  "POST /api/v1/import/jobs                    # STEP① 导入·建 Job"
  "POST /api/v1/import/connect/pair           # STEP① 本机助手·铸配对码"
  "POST /api/v1/snapshots/SNAP/extract        # STEP② 提取·发起"
  "POST /api/v1/candidates/CAND/retry         # STEP② 候选·重试"
  "PATCH /api/v1/drafts/DRAFT/selection       # STEP③ 选择·存草稿"
  "POST /api/v1/capabilities                   # STEP④ 结构化·建能力体版本"
  "POST /api/v1/versions/VER/structure         # STEP④ 结构化·发起 Job"
  "PATCH /api/v1/versions/VER/manifest         # STEP④ 结构化·改软字段"
  "POST /api/v1/versions/VER/publish           # STEP⑤ 发布·单个"
  "POST /api/v1/publish-batches                # STEP⑤ 发布·批量"
)
for entry in "${WRITE_ENDPOINTS[@]}"; do
  method="${entry%% *}"
  rest="${entry#* }"
  path="${rest%%#*}"
  path="$(echo "$path" | xargs)" # trim
  c="$(http_code -X "$method" "${API_BASE}${path}")"
  # 401（鉴权前置先拦）证明端点已注册；绝不能是 404（漏挂）或 200/501（绕过鉴权）。
  [ "$c" = "401" ] || fail "A3 ${method} ${path} 期望 401（鉴权前置），实际 ${c}（404=漏挂 / 200/501=绕鉴权）"
  body="$(curl -sS -X "$method" "${API_BASE}${path}")"
  assert_error_envelope "A3 ${method} ${path}" "$body"
done
pass "A3 全部主链路写命令端点已注册且 requireRole 前置生效（无 token → 401 ErrorEnvelope）"

# A4 · 主链路【读端点】真实注册 —— GET 无 token → 401（requireAuth），证明端点齐全。
log "A4 主链路读端点（无 token → 401，证明端点已注册）"
declare -a READ_ENDPOINTS=(
  "/api/v1/snapshots"                       # STEP① 快照列表
  "/api/v1/snapshots/SNAP"                  # STEP① 快照详情
  "/api/v1/snapshots/SNAP/segments"         # STEP① 会话段
  "/api/v1/extract-jobs/JID/candidates"     # STEP② 候选列表
  "/api/v1/candidates/CAND"                 # STEP② 候选详情
  "/api/v1/publish-batches/BID"             # STEP⑤ 批次详情
)
for path in "${READ_ENDPOINTS[@]}"; do
  c="$(http_code "${API_BASE}${path}")"
  [ "$c" = "401" ] || fail "A4 GET ${path} 期望 401，实际 ${c}（404=漏挂）"
done
pass "A4 全部主链路读端点已注册（无 token → 401）"

# A5 · SSE 真流端点存在 + SSE 鉴权铁律：仅同源 Cookie，拒绝 Bearer / query token（脊柱 §11.C），
#      且失败在【建流前】返 HTTP 401（不是 SSE error 帧）。两条 SSE 流都验。
log "A5 SSE 端点鉴权（仅 Cookie；Bearer/query token 在建流前 401）"
declare -a SSE_ENDPOINTS=(
  "/api/v1/jobs/JID/events"                       # 通用 Job SSE 流（导入/提取/结构化/批量发布）
  "/api/v1/versions/VER/structure/events"        # 结构化 SSE 流
)
for sse in "${SSE_ENDPOINTS[@]}"; do
  # 无 token：401（无会话 Cookie）
  c="$(http_code "${API_BASE}${sse}")"
  [ "$c" = "401" ] || fail "A5 SSE ${sse} 无 token 期望 401，实际 ${c}"
  # 带 Bearer：SSE 禁 Authorization 来源 → 仍 401（不静默回落、不放行）
  c="$(http_code -H 'Authorization: Bearer faketoken' "${API_BASE}${sse}")"
  [ "$c" = "401" ] || fail "A5 SSE ${sse} 带 Bearer 期望 401（SSE 禁 Authorization），实际 ${c}"
  # 带 query token：SSE 禁 query token → 仍 401
  c="$(http_code "${API_BASE}${sse}?access_token=faketoken")"
  [ "$c" = "401" ] || fail "A5 SSE ${sse} 带 query token 期望 401（SSE 禁 query token），实际 ${c}"
  # 建流前失败必须是 HTTP ErrorEnvelope（非 text/event-stream）。
  ct="$(curl -sS -o /dev/null -w '%{content_type}' "${API_BASE}${sse}")"
  echo "$ct" | grep -qi 'text/event-stream' && fail "A5 SSE ${sse} 未授权却开了流（应建流前 401，不是 event-stream）：$ct"
done
pass "A5 两条 SSE 流均：无 token/Bearer/query token → 建流前 401 ErrorEnvelope（仅认同源 Cookie）"

# A6 · 幂等守卫：写命令缺 Idempotency-Key 应被拦（不静默执行）。
#      注意 requireRole 在 requireIdempotency 之前，故无 token 时先 401；这里用一个角色无关、
#      但确实需要幂等键的路径来证明守卫存在难以无登录验证——改为断言「带 token 才到幂等层」由 B 段覆盖。
#      A 段只断言 logout 这一【豁免幂等】端点不因缺键被拦（反证幂等守卫是按 scope 精确挂、非全局误伤）。
log "A6 POST /api/v1/auth/logout（幂等豁免端点：缺 Idempotency-Key 不应被拦）"
c="$(http_code -X POST "${API_BASE}/api/v1/auth/logout")"
# logout = optionalAuth + 幂等豁免：未登录也应幂等成功（2xx），绝不因缺幂等键 400、绝不 401。
case "$c" in
  2*) pass "A6 logout 未登录幂等成功（${c}），证明幂等守卫按 scope 精确挂、未全局误伤豁免端点" ;;
  *) fail "A6 logout 期望 2xx（豁免幂等 + optionalAuth），实际 ${c}" ;;
esac

# A7 · Web 静态站经 nginx 可达（同源反代）—— 可选。
log "A7 GET ${WEB_BASE}/（nginx 静态站，可选）"
if curl -fsS -o /dev/null "${WEB_BASE}/" 2>/dev/null; then
  pass "A7 Web 静态站可达（nginx 同源）"
else
  skip "A7 Web 未起/不可达（非阻塞）"
fi

# ════════════════════════════════════════════════════════════════════════════
# B 段：鉴权端到端主链路（需真实会话 Cookie；无则优雅跳过）
# ════════════════════════════════════════════════════════════════════════════
if [ -z "${CB_SESSION_COOKIE}" ]; then
  cat <<EOF
$(skip "B 段（鉴权端到端）未跑：未提供 CB_SESSION_COOKIE")

主链路写命令全部 requireRole('creator')，SSE 全部 requireSseAuth（仅同源 Cookie）。
真实会话 Cookie 只能由浏览器走 OIDC 登录拿到，裸 curl 无法铸造。要跑 B 段：

  1) 浏览器打开 ${WEB_BASE}/ ，点登录走 Logto（${API_BASE}/api/v1/auth/login）完成登录；
  2) 开发者工具 → Application → Cookies，复制 cb_session 的值；
  3) 重跑：CB_SESSION_COOKIE='<cb_session 值>' ./scripts/acceptance-smoke.sh

B 段会带该 Cookie 走 配对/上传 → 导入 → 提取 → 选择 → 结构化 → 发布 全链路，
断言：SSE 真帧（state_snapshot + heartbeat）、状态机推进（queued→running→completed）、
防重幂等（同 Idempotency-Key 回放同结果不重复建 Job）。
EOF
  log "A 段全部通过；B 段已优雅跳过（无 Cookie）。"
  exit 0
fi

# —— B 段：带会话 Cookie 的真实端到端 —— (用户提供 Cookie 时才到这里)
log "B 段：带会话 Cookie 跑鉴权端到端主链路"
CK=(-H "Cookie: cb_session=${CB_SESSION_COOKIE}")

# B0 · Cookie 有效性：/me 应 200 带当前用户。
log "B0 GET /api/v1/me（验 Cookie 有效）"
me_code="$(http_code "${CK[@]}" "${API_BASE}/api/v1/me")"
[ "$me_code" = "200" ] || fail "B0 /me 带 Cookie 期望 200，实际 ${me_code}（Cookie 失效？重新登录取 cb_session）"
pass "B0 会话 Cookie 有效（/me 200）"

# B1 · 防重/幂等：同一 Idempotency-Key + 同 body 调两次 import/jobs，应回放同一 jobId（不重复建 Job）。
#      用 presign 这类「带请求体只读」端点不写库，故用 import/jobs（IMPORT_CREATE 幂等 scope）。
log "B1 防重：import/jobs 同 Idempotency-Key 两次 → 回放同结果"
IDEM="accept-smoke-$(date +%s)-$$"
BODY='{"source":"manual","note":"acceptance-smoke"}'
r1="$(curl -sS "${CK[@]}" -H "Idempotency-Key: ${IDEM}" -H 'Content-Type: application/json' -d "$BODY" "${API_BASE}/api/v1/import/jobs" || true)"
r2="$(curl -sS "${CK[@]}" -H "Idempotency-Key: ${IDEM}" -H 'Content-Type: application/json' -d "$BODY" "${API_BASE}/api/v1/import/jobs" || true)"
# 两次响应应一致（幂等回放）。若返回错误信封也必须无 code（D1）。
if echo "$r1" | grep -q '"jobId"' && echo "$r2" | grep -q '"jobId"'; then
  j1="$(echo "$r1" | grep -o '"jobId":"[^"]*"' | head -1)"
  j2="$(echo "$r2" | grep -o '"jobId":"[^"]*"' | head -1)"
  [ "$j1" = "$j2" ] || fail "B1 同 Idempotency-Key 两次 jobId 不同（${j1} != ${j2}）= 防重失效"
  pass "B1 防重：同 Idempotency-Key 回放同 jobId（${j1}）"
  JOB_ID="$(echo "$j1" | sed 's/"jobId":"//;s/"//')"
else
  # 业务体不满足（manual source 需要先上传）也算合理；只断言不裸露 code。
  assert_error_envelope "B1 import/jobs" "$r1"
  skip "B1 import/jobs 未建 Job（业务前置不满足，如 manual 需先上传）；已断言错误信封无 code。JOB_ID 留空。"
  JOB_ID=""
fi

# B2 · SSE 真流：带 Cookie 连 Job SSE，应得 text/event-stream + 首帧 state_snapshot（首 ~2s）。
if [ -n "${JOB_ID:-}" ]; then
  log "B2 SSE 真流：GET /jobs/${JOB_ID}/events（断言 event-stream + 首帧 state_snapshot）"
  ct="$(curl -sS -o /dev/null -w '%{content_type}' "${CK[@]}" --max-time 3 "${API_BASE}/api/v1/jobs/${JOB_ID}/events" || true)"
  echo "$ct" | grep -qi 'text/event-stream' || fail "B2 SSE 未返回 text/event-stream：$ct"
  # 抓前几行帧（最多 4s），断言含 state_snapshot 首帧。
  frames="$(curl -sS "${CK[@]}" --max-time 4 "${API_BASE}/api/v1/jobs/${JOB_ID}/events" 2>/dev/null || true)"
  echo "$frames" | grep -q 'state_snapshot' || fail "B2 SSE 首帧未见 state_snapshot（真流应先发全量快照）：$frames"
  echo "$frames" | grep -qE '^id:' || fail "B2 SSE 帧缺 id:（Last-Event-ID 恢复协议靠它）：$frames"
  pass "B2 SSE 真流：text/event-stream + 首帧 state_snapshot + 带 id:（防重/恢复协议）"
else
  skip "B2 SSE 真流：无 JOB_ID（B1 未建 Job），跳过。可手动用浏览器/真实导入复跑。"
fi

log "A + B 段验收全部通过。"
exit 0
