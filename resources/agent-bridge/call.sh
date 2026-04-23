#!/usr/bin/env bash
# CDT 41 agent-API helper — invoke a whitelisted bridge command over HTTP.
# Usage: bash call.sh <command-suffix> '<JSON-args>'
# Example: bash call.sh debug.start '{"rootProject":"C:/conf","infobase":"File=...","platformPath":"C:/Program Files/1cv8/.../bin"}'
#
# Bridge discovery order:
#   1. $CDT_AGENT_BRIDGE_FILE (explicit override)
#   2. ./.vscode/cdt-agent-bridge.json (current workspace)
#   3. walk up the directory tree looking for .vscode/cdt-agent-bridge.json

set -euo pipefail

CMD_SUFFIX="${1:-}"
ARGS_JSON="${2-}"
if [ -z "$ARGS_JSON" ]; then
  ARGS_JSON='{}'
fi

if [ -z "$CMD_SUFFIX" ]; then
  echo '{"success":false,"error":"usage: call.sh <command-suffix> <JSON-args>"}' >&2
  exit 1
fi

BRIDGE_FILE=""
if [ -n "${CDT_AGENT_BRIDGE_FILE:-}" ] && [ -f "$CDT_AGENT_BRIDGE_FILE" ]; then
  BRIDGE_FILE="$CDT_AGENT_BRIDGE_FILE"
else
  DIR="$(pwd)"
  while [ -n "$DIR" ] && [ "$DIR" != "/" ]; do
    if [ -f "$DIR/.vscode/cdt-agent-bridge.json" ]; then
      BRIDGE_FILE="$DIR/.vscode/cdt-agent-bridge.json"
      break
    fi
    PARENT="$(dirname "$DIR")"
    if [ "$PARENT" = "$DIR" ]; then
      break
    fi
    DIR="$PARENT"
  done
fi

if [ -z "$BRIDGE_FILE" ]; then
  echo '{"success":false,"error":"bridge file not found - VS Code not running with CDT 41 extension?"}' >&2
  exit 1
fi

PORT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).port)" "$BRIDGE_FILE")
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).token)" "$BRIDGE_FILE")

if [ -z "$PORT" ] || [ -z "$TOKEN" ]; then
  echo '{"success":false,"error":"failed to parse bridge file"}' >&2
  exit 1
fi

FULL_CMD="1c-metadata-tree.agent.$CMD_SUFFIX"

node -e "console.log(JSON.stringify({name: process.argv[1], args: JSON.parse(process.argv[2])}))" "$FULL_CMD" "$ARGS_JSON" \
  | curl -sS -X POST "http://127.0.0.1:$PORT/command" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    --data-binary @-
