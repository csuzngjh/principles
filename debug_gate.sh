#!/usr/bin/env bash
PROJECT_DIR=$(pwd)
FILE_PATH="$PROJECT_DIR/src/server/test.ts"
INPUT='{"tool_name":"Write","tool_input":{"file_path":"'"$FILE_PATH"'"}}'
echo "Input JSON: $INPUT"
echo "$INPUT" | bash .claude/hooks/pre_write_gate.sh
echo "Exit code: $?"
