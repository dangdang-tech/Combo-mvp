#!/usr/bin/env bash
# 从公网入口验证 Cloud Review 的 Cookie 访问闸、页面、API、dev bootstrap 与 Runtime。
set -euo pipefail

REVIEW_BASE_URL="${REVIEW_BASE_URL:?REVIEW_BASE_URL 必填，例如 https://review.buildwithcombo.com}"
REVIEW_ACCESS_TOKEN="${REVIEW_ACCESS_TOKEN:?REVIEW_ACCESS_TOKEN 必填}"
REVIEW_CURL_TIMEOUT="${REVIEW_CURL_TIMEOUT:-15}"
REVIEW_BASE_URL="${REVIEW_BASE_URL%/}"

pass() { printf '[pass] %s\n' "$*"; }
fail() {
  printf '[fail] %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail '需要 curl'
cookie_jar="$(mktemp)"
connect_headers="$(mktemp)"
home_headers="$(mktemp)"
home_asset_headers="$(mktemp)"
runtime_headers="$(mktemp)"
runtime_asset_headers="$(mktemp)"
token_header_config="$(mktemp)"
trap 'rm -f "$cookie_jar" "$connect_headers" "$home_headers" "$home_asset_headers" "$runtime_headers" "$runtime_asset_headers" "$token_header_config"' EXIT
printf 'header = "X-Review-Token: %s"\n' "$REVIEW_ACCESS_TOKEN" > "$token_header_config"
chmod 600 "$token_header_config"
unset REVIEW_ACCESS_TOKEN
curl_common=(--silent --show-error --location --max-time "$REVIEW_CURL_TIMEOUT" --retry 3 --retry-all-errors)
curl_direct=(--silent --show-error --max-time "$REVIEW_CURL_TIMEOUT" --retry 3 --retry-all-errors)

anonymous_code="$(curl "${curl_common[@]}" --dump-header "$connect_headers" --output /dev/null --write-out '%{http_code}' "$REVIEW_BASE_URL/")"
test "$anonymous_code" = 401 || fail "匿名首页应被 Review 访问闸拦截，实际 HTTP $anonymous_code"
grep -Eiq '^x-combo-review-gate:[[:space:]]*required' "$connect_headers" || fail '匿名首页 401 缺少 Review 访问闸标识'
pass '匿名访问被 401 拦截'

# 本机助手不会带 Review Cookie；伪 pairing code / 假二进制可以被应用拒绝，但不能被访问闸拦截。
connect_prefix="${REVIEW_CONNECT_PREFIX:-/api/v1/import/connect}"
script_code="$(curl "${curl_common[@]}" --output /dev/null --write-out '%{http_code}' "$REVIEW_BASE_URL${connect_prefix}/script?code=000000")"
test "$script_code" != 401 || fail '导入脚本通道被 Review 访问闸错误拦截'
[[ ! "$script_code" =~ ^5 ]] || fail "导入脚本通道返回服务端错误 HTTP $script_code"
bin_code="$(curl "${curl_common[@]}" --output /dev/null --write-out '%{http_code}' "$REVIEW_BASE_URL${connect_prefix}/bin/not-a-real-asset")"
test "$bin_code" != 401 || fail '导入二进制通道被 Review 访问闸错误拦截'
[[ ! "$bin_code" =~ ^5 ]] || fail "导入二进制通道返回服务端错误 HTTP $bin_code"
upload_code="$(curl "${curl_common[@]}" --dump-header "$connect_headers" --header 'content-type: application/json' --data '{}' --output /dev/null --write-out '%{http_code}' "$REVIEW_BASE_URL${connect_prefix}/upload")"
# 缺 pairing Bearer 时应用本身也会返回 401；访问闸 401 会带对应标识头。
if grep -Eiq '^x-combo-review-gate:[[:space:]]*required' "$connect_headers"; then
  fail '导入上传通道被 Review 访问闸错误拦截'
fi
[[ ! "$upload_code" =~ ^5 ]] || fail "导入上传通道返回服务端错误 HTTP $upload_code"
pass "导入助手公网通道到达应用层（script=${script_code} bin=${bin_code} upload=${upload_code}）"

enter_page="$(curl "${curl_common[@]}" --fail "$REVIEW_BASE_URL/__review/enter")" || fail '云端访问页不可达'
printf '%s' "$enter_page" | grep -q '进入云端 Review' || fail '云端访问页标识不正确'
pass '云端访问页可达'

wrong_access_code="$(curl "${curl_direct[@]}" --dump-header "$connect_headers" --header 'X-Review-Token: invalid-review-token' --output /dev/null --write-out '%{http_code}' -X POST "$REVIEW_BASE_URL/__review/access")"
test "$wrong_access_code" = 403 || fail "错误 Review token 应被 403 拒绝，实际 HTTP $wrong_access_code"
if grep -Eiq '^set-cookie:' "$connect_headers"; then
  fail '错误 Review token 不得收到访问 Cookie'
fi

access_code="$(curl "${curl_direct[@]}" --config "$token_header_config" --dump-header "$connect_headers" --cookie-jar "$cookie_jar" --output /dev/null --write-out '%{http_code}' -X POST "$REVIEW_BASE_URL/__review/access")"
test "$access_code" = 204 || fail "Review Cookie 交换失败，HTTP $access_code"
grep -Eiq '^set-cookie: combo_review_access=[^;]+; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict' "$connect_headers" || fail 'Review Cookie 缺少预期安全属性'
pass 'Review token 已换成安全的 HttpOnly Cookie'

home="$(curl "${curl_common[@]}" --cookie "$cookie_jar" --dump-header "$home_headers" --fail "$REVIEW_BASE_URL/")" || fail '授权后首页不可达'
printf '%s' "$home" | grep -qi '<html' || fail '首页未返回 HTML'
grep -Eiq '^cache-control:.*no-store' "$home_headers" || fail '产品 SPA shell 必须返回 Cache-Control: no-store'
home_asset_path="$(printf '%s' "$home" | grep -Eo 'assets/[^"[:space:]]+\.(css|js)' | sed -n '1p' || true)"
test -n "$home_asset_path" || fail '产品首页未引用内容 hash 静态资源'
curl "${curl_direct[@]}" --cookie "$cookie_jar" --dump-header "$home_asset_headers" --output /dev/null --fail "$REVIEW_BASE_URL/$home_asset_path" || fail '产品内容 hash 静态资源不可达'
grep -Eiq '^cache-control:.*immutable' "$home_asset_headers" || fail '产品内容 hash 静态资源必须使用 immutable 缓存'
pass '授权后产品首页可达，SPA shell 与内容 hash 资源缓存策略正确'

bootstrap="$(curl "${curl_common[@]}" --cookie "$cookie_jar" --fail "$REVIEW_BASE_URL/__review/bootstrap")" || fail 'bootstrap 页面不可达'
printf '%s' "$bootstrap" | grep -q 'COMBO · CLOUD REVIEW' || fail 'bootstrap 页面标识不正确'
pass '受保护 bootstrap 页面可达'

login_code="$(curl "${curl_common[@]}" --cookie "$cookie_jar" --cookie-jar "$cookie_jar" --output /dev/null --write-out '%{http_code}' -X POST "$REVIEW_BASE_URL/api/v1/auth/dev-login")"
test "$login_code" = 200 || fail "dev-login bootstrap 失败，HTTP $login_code"
me="$(curl "${curl_common[@]}" --cookie "$cookie_jar" --fail "$REVIEW_BASE_URL/api/v1/me")" || fail 'bootstrap 后 /me 不可达'
printf '%s' "$me" | grep -q '"email"' || fail '/me 未返回测试身份'
pass 'bootstrap 会话可用于受保护 API'

ready="$(curl "${curl_common[@]}" --cookie "$cookie_jar" --fail "$REVIEW_BASE_URL/ready")" || fail '/ready 不可达或未就绪'
printf '%s' "$ready" | grep -q '"ready":true' || fail "/ready 未返回 ready=true：$ready"
pass '公网 API readiness 通过'

runtime_ready="$(curl "${curl_common[@]}" --cookie "$cookie_jar" --fail "$REVIEW_BASE_URL/__review/runtime-ready")" || fail 'Runtime readiness 不可达或未就绪'
printf '%s' "$runtime_ready" | grep -q '"ok":true' || fail "Runtime readiness 未返回 ok=true：$runtime_ready"
pass '公网 Runtime readiness 通过'

runtime="$(curl "${curl_common[@]}" --cookie "$cookie_jar" --dump-header "$runtime_headers" --fail "$REVIEW_BASE_URL/try/")" || fail 'runtime 页面不可达'
printf '%s' "$runtime" | grep -qi '<html' || fail 'runtime 入口未返回 HTML'
grep -Eiq '^cache-control:.*no-store' "$runtime_headers" || fail 'runtime SPA shell 必须返回 Cache-Control: no-store'
runtime_asset_path="$(printf '%s' "$runtime" | grep -Eo 'assets/[^"[:space:]]+\.(css|js)' | sed -n '1p' || true)"
test -n "$runtime_asset_path" || fail 'runtime 入口未引用内容 hash 静态资源'
curl "${curl_direct[@]}" --cookie "$cookie_jar" --dump-header "$runtime_asset_headers" --output /dev/null --fail "$REVIEW_BASE_URL/try/$runtime_asset_path" || fail 'runtime 内容 hash 静态资源不可达'
grep -Eiq '^cache-control:.*immutable' "$runtime_asset_headers" || fail 'runtime 内容 hash 静态资源必须使用 immutable 缓存'
pass 'runtime 静态入口可达，SPA shell 与内容 hash 资源缓存策略正确'

pass "Cloud Review 公网冒烟通过：$REVIEW_BASE_URL"
