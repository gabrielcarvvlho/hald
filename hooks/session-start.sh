#!/bin/sh
# Git Oracle — Cross-platform session bootstrap
# Detects the hosting platform and injects skills into the agent's context.

# Detect platform
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

# Read the query skill content
SKILL_FILE="$PLUGIN_ROOT/skills/git-oracle-query/SKILL.md"
if [ ! -f "$SKILL_FILE" ]; then
  exit 0
fi

SKILL_CONTENT=$(cat "$SKILL_FILE")

# Emit platform-appropriate JSON
if [ "$PLATFORM" = "claude-code" ]; then
  printf '{"hookSpecificOutput": "%s"}' "$(echo "$SKILL_CONTENT" | sed 's/"/\\"/g' | tr '\n' ' ')"
elif [ "$PLATFORM" = "cursor" ]; then
  printf '{"additional_context": "%s"}' "$(echo "$SKILL_CONTENT" | sed 's/"/\\"/g' | tr '\n' ' ')"
fi
