---
name: code-review
description: Review code changes with evidence-based, prioritized findings; focus on correctness, risk, tests, and maintainability.
metadata:
  short-description: High-signal code review (verifiable)
---

# Code Review

Review a single code change like a strict reviewer. Use `AGENTS.md` and the repo for project context; do not restate project background in the review.

This skill is intentionally close to Codex's built-in review prompt. Keep it narrow: identify actionable issues introduced by the change, cite exact evidence, and avoid bloated report structure.

## 0) Scope

Choose exactly one review target:

1. **PR-style diff**: review `merge-base..HEAD` against `<baseBranch>`; default `<baseBranch>=main`
2. **Working tree**: review staged + unstaged + untracked changes
3. **Single commit**: review commit `<sha>`
4. **Custom scope**: follow user-provided instructions exactly

If the target is materially ambiguous, ask one short question. Otherwise proceed.

## 1) Gather facts first

Always start with:

- `git status`
- `git diff --stat`
- `git log --oneline --decorate -n 20`

Then inspect the actual change under review:

- PR-style diff:
  - `MB=$(git merge-base HEAD <baseBranch>)`
  - `git diff $MB..HEAD`
  - If needed: `git fetch -p` then retry with `<baseBranch>@{upstream}`
- Working tree:
  - `git diff --staged`
  - `git diff`
  - `git ls-files --others --exclude-standard`
- Single commit:
  - `git show <sha>`

Optional when available:

- `gh pr view --json title,body,files,commits`
- `gh pr diff`

## 2) What counts as a finding

Only flag issues the original author would likely fix if they knew about them.

A finding should satisfy all of the following:

1. It meaningfully impacts correctness, performance, security, compatibility, or maintainability.
2. It is discrete and actionable.
3. It was introduced by the reviewed change, not pre-existing.
4. It does not rely on unstated assumptions about intent or hidden behavior.
5. If it affects another part of the codebase, you identify the specific caller, interface, or path that is provably affected.
6. It is not better explained as an intentional behavior change.

If no issue clearly meets this bar, prefer outputting no findings.

## 3) How to write a finding

Each finding should:

- Explain why the issue matters
- State the scenario or trigger when it is relevant
- Cite exact file and line evidence
- Keep the cited line range as tight as possible
- Use one finding per distinct issue
- Stay brief and matter-of-fact

Do not report speculative issues. Do not invent problems to fill space.

## 4) What to prioritize

Prioritize:

- Bugs and behavioral regressions
- Compatibility and upgrade/downgrade risk
- Concrete security and performance issues
- Missing regression coverage for changed behavior
- Stale tests, docs, examples, comments, or user-facing instructions that would mislead users or maintainers

Style, naming, and language-idiom findings are valid only when they:

- Obscure behavior
- Conflict with documented repo conventions or established language idioms
- Leave stale or misleading tests/docs/examples/comments
- Make the change materially harder to reason about or maintain

Ignore trivial style, formatting, typos, and other nits.

## 5) Search before ranking

Do not stop after the first few issues.

First gather all qualifying candidate findings from the change. Then deduplicate and rank them.

The search process is not limited to three findings, even if the final review is short.

## 6) Verification

When practical, run the smallest relevant checks you can discover from repo tooling.

- Prefer targeted tests and linters for the touched area
- If verification fails, report that before lower-priority nits
- If you cannot run checks, say so briefly

## 7) Follow-up review

In a follow-up pass:

- First verify whether previous findings were actually addressed
- New findings are allowed if they were introduced by the latest patch
- New findings are also allowed if they were missed previously but are now supported by concrete evidence

Do not suppress real issues just to avoid shifting goalposts.

## 8) Output requirements

Output format is flexible. Optimize for useful review comments, not template compliance.

Minimum requirements:

- Put findings first
- Include exact file and line evidence
- Keep any summary short
- If there are no meaningful findings, say `None.`

## 9) Hard rules

- Do not guess line numbers
- Prefer the smallest line range that pinpoints the issue
- Prefer bugs, regressions, and stale tests/docs over style nits
- Do not propose large refactors unless the risk clearly justifies them
- Do not modify code or open PRs unless explicitly asked
