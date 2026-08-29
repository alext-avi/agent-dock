#!/bin/sh
set -eu

export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-/opt/codex}"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"

requested_version="${CODEX_VERSION:-latest}"
marker="$NPM_CONFIG_PREFIX/.installed-version"
installed_version=""

if [ -f "$marker" ]; then
  installed_version="$(sed -n '1p' "$marker")"
fi

if ! command -v codex >/dev/null 2>&1 || [ "$installed_version" != "$requested_version" ]; then
  echo "[worker] Installing official @openai/codex@$requested_version at runtime..."
  npm install --global "@openai/codex@$requested_version"
  printf '%s\n' "$requested_version" > "$marker"
fi

echo "[worker] $(codex --version)"
exec node /app/server.mjs
