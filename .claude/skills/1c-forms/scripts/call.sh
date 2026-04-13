#!/usr/bin/env bash
# call.sh — wrapper for web-test runtime (cc-1c-skills)
# Auto-starts ibsrv when given an infobase path instead of a URL.
# Handles: ibsrv lifecycle, path resolution, dependency check, command routing

set -euo pipefail

# ── Paths ──────────────────────────────────────────────────────
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WEBTEST_DIR="${WEBTEST_SCRIPTS:-/c/reps/cc-1c-skills/.claude/skills/web-test/scripts}"
RUN_MJS="$WEBTEST_DIR/run.mjs"
IBSRV_SESSION_FILE="$SKILL_DIR/.ibsrv-session.json"

# ── Validate web-test exists ───────────────────────────────────
if [ ! -f "$RUN_MJS" ]; then
    echo '{"ok":false,"error":"web-test not found at: '"$WEBTEST_DIR"'. Set WEBTEST_SCRIPTS env var to override."}' >&2
    exit 1
fi

# ── Auto-install Playwright deps ──────────────────────────────
if [ ! -d "$WEBTEST_DIR/node_modules" ]; then
    echo '{"status":"installing","message":"Installing Playwright dependencies..."}' >&2
    (cd "$WEBTEST_DIR" && npm install --no-fund --no-audit 2>&1) >&2
fi

# ── ibsrv helpers ─────────────────────────────────────────────

find_ibsrv() {
    local IBSRV=""
    for d in "/c/Program Files/1cv8"/*/bin/ibsrv.exe; do
        [ -f "$d" ] && IBSRV="$d"
    done
    echo "$IBSRV"
}

# is_url <arg> — returns 0 if arg looks like a URL
is_url() {
    [[ "$1" =~ ^https?:// ]]
}

# find_free_port — returns a free TCP port
find_free_port() {
    # Use Python one-liner (available on Windows with modern Python)
    python -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()" 2>/dev/null || echo 8314
}

# ensure_ibsrv <db-path> — starts ibsrv if not already running, returns URL
# Writes session to IBSRV_SESSION_FILE
ensure_ibsrv() {
    local DB_PATH="$1"

    # Check if ibsrv is already running for this DB
    if [ -f "$IBSRV_SESSION_FILE" ]; then
        local EXISTING_PORT EXISTING_PID EXISTING_DB
        EXISTING_PORT=$(python -c "import json; d=json.load(open('$IBSRV_SESSION_FILE')); print(d['port'])" 2>/dev/null || echo "")
        EXISTING_PID=$(python -c "import json; d=json.load(open('$IBSRV_SESSION_FILE')); print(d['pid'])" 2>/dev/null || echo "")
        EXISTING_DB=$(python -c "import json; d=json.load(open('$IBSRV_SESSION_FILE')); print(d['db'])" 2>/dev/null || echo "")

        if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
            # ibsrv is running — check if it's the same DB
            if [ "$EXISTING_DB" = "$DB_PATH" ]; then
                echo "http://localhost:${EXISTING_PORT}/"
                return 0
            else
                # Different DB — kill old and start new
                kill "$EXISTING_PID" 2>/dev/null || true
                sleep 1
            fi
        fi
        rm -f "$IBSRV_SESSION_FILE"
    fi

    local IBSRV
    IBSRV="$(find_ibsrv)"
    if [ -z "$IBSRV" ]; then
        echo '{"ok":false,"error":"ibsrv.exe not found in C:\\Program Files\\1cv8\\"}' >&2
        return 1
    fi

    local PORT
    PORT="$(find_free_port)"
    local DATA_DIR
    DATA_DIR="$(mktemp -d)/ibsrv-$$"
    mkdir -p "$DATA_DIR"

    echo '{"status":"starting","message":"Starting ibsrv on port '"$PORT"'..."}' >&2

    # Start ibsrv in background
    "$IBSRV" \
        --database-path="$DB_PATH" \
        --http-port="$PORT" \
        --http-address=localhost \
        --enable-http-gate \
        --disable-direct-gate \
        --disable-ssh-gate \
        --data="$DATA_DIR" \
        > "$DATA_DIR/ibsrv.log" 2>&1 &
    local IBSRV_PID=$!

    # Wait for ibsrv to become ready (max 30s)
    local URL="http://localhost:${PORT}/"
    local ATTEMPTS=0
    while [ $ATTEMPTS -lt 60 ]; do
        if ! kill -0 "$IBSRV_PID" 2>/dev/null; then
            echo '{"ok":false,"error":"ibsrv died. Check '"$DATA_DIR/ibsrv.log"'"}' >&2
            cat "$DATA_DIR/ibsrv.log" >&2
            return 1
        fi
        if curl -s -o /dev/null -w "" --connect-timeout 1 "$URL" 2>/dev/null; then
            break
        fi
        sleep 0.5
        ATTEMPTS=$((ATTEMPTS + 1))
    done

    if [ $ATTEMPTS -ge 60 ]; then
        kill "$IBSRV_PID" 2>/dev/null || true
        echo '{"ok":false,"error":"ibsrv timeout after 30s"}' >&2
        return 1
    fi

    # Save session
    cat > "$IBSRV_SESSION_FILE" <<SESS
{"port":$PORT,"pid":$IBSRV_PID,"db":"$DB_PATH","data":"$DATA_DIR","startedAt":"$(date -Iseconds)"}
SESS

    echo "$URL"
}

# stop_ibsrv — kill ibsrv (from session or by process name)
stop_ibsrv() {
    local KILLED=false
    if [ -f "$IBSRV_SESSION_FILE" ]; then
        local PID
        PID=$(python -c "import json; d=json.load(open('$IBSRV_SESSION_FILE')); print(d['pid'])" 2>/dev/null || echo "")
        if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
            kill "$PID" 2>/dev/null || true
            KILLED=true
        fi
        rm -f "$IBSRV_SESSION_FILE"
    fi
    # Fallback: kill any ibsrv.exe we might have orphaned
    if [ "$KILLED" = false ]; then
        taskkill //IM ibsrv.exe //F > /dev/null 2>&1 || true
    fi
}

# stop_browser — kill orphan Playwright chrome processes
stop_browser() {
    # web-test stores session in .browser-session.json
    local BROWSER_SESSION="$WEBTEST_DIR/../.browser-session.json"
    if [ -f "$BROWSER_SESSION" ]; then
        local PORT
        PORT=$(python -c "import json; d=json.load(open('$BROWSER_SESSION')); print(d['port'])" 2>/dev/null || echo "")
        if [ -n "$PORT" ]; then
            # Try graceful stop via HTTP
            curl -s -X POST "http://127.0.0.1:${PORT}/stop" > /dev/null 2>&1 || true
            sleep 1
        fi
        rm -f "$BROWSER_SESSION"
    fi
    # Fallback: kill Playwright-managed chrome by user data dir marker
    # Playwright chromium has --user-data-dir with "playwright" in path
    local CHROME_PIDS
    CHROME_PIDS=$(wmic process where "name='chrome.exe' and commandline like '%playwright%'" get processid 2>/dev/null | grep -o '[0-9]*' || true)
    for PID in $CHROME_PIDS; do
        kill "$PID" 2>/dev/null || taskkill //PID "$PID" //F > /dev/null 2>&1 || true
    done
}

# resolve_target <arg> — if URL, return as-is; if path, ensure ibsrv and return URL
resolve_target() {
    local TARGET="$1"
    if is_url "$TARGET"; then
        echo "$TARGET"
    else
        ensure_ibsrv "$TARGET"
    fi
}

# ── Command routing ────────────────────────────────────────────
CMD="${1:-help}"
shift || true

case "$CMD" in
    start)
        # start <url-or-db-path> — launch ibsrv if needed, then browser + connect
        TARGET="${1:?Usage: call.sh start <url-or-db-path>}"
        URL="$(resolve_target "$TARGET")"
        node "$RUN_MJS" start "$URL"
        ;;

    exec)
        # exec '<script>' — run JS against active session
        # exec - — read script from stdin
        SCRIPT="${1:?Usage: call.sh exec '<script>' or echo '...' | call.sh exec -}"
        if [ "$SCRIPT" = "-" ]; then
            node "$RUN_MJS" exec -
        else
            echo "$SCRIPT" | node "$RUN_MJS" exec -
        fi
        ;;

    run)
        # run <url-or-db-path> '<script>' — one-shot: start ibsrv + connect, execute, disconnect + stop ibsrv
        TARGET="${1:?Usage: call.sh run <url-or-db-path> '<script>'}"
        SCRIPT="${2:?Usage: call.sh run <url-or-db-path> '<script>'}"
        URL="$(resolve_target "$TARGET")"

        cleanup_run() { stop_ibsrv; }
        # Only cleanup ibsrv for non-URL targets
        if ! is_url "$TARGET"; then
            trap cleanup_run EXIT
        fi

        if [ "$SCRIPT" = "-" ]; then
            node "$RUN_MJS" run "$URL" -
        else
            echo "$SCRIPT" | node "$RUN_MJS" run "$URL" -
        fi
        ;;

    shot)
        # shot [file.png] — screenshot
        node "$RUN_MJS" shot "${1:-shot.png}"
        ;;

    status)
        # status — check browser session + ibsrv session
        node "$RUN_MJS" status 2>/dev/null || true
        if [ -f "$IBSRV_SESSION_FILE" ]; then
            echo "--- ibsrv ---"
            cat "$IBSRV_SESSION_FILE"
        fi
        ;;

    stop)
        # stop — logout browser + stop ibsrv + cleanup orphans
        node "$RUN_MJS" stop 2>/dev/null || true
        stop_browser
        stop_ibsrv
        echo '{"ok":true,"message":"Stopped browser and ibsrv"}'
        ;;

    serve)
        # serve <db-path> [port] — start ibsrv in foreground (blocks)
        DB_PATH="${1:?Usage: call.sh serve <db-path> [port]}"
        PORT="${2:-8314}"
        IBSRV="$(find_ibsrv)"
        if [ -z "$IBSRV" ]; then
            echo '{"ok":false,"error":"ibsrv.exe not found in C:\\Program Files\\1cv8\\"}' >&2
            exit 1
        fi
        DATA_DIR="$(mktemp -d)/ibsrv-data"
        mkdir -p "$DATA_DIR"
        echo "{\"ok\":true,\"message\":\"Starting ibsrv\",\"port\":$PORT,\"db\":\"$DB_PATH\"}"
        "$IBSRV" \
            --database-path="$DB_PATH" \
            --http-port="$PORT" \
            --http-address=localhost \
            --enable-http-gate \
            --disable-direct-gate \
            --disable-ssh-gate \
            --data="$DATA_DIR" \
            2>&1
        ;;

    help|*)
        cat <<'EOF'
Usage: call.sh <command> [args...]

Lifecycle (auto-starts ibsrv when given a DB path instead of URL):
  start <url-or-db-path>   Launch browser, connect to 1C web client
  stop                     Logout browser + stop ibsrv
  status                   Check browser + ibsrv session

Execution:
  exec '<script>'          Run JS script in active session
  exec -                   Read script from stdin
  run <url-or-db-path> '<script>'   One-shot: connect, execute, disconnect
  run <url-or-db-path> -            One-shot from stdin

Utility:
  shot [file.png]          Take screenshot (default: shot.png)
  serve <db-path> [port]   Start ibsrv in foreground (blocks, Ctrl+C to stop)

Target resolution:
  http://...               Use URL as-is (ibsrv or Apache already running)
  C:/path/to/infobase      Auto-start ibsrv on free port, connect Playwright

Environment:
  WEBTEST_SCRIPTS          Path to web-test/scripts dir (default: /c/reps/cc-1c-skills/.claude/skills/web-test/scripts)
EOF
        ;;
esac
