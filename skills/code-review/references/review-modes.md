# Review Modes

Keep `SKILL.md` as the default single-reviewer path. Use this file only when the change is large, mixed, or already went through one review round.

## Default mode

Use the core `code-review` skill once.

Use this when:

- The diff is small or medium
- The change mostly stays in one subsystem
- You only need one final review pass

## Fan-out mode

Use multiple focused review passes when the diff spans several concerns or subsystems.

Recommended split:

- Pass 1: correctness and regressions
- Pass 2: compatibility, config, schema, and interface drift
- Pass 3: tests, docs, examples, comments, and stale references

Rules:

- Each pass should collect candidate findings only for its own concern
- Each pass must still meet the same evidence bar as the main skill
- Merge and deduplicate findings only after all focused passes finish

If the environment supports multiple agents or sessions, run these in parallel. Otherwise run them sequentially with fresh context between passes.

## Module-split mode

If the diff touches unrelated directories or modules, review each module separately before combining findings.

Use this when:

- The changed files do not share one obvious code path
- One large diff would otherwise overflow useful context
- Different modules need different review attention

Rules:

- Keep each module review narrow
- Do not mix findings across modules until the merge step
- After merging, deduplicate repeated reports about the same root cause

## Follow-up mode

Use this after the author updated the patch in response to review.

Rules:

- Verify old findings first
- Then search for new issues introduced by the latest patch
- Also allow `missed previously` findings if they now have concrete evidence
- Do not suppress real issues just to avoid shifting goalposts

## Judge mode

This is optional and experimental. Use it only after one or more review passes already produced candidate findings.

The judge pass may:

- Deduplicate overlapping findings
- Drop weak or speculative findings
- Merge repeated findings that share one root cause
- Rank the highest-signal findings for the final review

The judge pass may not:

- Invent new findings from scratch
- Lower the evidence bar
- Rewrite a weak claim into a stronger unsupported one

Use judge mode when the main problem is noise, not lack of coverage.
