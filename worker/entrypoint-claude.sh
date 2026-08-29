#!/bin/sh
set -eu

export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-/opt/claude}"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"

requested_version="${CLAUDE_VERSION:-latest}"
marker="$NPM_CONFIG_PREFIX/.installed-version"
installed_version=""

if [ -f "$marker" ]; then
  installed_version="$(sed -n '1p' "$marker")"
fi

if ! command -v claude >/dev/null 2>&1 || [ "$installed_version" != "$requested_version" ]; then
  echo "[claude-worker] Installing official @anthropic-ai/claude-code@$requested_version at runtime..."
  npm install --global "@anthropic-ai/claude-code@$requested_version"
  printf '%s\n' "$requested_version" > "$marker"
fi

echo "[claude-worker] $(claude --version)"
exec node /app/server.mjs
