#!/usr/bin/env bash
set -euo pipefail

WORKSPACE_ROOT="${1:-$(pwd)}"
OUTPUT_ROOT="${2:-}"
SESSION_LIMIT="${3:-10}"

if [[ -z "$OUTPUT_ROOT" ]]; then
  OUTPUT_ROOT="$WORKSPACE_ROOT/.state/control-plane-observation"
fi

STATE_DIR="$WORKSPACE_ROOT/.state"
MEMORY_LOG_DIR="$WORKSPACE_ROOT/memory/logs"
TIMESTAMP="$(date +"%Y-%m-%d_%H-%M-%S")"
SNAPSHOT_DIR="$OUTPUT_ROOT/snapshots/$TIMESTAMP"
MANIFEST_PATH="$SNAPSHOT_DIR/manifest.json"

mkdir -p "$SNAPSHOT_DIR"

MANIFEST_ENTRIES=()

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "collect-control-plane-snapshot.sh requires python3 or python for JSON escaping" >&2
  exit 1
fi

json_escape() {
  "$PYTHON_BIN" - <<'PY' "$1"
import json, sys
print(json.dumps(sys.argv[1]))
PY
}

append_manifest_entry() {
  local source_path="$1"
  local relative_target="$2"

  if [[ -e "$source_path" ]]; then
    local size
    local mtime
    size="$(stat -c %s "$source_path")"
    mtime="$(date -u -d "@$(stat -c %Y "$source_path")" +"%Y-%m-%dT%H:%M:%SZ")"
    MANIFEST_ENTRIES+=("{\"relativePath\":$(json_escape "$relative_target"),\"sourcePath\":$(json_escape "$source_path"),\"exists\":true,\"length\":$size,\"lastWriteTime\":$(json_escape "$mtime")}")
  else
    MANIFEST_ENTRIES+=("{\"relativePath\":$(json_escape "$relative_target"),\"sourcePath\":$(json_escape "$source_path"),\"exists\":false,\"length\":null,\"lastWriteTime\":null}")
  fi
}

copy_if_exists() {
  local source_path="$1"
  local relative_target="$2"
  local target_path="$SNAPSHOT_DIR/$relative_target"

  mkdir -p "$(dirname "$target_path")"
  if [[ -e "$source_path" ]]; then
    cp "$source_path" "$target_path"
  fi
  append_manifest_entry "$source_path" "$relative_target"
}

copy_if_exists "$STATE_DIR/AGENT_SCORECARD.json" ".state/AGENT_SCORECARD.json"
copy_if_exists "$STATE_DIR/evolution_queue.json" ".state/evolution_queue.json"
copy_if_exists "$STATE_DIR/evolution_directive.json" ".state/evolution_directive.json"
copy_if_exists "$STATE_DIR/pain_candidates.json" ".state/pain_candidates.json"
copy_if_exists "$STATE_DIR/.pain_flag" ".state/.pain_flag"
copy_if_exists "$STATE_DIR/logs/events.jsonl" ".state/logs/events.jsonl"
copy_if_exists "$STATE_DIR/logs/daily-stats.json" ".state/logs/daily-stats.json"
copy_if_exists "$MEMORY_LOG_DIR/SYSTEM.log" "memory/logs/SYSTEM.log"

SESSIONS_DIR="$STATE_DIR/sessions"
if [[ -d "$SESSIONS_DIR" ]]; then
  while IFS= read -r session_file; do
    copy_if_exists "$session_file" ".state/sessions/$(basename "$session_file")"
  done < <(find "$SESSIONS_DIR" -maxdepth 1 -type f -name '*.json' -printf '%T@ %p\n' | sort -nr | head -n "$SESSION_LIMIT" | awk '{ $1=""; sub(/^ /, ""); print }')
fi

cat > "$SNAPSHOT_DIR/review-template.md" <<EOF
# Control Plane Snapshot Review

- generatedAt: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
- workspaceRoot: $WORKSPACE_ROOT
- snapshotDir: $SNAPSHOT_DIR

## Daily Checks

1. Trust did not inflate unexpectedly.
2. \`user_empathy\` and \`system_infer\` both appear in \`.state/logs/events.jsonl\` when relevant.
3. Empathy rollback reduced only the empathy slice and did not wipe unrelated GFI.
4. \`evolution_queue.json\`, \`evolution_directive.json\`, and status output tell the same story.
5. \`daily-stats.json\` does not contradict active session snapshots in a way that would mislead operators.

## Files To Review First

- \`.state/AGENT_SCORECARD.json\`
- \`.state/logs/events.jsonl\`
- \`.state/logs/daily-stats.json\`
- \`.state/evolution_queue.json\`
- \`.state/evolution_directive.json\`
- \`.state/sessions/*.json\`

## Decision

- continue_observation:
- patch_needed:
- ready_for_phase_3_shadow:
EOF

{
  printf '{'
  printf '"generatedAt":%s,' "$(json_escape "$(date -u +"%Y-%m-%dT%H:%M:%SZ")")"
  printf '"workspaceRoot":%s,' "$(json_escape "$WORKSPACE_ROOT")"
  printf '"snapshotDir":%s,' "$(json_escape "$SNAPSHOT_DIR")"
  printf '"sessionLimit":%s,' "$(json_escape "$SESSION_LIMIT")"
  printf '"copiedFiles":['
  local_first=1
  for entry in "${MANIFEST_ENTRIES[@]}"; do
    if [[ $local_first -eq 0 ]]; then
      printf ','
    fi
    printf '%s' "$entry"
    local_first=0
  done
  printf ']}'
} > "$MANIFEST_PATH"

printf '%s\n' "$SNAPSHOT_DIR" > "$OUTPUT_ROOT/latest_snapshot.txt"

echo "Snapshot created: $SNAPSHOT_DIR"
echo "Manifest: $MANIFEST_PATH"
