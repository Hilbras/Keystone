#!/usr/bin/env bash
# Kill stale Keystone backend and frontend processes.
# Useful when ./start.sh leaves old tsx watch or vite processes behind.

set -euo pipefail

pids=$(ps -eo pid,args |
  grep -E '(tsx watch src/(index|setup-server)\.ts|node dist/(index|setup-server)\.js|frontend/node_modules/.bin/vite)' |
  grep -v grep |
  awk '{print $1}' || true)

if [ -z "$pids" ]; then
  echo "No stale Keystone processes found."
  exit 0
fi

# shellcheck disable=SC2086
echo "Killing processes: $pids"
kill $pids 2>/dev/null || true
sleep 1
# shellcheck disable=SC2086
kill -9 $pids 2>/dev/null || true

echo "Done."
