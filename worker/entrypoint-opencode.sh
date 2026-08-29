#!/bin/sh
set -eu

export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-/opt/opencode}"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"

requested_version="${OPENCODE_VERSION:-latest}"
marker="$NPM_CONFIG_PREFIX/.installed-version"
installed_version=""

if [ -f "$marker" ]; then
  installed_version="$(sed -n '1p' "$marker")"
fi

if ! command -v opencode >/dev/null 2>&1 || [ "$installed_version" != "$requested_version" ]; then
  echo "[opencode-worker] Installing official opencode-ai@$requested_version at runtime..."
  npm install --global "opencode-ai@$requested_version"
  printf '%s\n' "$requested_version" > "$marker"
fi

echo "[opencode-worker] $(opencode --version)"
exec node /app/server.mjs
