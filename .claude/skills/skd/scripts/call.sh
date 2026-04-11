#!/usr/bin/env bash
# call.sh — wrapper for cc-1c-skills SKD tools (compile, info, edit, validate)
set -euo pipefail

SKD_BASE="${SKD_SCRIPTS:-/c/reps/cc-1c-skills/.claude/skills}"

CMD="${1:-help}"
shift || true

case "$CMD" in
    compile)
        SCRIPT="$SKD_BASE/skd-compile/scripts/skd-compile.ps1"
        [ -f "$SCRIPT" ] || { echo '{"ok":false,"error":"skd-compile not found at '"$SCRIPT"'"}' >&2; exit 1; }
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT" "$@"
        ;;

    info)
        SCRIPT="$SKD_BASE/skd-info/scripts/skd-info.ps1"
        [ -f "$SCRIPT" ] || { echo '{"ok":false,"error":"skd-info not found at '"$SCRIPT"'"}' >&2; exit 1; }
        TEMPLATE="${1:?Usage: call.sh info <Template.xml> [options]}"
        shift
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT" -TemplatePath "$TEMPLATE" "$@"
        ;;

    edit)
        SCRIPT="$SKD_BASE/skd-edit/scripts/skd-edit.ps1"
        [ -f "$SCRIPT" ] || { echo '{"ok":false,"error":"skd-edit not found at '"$SCRIPT"'"}' >&2; exit 1; }
        TEMPLATE="${1:?Usage: call.sh edit <Template.xml> -Op <operation> [options]}"
        shift
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT" -TemplatePath "$TEMPLATE" "$@"
        ;;

    validate)
        SCRIPT="$SKD_BASE/skd-validate/scripts/skd-validate.ps1"
        [ -f "$SCRIPT" ] || { echo '{"ok":false,"error":"skd-validate not found at '"$SCRIPT"'"}' >&2; exit 1; }
        TEMPLATE="${1:?Usage: call.sh validate <Template.xml>}"
        shift
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT" -TemplatePath "$TEMPLATE" "$@"
        ;;

    help|*)
        cat <<'EOF'
Usage: call.sh <command> [args...]

Commands:
  compile [options]              Create DCS from JSON DSL → Template.xml
  info <Template.xml> [options]  Analyze DCS structure
  edit <Template.xml> [options]  Atomic edit operations on DCS
  validate <Template.xml>        Validate DCS XML (~30 checks)

Compile options:
  -DefinitionFile <json>         JSON definition file
  -Value '<json-string>'         Inline JSON definition
  -OutputPath <Template.xml>     Output path

Info options:
  -Mode overview|query|fields|links|calculated|resources|params|variant|templates|trace|full
  -Name <dataset|variant|field>

Edit options:
  -Op add-field|add-param|add-resource|set-query|...
  See /skd-edit SKILL.md for full list of 25 operations

Environment:
  SKD_SCRIPTS    Path to cc-1c-skills/skills dir (default: /c/reps/cc-1c-skills/.claude/skills)
EOF
        ;;
esac
