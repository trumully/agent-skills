---
name: fix-copilot-comments
description: Use this skill when the user asks to fix, address, or triage unresolved Copilot review comments on a pull request or stacked pull requests, including requests such as "fix Copilot comments" or "address Copilot review". Verify each comment against explicitly supplied issue or local direction sources, preserve accepted fixes as fixup commits against the PR commits they correct when possible, apply them on the owning branches, validate and cascade stacked branches, and report dispositions without pushing or writing to GitHub.
compatibility: Requires Git, git-absorb (`git absorb`), GitHub CLI (`gh`), Node.js, GitHub authentication, and repository access; `github/gh-stack` is used when multi-PR stack tracking is available.
license: Unlicense
---

# Invocation

Use either the explicit form:

```text
/skill:fix-copilot-comments [<pr-number>|stack] [<spec-path>] [--direction <source>]... [--context <source>]...
```

The positional `<spec-path>` remains a shorthand for one `--direction` source. A source is either a repository-relative local file or plan, an explicit GitHub issue URL, `owner/repo#<number>`, or `#<number>` for an issue in the current repository. Do not read the PR body.

The natural-language form is also supported. For example:

```text
Address Copilot review on PR #903 which seeks to address issue #901, #902, due to dev-docs/SeismicRestraintTools/Plans/Pipeline-Retry-And-Resume.md.
```

Interpret an explicitly named PR as the target, issue references following `issue` or `issues` as `--direction` sources, and a file introduced by `due to`, `using`, or `from` as a `--direction` source. If the source role or target is ambiguous, ask before changing branches. Use explicit `context` wording or `--context` when a source is supporting evidence rather than requested behaviour.

`--direction` and `--context` may each be repeated and may contain either source type. Direction sources define requested behaviour and ownership. Context sources supply facts and constraints but cannot override direction. Multiple direction sources must agree; a conflict becomes `question` rather than an ordering choice.

Run this workflow in the main session. Resolve `<skill-dir>` from the `[Skill directory: ...]` line injected by the harness. The collector lives at `<skill-dir>/scripts/copilot-comments.mjs`.

# 1. Resolve arguments and sources

- When `<pr-number>` is numeric, process that PR only. Still discover its complete open stack because an accepted fix may need to move branches above it.
- When the first argument is `stack`, or when no PR number is supplied, find the current branch's PR with `gh pr view --json number --jq .number`. If that command fails, ask for a PR number.
- Parse only the user's invocation for the target PR, issue sources, and local sources. Never infer sources from the PR body, review comments, issue links, or source-file contents.
- If no direction or context source is supplied, ask once for one. Do not scan for candidate files or issues. A response that supplies no readable source stops the workflow.
- Read every supplied local source before changing branches. Validate every supplied issue source with read-only `gh issue view` and retain its canonical URL. A missing file or issue stops with the read error.
- If only context sources are supplied, allow the fixer to address an obvious correctness bug but require `question` for decisions that need intended behaviour or PR ownership.

In `stack` mode, process every PR discovered in the open stack. With a numeric PR argument, process only that PR even though the complete stack is retained for rebase decisions.

# 2. Check preconditions

Stop with the exact message shown when any precondition fails:

1. Run `git status --porcelain`. Non-empty output: `working tree not clean`.
2. Run `gh auth status`. Failure: `gh not authenticated`.
3. Run `git rebase --show-current-patch`. Success, or the git-dir contains `.git/gh-stack-rebase-state`: `rebase in progress`.
4. Run `git absorb --version`. Failure: `git absorb not installed`.
5. Record `ORIGINAL_BRANCH=$(git branch --show-current)`.

Do not modify the worktree before all four checks pass.

# 3. Discover the open stack

Run:

```text
node "<skill-dir>/scripts/copilot-comments.mjs" stack <pr-number>
```

Keep the ordered `trunk` and `prs` values. The script reports a missing or ambiguous stack and the workflow stops with that error.

# 4. Adopt stack tracking when needed

If the discovered stack contains one PR, do not inspect or invoke `gh stack`, do not initialise stack tracking, and do not run a rebase. Continue to comment collection.

If it contains more than one PR:

1. Run `gh extension list`. If `github/gh-stack` is absent, stop with:

   ```text
   run: gh extension install github/gh-stack
   ```

2. Run `gh stack view --json`.
   - Exit 0: compare its branch list with the collector's ordered PR heads. If they differ, stop and report both lists without changing the stack.
   - Exit 2: run `gh stack init <bottom-head> <...> <top-head>`. Use `--base <trunk>` only when the collector's trunk differs from the repository default. `gh stack init` may switch branches; step 6 explicitly switches before every agent run.
   - Any other non-zero exit: stop and report the command output.
3. If `gh stack init` exits 9 because stacked PRs are not enabled for the repository, skip `gh stack` for the rest of this run and use the plain-git cascade described in step 6. Otherwise, stop and report its output.

Never run `gh stack push`, `gh stack submit`, or `gh stack sync`.

# 5. Collect comments

Choose the PR numbers to collect: the single requested PR for numeric mode, or every PR in bottom-to-top order for `stack` mode. Run:

```text
node "<skill-dir>/scripts/copilot-comments.mjs" comments --out "$(git rev-parse --git-dir)/copilot-comments.json" <n...>
```

The file is raw input for the agents. Do not edit it. If every selected PR has zero unresolved threads and zero suppressed comments, report `no unresolved Copilot comments`, restore `ORIGINAL_BRANCH` if necessary, and finish.

# 6. Process branches bottom to top

Use the shared worktree sequentially. Never run agents in parallel.

For each selected PR in bottom-to-top stack order:

1. Run `git switch <head>` and record `BEFORE=$(git rev-parse HEAD)`.
2. Spawn exactly one `copilot-comment-fixer` task. The task is blocking because the next branch depends on its result. Include:
   - PR number;
   - head and base branches;
   - stack trunk;
   - direction sources, including the legacy spec path when supplied;
   - context sources;
   - absolute comments JSON path;
   - ordered PR numbers and head branches above this PR in the discovered stack; and
   - `Process only the entry for PR <n> in the JSON.`

Require the agent to discover and cache the repository's applicable format, lint, build, and test commands once per branch from the applicable `AGENTS.md`, `CONVENTIONS.md`, `CONTRIBUTING.md`, `README.md`, package/build configuration, and, only when local guidance is insufficient, recent CI runs.
It must use the narrowest supported commands, not invent generic commands, and not run project-wide checks unless repository guidance requires them. It must run scoped formatter/linter checks and `git diff --cached --check` before each commit.
Require the agent to preserve existing branch history: a fix that corrects code introduced by this PR uses the fixer contract's `git absorb` flow to create a non-empty `fixup!` commit against that PR commit. Use an ordinary focused commit only for work that is genuinely separate from existing PR commits. Do not rebase after absorbing.
Require the agent to apply the fixer triage rubric and group comments with the same root cause and target commit. One non-empty focused fixup commit may satisfy multiple `fix` dispositions in one group; unrelated groups must stay separate. A genuinely separate change may use one ordinary focused commit.
Require every `fix` disposition to reference a non-empty fixup or ordinary commit and every agent result to return a validation status; only `validation.status: pass` may cascade. If the requested change is already present or produces no staged diff, the agent must report `decline` with reason `already satisfied; no change required`, set `commit` to `null`, and make no commit. It must never use `git commit --allow-empty` or an equivalent empty-commit mechanism. The agent's frontmatter hands implementation to `@smol` at its first edit after all dispositions are decided.
3. Parse the agent's structured JSON. If it is missing or invalid, record every comment for this PR as `question` with reason `agent failed: <first line of the failure>` and continue to the next selected PR. Require `validation.status` and validate every `fix` commit, including `fixup!` commits, with `git diff-tree --quiet --no-commit-id -r <commit>^ <commit>`; an empty or missing fix commit is a contract failure. If `validation.status` is `fail`, do not cascade; restore the original branch and stop with `validation failed: <failures>`.
   Before checking for a cascade, run `git diff --check <base>...HEAD`. If it reports whitespace errors, restore the original branch and stop with `formatting check failed: <first line>`. The agent's documented formatter and linter checks are the language-level gate; this is the generic final whitespace gate.
4. Run `git rev-parse HEAD` again. If it equals `BEFORE`, do not rebase.
5. If it changed and this PR is not the top of the discovered stack:
   - With `gh stack` tracking, run `gh stack rebase --no-trunk --upstack` from this branch. If the extension rejects the combined flags, retry with `gh stack rebase --no-trunk`.
   - Exit 0: continue.
   - Exit 3: run `gh stack rebase --abort`, capture the conflicted files printed by `gh stack`, restore the original branch in step 7, and stop. Report the fix commits on `<head>`, the conflicted files, and:

     ```text
     resolve with: git switch <head-above>; git rebase <head>
     ```

   - Any other non-zero exit: restore the original branch and stop with the command output.
   - Without `gh` stack tracking, cascade the upper branches in order with plain git. For each upper branch, run `git rebase --onto <lower-head> <lower-head>@{1} <upper-head>`. On conflict, run `git rebase --abort`, capture the conflicted files, restore the original branch, and stop with the same resolution instruction.

Continue to the next selected PR only after its agent and any required cascade rebase finish successfully. Never fetch during this workflow.

# 7. Restore the original branch

Run:

```text
git switch "$ORIGINAL_BRANCH"
```

If the original branch was rebased as part of an up-stack cascade, its moved tip is expected. If restoration fails, report the failure after retaining the per-PR dispositions.

# 8. Report

Report one table per selected PR with these columns:

```text
disposition | path:line | commit (short SHA) | reason
```

Mark a suppressed path with `(suppressed)` after `path:line`. Use `—` for a missing commit. Include the agent's verification result when it clarifies the reason.
A grouped commit may appear on multiple rows when it covers multiple comments.

For every branch that gained commits, include:

```text
commits to review: git log origin/<head>..<head>
```

For a multi-PR stack, end with `push with: gh stack push` as a user action only. For a one-PR stack, end with `push with: git push origin <head>` as a user action only. Mention `.git/copilot-comments.json` as the raw input.

This workflow never performs either push command, never replies to review comments, and never resolves threads.
