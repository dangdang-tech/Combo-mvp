#!/bin/sh
# Create an isolated HOME containing a small sample of local Claude/Codex
# session logs, preserving the directory shape expected by agora-import.
set -eu

limit=${AGORA_FIXTURE_LIMIT:-50}
source_home=${SOURCE_HOME:-${HOME:-}}

case "${limit}" in
  ''|*[!0-9]*)
    printf '[Agora] AGORA_FIXTURE_LIMIT must be a positive integer.\n' >&2
    exit 1
    ;;
esac
if [ "${limit}" -lt 1 ]; then
  printf '[Agora] AGORA_FIXTURE_LIMIT must be at least 1.\n' >&2
  exit 1
fi
if [ -z "${source_home}" ] || [ ! -d "${source_home}" ]; then
  printf '[Agora] SOURCE_HOME/HOME is not a readable directory.\n' >&2
  exit 1
fi

if [ "${1:-}" ]; then
  fixture_home=$1
  mkdir -p "${fixture_home}"
else
  fixture_home=$(mktemp -d "${TMPDIR:-/tmp}/agora-upload-home.XXXXXX")
fi

claude_list=$(mktemp "${TMPDIR:-/tmp}/agora-claude-list.XXXXXX")
codex_list=$(mktemp "${TMPDIR:-/tmp}/agora-codex-list.XXXXXX")
trap 'rm -f "${claude_list}" "${codex_list}"' EXIT INT TERM HUP

claude_root="${source_home}/.claude/projects"
codex_root="${source_home}/.codex/sessions"
if [ -d "${claude_root}" ]; then
  find "${claude_root}" -type f -name '*.jsonl' -size +0c | sort >"${claude_list}"
fi
if [ -d "${codex_root}" ]; then
  find "${codex_root}" -type f -name '*.jsonl' -size +0c | sort >"${codex_list}"
fi

count=0
copy_from_list() {
  file=$1
  take=$2
  copied=0
  while IFS= read -r src; do
    if [ "${count}" -ge "${limit}" ] || [ "${copied}" -ge "${take}" ]; then
      break
    fi
    rel=${src#"${source_home}/"}
    dst="${fixture_home}/${rel}"
    if [ -e "${dst}" ]; then
      continue
    fi
    mkdir -p "$(dirname "${dst}")"
    cp "${src}" "${dst}"
    count=$((count + 1))
    copied=$((copied + 1))
  done <"${file}"
}

claude_take=$(((limit + 1) / 2))
codex_take=$((limit - claude_take))
copy_from_list "${claude_list}" "${claude_take}"
copy_from_list "${codex_list}" "${codex_take}"
copy_from_list "${claude_list}" "${limit}"
copy_from_list "${codex_list}" "${limit}"

cat >"${fixture_home}/enter-fake-home.sh" <<EOF
#!/bin/sh
# Start an interactive shell whose HOME is this fixture directory.
set -eu
case "\$0" in
  */*) here=\$(cd "\$(dirname "\$0")" && pwd -P) ;;
  *) here=\$(pwd -P) ;;
esac
export HOME="\${here}"
export AGORA_SESSION_LIMIT="\${AGORA_SESSION_LIMIT:-${limit}}"
PS1="(agora-fake-home) \${PS1:-\$ }"
export PS1
printf '[Agora] Fake HOME is %s\\n' "\${HOME}" >&2
printf '[Agora] Paste the web connect command here; type exit when done.\\n' >&2
exec /bin/sh -i
EOF

cat >"${fixture_home}/run-agora-import.sh" <<EOF
#!/bin/sh
# Run one pasted Agora web connect command with HOME set to this fixture directory.
set -eu
case "\$0" in
  */*) here=\$(cd "\$(dirname "\$0")" && pwd -P) ;;
  *) here=\$(pwd -P) ;;
esac
export HOME="\${here}"
export AGORA_SESSION_LIMIT="\${AGORA_SESSION_LIMIT:-${limit}}"
printf '[Agora] Fake HOME is %s\\n' "\${HOME}" >&2
printf '[Agora] Paste the web connect command, then press Enter:\\n' >&2
IFS= read -r cmd
if [ -z "\${cmd}" ]; then
  printf '[Agora] Empty command; nothing ran.\\n' >&2
  exit 1
fi
exec /bin/sh -c "\${cmd}"
EOF
chmod +x "${fixture_home}/enter-fake-home.sh" "${fixture_home}/run-agora-import.sh"

quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

printf '[Agora] Created isolated HOME with %s session file(s): %s\n' "${count}" "${fixture_home}" >&2
if [ "${count}" -eq 0 ]; then
  printf '[Agora] No non-empty .jsonl sessions were found under %s/.claude/projects or %s/.codex/sessions.\n' "${source_home}" "${source_home}" >&2
  exit 1
fi

printf '\n'
printf 'Enter fake HOME shell:\n'
printf '  cd '
quote "${fixture_home}"
printf ' && sh ./enter-fake-home.sh\n'
printf '\n'
printf 'Run one pasted web connect command:\n'
printf '  cd '
quote "${fixture_home}"
printf ' && sh ./run-agora-import.sh\n'
