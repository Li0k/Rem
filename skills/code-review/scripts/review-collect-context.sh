#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  review-collect-context.sh --base <branch>
  review-collect-context.sh --commit <sha>
  review-collect-context.sh --uncommitted
EOF
}

require_git_repo() {
  git rev-parse --show-toplevel >/dev/null 2>&1 || {
    echo "error: not inside a git repository" >&2
    exit 1
  }
}

print_common_context() {
  echo "== git status =="
  git status --short
  echo

  echo "== recent commits =="
  git log --oneline --decorate -n 20
  echo
}

print_path_summary() {
  local paths=("$@")

  if [ "${#paths[@]}" -eq 0 ]; then
    echo "No changed files."
    return
  fi

  echo "== changed files =="
  printf '%s\n' "${paths[@]}"
  echo

  echo "== touched docs/tests/examples =="
  printf '%s\n' "${paths[@]}" | rg '(^|/)(docs|doc|tests|test|spec|examples?)/|(^|/)(README|CHANGELOG)' || true
  echo
}

run_base_review() {
  local base_branch="$1"
  local merge_base

  merge_base="$(git merge-base HEAD "$base_branch" 2>/dev/null || true)"
  if [ -z "$merge_base" ]; then
    merge_base="$(git merge-base HEAD "${base_branch}@{upstream}" 2>/dev/null || true)"
  fi
  if [ -z "$merge_base" ]; then
    echo "error: could not determine merge-base for $base_branch" >&2
    exit 1
  fi

  echo "== review target =="
  echo "base branch: $base_branch"
  echo "merge-base: $merge_base"
  echo

  echo "== diff stat =="
  git diff --stat "$merge_base..HEAD"
  echo

  mapfile -t changed_files < <(git diff --name-only "$merge_base..HEAD")
  print_path_summary "${changed_files[@]}"
}

run_commit_review() {
  local commit_sha="$1"

  echo "== review target =="
  echo "commit: $commit_sha"
  echo

  echo "== diff stat =="
  git show --stat --format=medium "$commit_sha"
  echo

  mapfile -t changed_files < <(git show --name-only --format='' "$commit_sha")
  print_path_summary "${changed_files[@]}"
}

run_uncommitted_review() {
  echo "== review target =="
  echo "working tree"
  echo

  echo "== staged diff stat =="
  git diff --staged --stat || true
  echo

  echo "== unstaged diff stat =="
  git diff --stat || true
  echo

  mapfile -t changed_files < <(
    {
      git diff --staged --name-only
      git diff --name-only
      git ls-files --others --exclude-standard
    } | awk 'NF' | sort -u
  )
  print_path_summary "${changed_files[@]}"
}

main() {
  require_git_repo

  if [ "$#" -eq 0 ]; then
    usage
    exit 1
  fi

  print_common_context

  case "$1" in
    --base)
      [ "$#" -eq 2 ] || {
        usage
        exit 1
      }
      run_base_review "$2"
      ;;
    --commit)
      [ "$#" -eq 2 ] || {
        usage
        exit 1
      }
      run_commit_review "$2"
      ;;
    --uncommitted)
      [ "$#" -eq 1 ] || {
        usage
        exit 1
      }
      run_uncommitted_review
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
