#!/usr/bin/env bash
# Runs the WebdriverIO spec. When the session could not be created at all (no
# results.json was written), tries once more: the first Safari web inspector
# attach on a cold simulator is known to fail now and then.
set -uo pipefail

cd "$(dirname "$0")/.."
status=1
for attempt in 1 2; do
  echo "wdio attempt $attempt"
  if [ "$attempt" -gt 1 ]; then
    export WDA_PREBUILT=false
  fi
  npx wdio run wdio.conf.js
  status=$?
  if [ -f "$OUT_DIR/results.json" ] && grep -q "\"id\": \"S0\"" "$OUT_DIR/results.json"; then
    break
  fi
  echo "no results.json after attempt $attempt, session start probably failed"
  sleep 15
done
exit "$status"
