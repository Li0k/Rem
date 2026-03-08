#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  review-check-doc-drift.sh <identifier>...

Example:
  review-check-doc-drift.sh OldFlagName old_config_key old-cli-command
EOF
}

if [ "$#" -eq 0 ]; then
  usage
  exit 1
fi

targets=(
  docs
  doc
  tests
  test
  spec
  examples
  README.md
  README
  CHANGELOG.md
  CHANGELOG
)

existing_targets=()
for target in "${targets[@]}"; do
  if [ -e "$target" ]; then
    existing_targets+=("$target")
  fi
done

if [ "${#existing_targets[@]}" -eq 0 ]; then
  echo "No docs/tests/example paths found in the current workspace."
  exit 0
fi

for pattern in "$@"; do
  echo "== searching for: $pattern =="
  rg -n -S -- "$pattern" "${existing_targets[@]}" || echo "(no matches)"
  echo
done
