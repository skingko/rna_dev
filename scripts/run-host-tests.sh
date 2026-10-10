#!/bin/sh
# Host tests in parallel, one file per process; a file that fails is run once more alone, because a few timing tests
# fail on a loaded shared runner and pass on a quiet one. A file that fails twice fails the run.
# Usage: scripts/run-host-tests.sh [parallelism]   (from the repository root)
set -u
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT/prototypes/control-center" || exit 2
JOBS=${1:-3}
LOGS=$(mktemp -d)
ls test/*.test.mjs test/harness/*.test.mjs test/scenarios/*.test.mjs 2>/dev/null > "$LOGS/files"
echo "host tests: $(wc -l < "$LOGS/files" | tr -d ' ') files, $JOBS at a time"
xargs -P "$JOBS" -I{} sh -c 'log="$1/$(echo "$2" | tr / _).log"; node --test "$2" > "$log" 2>&1 || echo "$2" >> "$1/failed"' _ "$LOGS" {} < "$LOGS/files"
[ -f "$LOGS/failed" ] || { echo "host tests: all files passed"; exit 0; }
echo "host tests: $(wc -l < "$LOGS/failed" | tr -d ' ') file(s) failed; running them again, one at a time"
status=0
while read -r file; do
  if node --test "$file" > "$LOGS/retry.log" 2>&1; then echo "  passed on retry: $file"
  else echo "  FAILED: $file"; grep -E "^\s*not ok|error:|^# (fail|pass)" "$LOGS/retry.log" | head -20; status=1; fi
done < "$LOGS/failed"
exit $status
