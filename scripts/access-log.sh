#!/usr/bin/env bash
# Show OpsCoach access activity from CloudWatch: the per-request lines emitted by
# web/middleware.ts -> {"evt":"access","at":...,"ip":...,"user":...,"method":...,"path":...}.
# Read-only. Forward-only: only shows requests since the middleware was deployed.
#
# Usage:
#   AWS_PROFILE=<your-profile> scripts/access-log.sh          # last 24h
#   AWS_PROFILE=<your-profile> scripts/access-log.sh 72        # last 72h
#
# Env:
#   AWS_PROFILE             AWS profile / SSO session (set to whatever fronts the deploy).
#   AWS_REGION              defaults to us-east-1.
#   OPSCOACH_WEB_LOG_GROUP  skip auto-discovery and use this exact log group.
set -euo pipefail
export AWS_REGION="${AWS_REGION:-us-east-1}"
HOURS="${1:-24}"

if [ -n "${OPSCOACH_WEB_LOG_GROUP:-}" ]; then
  groups="$OPSCOACH_WEB_LOG_GROUP"
else
  # The CDK names the web task's log group "...opscoachweb...".
  groups=$(aws logs describe-log-groups --query 'logGroups[].logGroupName' --output text 2>/dev/null \
           | tr '\t' '\n' | grep -i 'opscoachweb' || true)
fi
[ -n "$groups" ] || { echo "No OpsCoach web log group found. Set OPSCOACH_WEB_LOG_GROUP, or check AWS_PROFILE/AWS_REGION." >&2; exit 1; }

start_ms=$(( ($(date +%s) - HOURS * 3600) * 1000 ))

PARSER=$(mktemp)
trap 'rm -f "$PARSER"' EXIT
cat > "$PARSER" <<'PY'
import sys, json
from collections import defaultdict
hours = sys.argv[1] if len(sys.argv) > 1 else "?"
rows = []
for line in sys.stdin:
    for chunk in line.strip().split('\t'):
        c = chunk.strip()
        if not c.startswith('{'):
            continue
        try:
            j = json.loads(c)
        except Exception:
            continue
        if j.get('evt') == 'access':
            rows.append(j)
rows.sort(key=lambda r: r.get('at', ''))
print("\nOpsCoach access - last %sh - %d page request(s)\n" % (hours, len(rows)))
if not rows:
    print("  No access lines yet. The middleware logs forward-only (after its deploy)")
    print("  and only on real page visits. Visit the app, then re-run.")
    sys.exit(0)
print("  %-19s  %-30s  %-16s  %s" % ("time (UTC)", "user", "ip", "path"))
print("  " + "-" * 80)
for r in rows[-40:]:
    print("  %-19s  %-30s  %-16s  %s %s" % (
        r.get('at', '')[:19], (r.get('user') or '-')[:30],
        (r.get('ip') or '-')[:16], r.get('method', ''), r.get('path', '')))
by_user = defaultdict(lambda: [0, set()])
for r in rows:
    u = r.get('user') or '(none)'
    by_user[u][0] += 1
    by_user[u][1].add(r.get('ip') or '?')
print("\n  by user:")
print("  %-30s  %9s  %12s" % ("user", "requests", "distinct IPs"))
for u, (n, ips) in sorted(by_user.items(), key=lambda kv: -kv[1][0]):
    print("  %-30s  %9d  %12d" % (u[:30], n, len(ips)))
print()
PY

# shellcheck disable=SC2086
for g in $groups; do
  aws logs filter-log-events --log-group-name "$g" --start-time "$start_ms" \
    --filter-pattern '{ $.evt = "access" }' --query 'events[].message' --output text 2>/dev/null || true
done | python3 "$PARSER" "$HOURS"
