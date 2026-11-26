#!/usr/bin/env bash
# Hunter World Online - inicia o servidor
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ é necessário: https://nodejs.org"
  exit 1
fi
[ -d node_modules ] || npm install
echo "Abrindo em http://localhost:${PORT:-8080} (celular: http://SEU-IP:${PORT:-8080})"
node server/server.js
