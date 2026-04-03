#!/bin/sh
# Git Oracle MCP Server — startup wrapper
# Validates prerequisites before launching the Node.js MCP server.
# Used by .mcp.json so that host agents get clear error messages on failure.

set -e

# ---------- Resolve plugin root ----------
# Works whether invoked from .mcp.json (CLAUDE_PLUGIN_ROOT / CURSOR_PLUGIN_ROOT)
# or directly (uses script location).

if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
  PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"
elif [ -n "$CURSOR_PLUGIN_ROOT" ]; then
  PLUGIN_ROOT="$CURSOR_PLUGIN_ROOT"
else
  PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi

ENTRY="$PLUGIN_ROOT/dist/index.js"

# ---------- Check Node.js ----------

if ! command -v node >/dev/null 2>&1; then
  cat >&2 <<'EOF'
[git-oracle] ERROR: Node.js not found in PATH.

The Git Oracle MCP server requires Node.js >= 20.
Install it from https://nodejs.org or via a version manager (nvm, fnm, mise).

If Node.js is installed via a version manager, ensure it is activated in your
shell profile (~/.zshrc, ~/.bashrc) so that IDE-spawned processes can find it.
EOF
  exit 1
fi

# ---------- Check Node.js version ----------

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
  cat >&2 <<EOF
[git-oracle] ERROR: Node.js v${NODE_MAJOR} is too old (requires >= 20).

Current: $(node --version)
Please upgrade Node.js: https://nodejs.org
EOF
  exit 1
fi

# ---------- Check dist/ exists ----------

if [ ! -f "$ENTRY" ]; then
  cat >&2 <<EOF
[git-oracle] ERROR: Built files not found at:
  $ENTRY

Run the following to build:
  cd "$PLUGIN_ROOT" && npm install && npm run build

If you installed git-oracle as a plugin, this step may have been skipped.
EOF
  exit 1
fi

# ---------- Check native dependencies ----------
# better-sqlite3 requires a native binary that must match the Node.js version.
# A quick require() check catches mismatches early with a clear message.

node -e "try { require('$PLUGIN_ROOT/node_modules/better-sqlite3') } catch(e) { process.stderr.write('[git-oracle] ERROR: Native module issue: ' + e.message + '\\nTry: cd \"$PLUGIN_ROOT\" && npm rebuild better-sqlite3\\n'); process.exit(1) }" 2>/dev/null || {
  cat >&2 <<EOF
[git-oracle] WARNING: Could not verify native modules. The server may still work.
EOF
}

# ---------- Launch server ----------

exec node "$ENTRY" "$@"
