---
name: pr-description
description: Draft or update a PR description from the actual diff and context; output a ready-to-paste Markdown body.
metadata:
  short-description: Generate/update PR body (Markdown)
---

# PR Description Writer

Goal: generate a ready-to-paste PR description based on the *actual diff* and relevant context; optionally update an existing PR body.

## 0) Confirm inputs (ask if missing)

- Intent/background: why this change exists (1–3 sentences)
- Audience focus: what reviewers care about (risk, performance, migration, compatibility, etc.)
- Base branch (default assumption: `main` if unknown)

## 1) Extract facts from the repo (suggested commands)

- `git diff --stat`
- `git diff <base>...HEAD`
- `git log --oneline --decorate -n 20`
- If a PR already exists and GitHub is available: `gh pr view --json title,body,files,commits`

## 2) Produce Markdown (default template)

Output a Markdown body with a stable, scannable structure:

### Context
- Background/motivation (why)

### What changed
- Key changes (what), grouped by module/logic

### How to test
- Local verification steps (commands + expected results)

### Risks / Rollout
- Risks, blast radius, rollback plan, rollout/release notes (if applicable)

### Notes
- Compatibility / migration / known limitations / follow-ups (if applicable)

## 3) Update the PR (optional; confirm before doing)

Only if the user explicitly asks to update the remote PR:

- Generate `pr-description.md` (repo root or a temp location)
- `gh pr edit --body-file pr-description.md`

By default, only output the draft content; do not modify the remote PR automatically.
