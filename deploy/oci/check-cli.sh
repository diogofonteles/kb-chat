#!/usr/bin/env bash
# Checks that every OCI CLI command path provision.sh calls exists in the installed CLI.
# provision.sh is only exercised for real against a tenancy, so a renamed or wrong command
# group would otherwise surface halfway through an --apply (KBC-019).
#   deploy/oci/check-cli.sh
set -euo pipefail
cd "$(dirname "$0")"
command -v oci >/dev/null || { echo "check-cli: oci CLI not found" >&2; exit 2; }

# Continued lines are joined first, so a command split across lines is read whole.
joined="$(sed -e ':a' -e '/\\$/N; s/ *\\\n */ /; ta' provision.sh)"
calls="$(grep -cE 'find_id [a-z]|create "[^"]*"|"\$\{OCI\[@\]\}" [a-z]' <<<"$joined")"

# The words after `find_id`, `create "<label>"` or `"${OCI[@]}"` up to the first flag.
paths="$(sed -nE \
  -e 's/.*find_id ([a-z][a-z-]*( [a-z][a-z-]*)*) --.*/\1/p' \
  -e 's/.*create "[^"]*" ([a-z][a-z-]*( [a-z][a-z-]*)*) --.*/\1/p' \
  -e 's/.*"\$\{OCI\[@\]\}" ([a-z][a-z-]*( [a-z][a-z-]*)*) --.*/\1/p' \
  <<<"$joined")"
# Every call site must yield a path; a call the patterns miss would go unchecked.
found="$(grep -c . <<<"$paths" || true)"
[ "$found" -eq "$calls" ] || { echo "check-cli: $calls OCI calls but $found command paths read" >&2; exit 1; }
paths="$(sort -u <<<"$paths")"

failed=0
while IFS= read -r path; do
  # shellcheck disable=SC2086 # the path is meant to split into words
  if oci $path --help >/dev/null 2>&1; then echo "ok    oci $path"
  else echo "MISSING oci $path" >&2; failed=1; fi
done <<<"$paths"
exit "$failed"
