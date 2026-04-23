#!/usr/bin/env bash
# CDT 41 agent-API discovery — prints bridge info and pings /health.
# Usage: bash discover.sh
#
# Bridge discovery order (same as call.sh):
#   1. $CDT_AGENT_BRIDGE_FILE
#   2. ./.vscode/cdt-agent-bridge.json
#   3. walk up the directory tree

set -euo pipefail

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
  echo "Bridge file not found. VS Code with CDT 41 extension is not running."
  echo "Searched:"
  echo "  - \$CDT_AGENT_BRIDGE_FILE"
  echo "  - ./.vscode/cdt-agent-bridge.json (walking up)"
  exit 1
fi

echo "Bridge file: $BRIDGE_FILE"
node -e "
const data = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
console.log('Port:             ' + data.port);
console.log('Token:            ' + data.token.substring(0, 8) + '...');
console.log('PID:              ' + data.pid);
console.log('WorkspaceFolder:  ' + data.workspaceFolder);
console.log('ExtensionVersion: ' + (data.extensionVersion || '(unknown)'));
console.log('CreatedAt:        ' + data.createdAt);
console.log('HelperScriptPath: ' + (data.helperScriptPath || '(not set)'));
" "$BRIDGE_FILE"

PORT=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).port)" "$BRIDGE_FILE")
echo ""
echo "Health check:"
curl -sS "http://127.0.0.1:$PORT/health" || echo "  FAILED — bridge not responding"
echo ""
