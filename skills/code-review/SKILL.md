---
name: code-review
description: Review code changes with evidence-based, prioritized findings; focus on correctness, risk, tests, and maintainability.
metadata:
  short-description: High-signal code review (verifiable)
---

# Code Review (Verifiable + Risk-Focused)

Review changes like an owning teammate. Produce *prioritized, actionable findings* grounded in evidence (diff + codebase context + command results when available).

## 0) Pick a review target (ask if unclear)

Choose exactly one and state it explicitly:

1. **Against a base branch (PR style)**: “What would merge into `<baseBranch>`?”
2. **Uncommitted changes**: staged + unstaged + untracked changes in the working tree
3. **A single commit**: review commit `<sha>`
4. **Custom instructions**: follow user-provided review instructions verbatim

If the user does not specify, default to **Against a base branch** with `<baseBranch>=main`.

Ask for any relevant **RFC/design doc** (link or file path). If none exists (or it’s unclear), ask for a 3–5 bullet “expected behavior & non-goals” summary so you can review against concrete acceptance criteria.

## 1) Collect facts (commands-first)

Always start with:

- `git status`
- `git diff --stat`
- `git log --oneline --decorate -n 20`

Then, depending on the target:

### A) Against a base branch (PR style)

1) Determine merge base:

- `MB=$(git merge-base HEAD <baseBranch>)`

2) Inspect the merge diff:

- `git diff $MB..HEAD`

If `git merge-base` fails or the base branch is not local, try:

- `git fetch -p`
- `MB=$(git merge-base HEAD <baseBranch>@{upstream})`
- `git diff $MB..HEAD`

Optional (GitHub):

- `gh pr view --json title,body,files,commits`
- `gh pr diff`

### B) Uncommitted changes

- `git diff --staged`
- `git diff`
- `git ls-files --others --exclude-standard` (untracked files list)

### C) A single commit

- `git show <sha>`

## 1.5) Confirm intent vs. reality (required)

- State the intended behavior (from PR title/body, commit message, or user-provided intent).
- State what the diff actually changes (behavior and interfaces).
- Call out any mismatch (including scope creep, missing pieces, or surprising changes).

## 1.6) Spec / RFC alignment (required when a spec exists)

If an RFC/design doc exists:

- Extract key requirements, invariants, and acceptance criteria from the doc.
- Check the implementation against them (including edge cases, error semantics, and compatibility promises).
- Treat spec mismatches as **BLOCKER** unless the doc is explicitly being updated in the same change.

If no spec exists, treat the user’s “expected behavior & non-goals” bullets as the review baseline and call out any ambiguity.

## 2) Review rubric (in priority order)

Focus on the highest-risk paths first; only open additional files when needed to confirm a top finding.

1. **Correctness**: edge cases, error/exception paths, nullability, concurrency/races, idempotency, resource lifecycle
2. **Change risk**: breaking changes, behavior changes, migration/rollout/rollback complexity, compatibility (API/data/config)
3. **Security**: input validation, injection, authz/authn, secrets/logging, unsafe deserialization
4. **Performance**: hot paths, N+1, extra IO, accidental O(n²), cache invalidation, allocations
5. **Maintainability**: naming, duplication, complexity, API design, documentation drift
6. **Observability**: logs/metrics/traces, error reporting, debuggability, SLO-impacting blind spots
7. **Tests**: missing coverage, weak assertions, flaky risk, missing negative/edge cases

### Regression safety (required)

You cannot guarantee non-breakage, but you must proactively reduce regression risk:

- Identify existing behaviors/surfaces most likely impacted by the change.
- Call out hidden coupling points (shared code paths, config defaults, serialization formats, public APIs).
- Recommend (or run) targeted regression tests that cover the affected surfaces, especially previously supported “happy paths”.
- If the change alters defaults, flags, config parsing, request/response schemas, or persistence formats, explicitly assess backwards compatibility and upgrade/downgrade behavior.

### Alternative perspectives (required)

For the most important paths, propose 2–5 concrete “other directions” to consider, such as:

- A simpler design or API shape that reduces complexity
- An alternative implementation that is easier to test or reason about
- Assumptions that should be made explicit (in code/docs/tests), and what happens if they don’t hold
- Compatibility or rollout implications that reviewers may miss
- Observability improvements that would reduce future debugging time

If you truly have none, explicitly state `None identified` and explain why.

Convert these into actionable **Risks**, **Suggestions**, and **Tests** (when they reduce risk).

### Language idioms & best practices (required)

Ensure the change is idiomatic for the language(s) touched and consistent with existing repo conventions. Specifically:

- Prefer established, idiomatic APIs over “clever” or unusual calls; if a call looks surprising, verify it in upstream docs and suggest a more standard approach.
- Follow project patterns for errors, logging, configuration, naming, and module structure; avoid introducing a new style unless clearly justified.
- When suggesting code, keep it minimal and idiomatic; avoid “AI-looking” abstractions or over-generalized helpers.
- If the change introduces a new dependency or a new architectural pattern, validate that it matches the ecosystem and repo norms; call out simpler or more standard alternatives and ask for explicit justification when needed.

Language-specific checks (apply when relevant):

- **Rust**: avoid `unwrap()`/`expect()` outside tests unless justified; prefer explicit error types/contexts; watch for unnecessary clones/allocations; use idiomatic iterators; consider `Send`/`Sync`, lifetimes/borrowing, and panic safety.
- **Python**: avoid overly broad exceptions; use context managers for resources; prefer `pathlib`; keep async code correct (no blocking calls on event loops); follow typing conventions if the repo uses them.

### Documentation quality (when applicable)

If the change touches docs or implies docs should change:

- Match the repo’s existing documentation style and structure (headings, tense/voice, formatting, terminology).
- Keep it human-readable and concise; avoid “AI-sounding” filler and generic phrasing.
- Ensure accuracy: examples compile/run, commands are correct, links/paths exist, and the doc matches actual behavior.
- Prefer updating existing docs over adding new docs unless clearly justified.

### Stale tests & docs hygiene (required)

Proactively check for unit tests and docs that no longer match reality. If a test/doc is outdated, either update it or remove it—do not keep misleading artifacts.

Minimum scan:

- Identify any renamed/removed public symbols, flags, config keys, endpoints, files, or CLI commands.
- Search for stale references in likely locations (adjust to the repo): `docs/`, `README*`, `tests/`, `*_test.*`, `spec/`, `examples/`.
  - Example: `rg -n "<identifier>" docs tests README* -S`
- If you changed behavior, ensure tests/docs describe the new behavior and no longer assert the old behavior.

Treat as:

- **BLOCKER**: failing tests, or docs/tests that would clearly mislead users into broken usage.
- **MAJOR**: significant doc/test drift that increases regression risk or hides breaking changes.

## 3) Verification (minimal, relevant)

Prefer running the smallest relevant checks/tests for the touched area(s). Do not invent commands:

- Discover test/lint commands from the repo (e.g., `package.json`, `Makefile`, `justfile`, `Cargo.toml`, `pyproject.toml`, CI configs).
- If formatters/linters are configured for the touched language(s), prefer running them (e.g., Rust: `cargo fmt`, `cargo clippy`; Python: `ruff`, `black`, `mypy`) *when present in the repo/tooling*.
- If you can’t run commands, provide explicit commands the author should run and what “success” looks like.

If verification fails, report the failure succinctly and stop digging into nits until the failure is understood.

## 4) Output format (strict)

Use this exact structure. Include file path + line number when possible, or a minimal searchable snippet.

### Summary
- Intent (1 line)
- What changed (1–2 lines)
- Verdict: **Approve** / **Request changes** / **Comment**
- Spec/RFC alignment: **OK** / **Mismatch** / **Not provided**
- Regression risk: **Low** / **Medium** / **High** (brief evidence)
- Verification: **Ran** `<commands>` (**pass/fail**) / **Not run** (recommended `<commands>`)

### Top findings (max 3)
Numbered list. If there are no meaningful findings, write `None.` and do not invent issues.

Each item must include:
- Severity: **BLOCKER** / **MAJOR** / **MINOR**
- Issue + why it matters
- Evidence
- Suggested fix (concrete)

### Must-fix (blocking)
Only BLOCKER items.

### Risks (important, non-blocking)
Triggers + mitigations. Include at least **two alternative perspectives** (tradeoffs or other directions worth considering), or explicitly state that none were identified.

### Suggestions (non-blocking)
High-leverage only (avoid noisy nits).

### Tests / Verification
- Commands executed + results
- Recommended commands (if not executed) + rationale
- Manual verification steps (if applicable)
- Add targeted test ideas (including edge/negative cases) when they reduce risk.

### Questions
Only questions that unblock intent/diff alignment or risk assessment.

## 5) Hard rules

- Do not propose large refactors unless clearly justified by risk.
- Do not assume unspecified requirements; state assumptions and ask clarifying questions.
- Do not modify code or open PRs unless explicitly asked; this task is review + feedback by default.
- If you propose doc changes, write them in the repo’s doc style and as ready-to-merge human text (no “As an AI…”, no filler, no generic boilerplate).
- If you propose code changes, keep them idiomatic for the language and consistent with repo conventions; avoid unusual APIs unless clearly justified and verified.
- Avoid shifting goalposts: do not “manufacture” findings. In follow-up review passes, focus on verifying that previous findings were addressed and only add new items if new evidence emerges.
