#!/usr/bin/env bash
# 生产构建产物不得包含测试、fixture 或测试辅助文件。
set -euo pipefail

leaked_files=$(
  find apps packages -type f -path '*/dist/*' \
    \( -path '*/__tests__/*' -o -path '*/test/*' -o -name '*.test.*' -o -name '*.spec.*' \) \
    -print
)

if [[ -n "${leaked_files}" ]]; then
  echo 'Test-only files found in production artifacts:' >&2
  echo "${leaked_files}" >&2
  exit 1
fi

echo 'Production artifacts contain no test-only files.'
