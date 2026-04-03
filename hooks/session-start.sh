#!/bin/sh
# Git Oracle — Cross-platform session bootstrap
# Detects the hosting platform and injects skills into the agent's context.
#
# Outputs a JSON object with the skill content, using jq for robust escaping
# with a Node.js fallback if jq is not installed.

set -e

# ---------- Platform detection ----------

if [ -n "$CLAUDE_PLUGIN_ROOT" ] && [ -z "$CURSOR_PLUGIN_ROOT" ]; then
  PLATFORM="claude-code"
  PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"
elif [ -n "$CURSOR_PLUGIN_ROOT" ]; then
  PLATFORM="cursor"
  PLUGIN_ROOT="$CURSOR_PLUGIN_ROOT"
else
  PLATFORM="generic"
  PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi

# ---------- Read skill content ----------

SKILL_FILE="$PLUGIN_ROOT/skills/git-oracle-query/SKILL.md"
if [ ! -f "$SKILL_FILE" ]; then
  exit 0
fi

# ---------- JSON-escape the file content ----------
# We need to embed arbitrary file content (markdown with backticks, quotes,
# backslashes, unicode, newlines) inside a JSON string value. Hand-rolled
# sed cannot do this correctly. Use jq if available; otherwise fall back to
# a Node.js one-liner (Node is guaranteed to be present since the MCP server
# requires it).

json_escape_file() {
  _file="$1"

  # Attempt 1: jq (handles all edge cases — unicode, control chars, etc.)
  if command -v jq >/dev/null 2>&1; then
    jq -Rs '.' < "$_file"
    return
  fi

  # Attempt 2: Node.js (always available — we need it for the MCP server)
  if command -v node >/dev/null 2>&1; then
    node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync(process.argv[1],'utf-8')))" "$_file"
    return
  fi

  # Attempt 3: Python (common on macOS/Linux)
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys; print(json.dumps(open(sys.argv[1]).read()),end='')" "$_file"
    return
  fi

  # No suitable tool found — skip injection silently
  echo '""'
}

ESCAPED=$(json_escape_file "$SKILL_FILE")

# ---------- Emit platform-appropriate JSON ----------

case "$PLATFORM" in
  claude-code)
    printf '{"hookSpecificOutput": %s}\n' "$ESCAPED"
    ;;
  cursor)
    printf '{"additional_context": %s}\n' "$ESCAPED"
    ;;
  *)
    # Generic: print to stdout for other integrations to consume
    printf '%s\n' "$ESCAPED"
    ;;
esac
