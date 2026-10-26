#!/usr/bin/env bash
# Checks that every OCI CLI command path provision.sh calls exists in the installed CLI.
# provision.sh is only exercised for real against a tenancy, so a renamed or wrong command
# group would otherwise surface halfway through an --apply (KBC-019).
#   deploy/oci/check-cli.sh
set -euo pipefail
cd "$(dirname "$0")"
command -v oci >/dev/null || { echo "check-cli: oci CLI not found" >&2; exit 2; }

# The words after `find_id`, `create "<label>"` or `"${OCI[@]}"` up to the first flag.
paths="$(sed -nE \
  -e 's/.*find_id ([a-z][a-z-]*( [a-z][a-z-]*)*) --.*/\1/p' \
  -e 's/.*create "[^"]*" ([a-z][a-z-]*( [a-z][a-z-]*)*)( \\| --).*/\1/p' \
  -e 's/.*"\$\{OCI\[@\]\}" ([a-z][a-z-]*( [a-z][a-z-]*)*) --.*/\1/p' \
  provision.sh | sort -u)"
[ -n "$paths" ] || { echo "check-cli: no OCI commands found in provision.sh" >&2; exit 1; }

failed=0
while IFS= read -r path; do
  # shellcheck disable=SC2086 # the path is meant to split into words
  if oci $path --help >/dev/null 2>&1; then echo "ok    oci $path"
  else echo "MISSING oci $path" >&2; failed=1; fi
done <<<"$paths"
exit "$failed"
