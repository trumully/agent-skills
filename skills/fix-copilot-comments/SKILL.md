---
name: fix-copilot-comments
description: Address unresolved Copilot review comments on a pull request or stacked pull requests. Verify each comment against explicitly supplied direction and context sources, preserve accepted fixes as fixup commits when they correct existing PR commits, validate stack cascades, and report every disposition without pushing or writing review responses.
compatibility: Requires Git, git-absorb (`git absorb`), GitHub CLI (`gh`), GitHub authentication, and repository access. A stacked-PR tool is optional; plain Git cascade instructions are included.
---

# Invocation

Use:

```text
fix-copilot-comments [<pr-number>|stack] [<direction-source>] [--direction <source>]... [--context <source>]...
```

A source is either a repository-relative local file or plan, an explicit GitHub issue URL, `owner/repo#<number>`, or `#<number>` for an issue in the current repository. The positional source is shorthand for one `--direction` source. Do not read the PR body to infer direction sources.

The natural-language form is also supported. For example:

```text
Address review on PR #123 using issue #456 and docs/plan.md.
```

Interpret an explicitly named PR as the target, issue references following `issue` or `issues` as direction sources, and a file introduced by `due to`, `using`, or `from` as a direction source. Use explicit `context` wording or `--context` when a source supplies supporting evidence rather than requested behaviour. If the target or source role is ambiguous, ask before changing branches.

Direction sources define requested behaviour and ownership. Context sources supply facts and constraints but cannot override direction. Multiple direction sources must agree; a conflict becomes `question` rather than an ordering choice.

# 1. Resolve arguments and sources

- With a numeric PR argument, process that PR only. Still discover its complete open stack because an accepted fix may need to move branches above it.
- With `stack`, or without a PR number, determine the current branch's PR using `gh pr view --json number --jq .number`. If that fails, ask for a PR number.
- Parse only the user's invocation for the target PR, direction sources, and context sources. Never infer sources from review comments, PR links, or source-file contents.
- If no direction or context source is supplied, ask once for one. Do not scan for candidate files or issues.
- Read every supplied local source before changing branches. Validate every supplied issue source with read-only `gh issue view` and retain its canonical URL. A missing file or issue stops with the read error.
- If only context sources are supplied, allow the fixer to address an obvious correctness bug but require `question` for decisions that need intended behaviour or PR ownership.

In `stack` mode, process every PR discovered in the open stack. With a numeric PR argument, process only that PR while retaining the complete stack for cascade decisions.

# 2. Check preconditions

Stop with the exact message shown when a precondition fails:

1. Run `git status --porcelain`. Non-empty output: `working tree not clean`.
2. Run `gh auth status`. Failure: `gh not authenticated`.
3. Run `git rebase --show-current-patch`. Success, or a Git stack-rebase state exists: `rebase in progress`.
4. Run `git absorb --version`. Failure: `git absorb not installed`.
5. Record `ORIGINAL_BRANCH=$(git branch --show-current)`.

Do not modify the worktree before all five checks pass.

# 3. Discover the open stack

Determine the ordered stack from the target PR using the repository's supported GitHub/stack tooling. Retain the ordered trunk, PR numbers, head branches, and base branches. A missing or ambiguous stack stops the workflow.

When no stack discovery tool is available, use the target PR's `baseRefName`, `headRefName`, and the repository's open PR metadata to reconstruct the stack. Stop if the order cannot be established safely; do not guess.

# 4. Adopt optional stack tracking

If the discovered stack contains one PR, do not initialize a stack-tracking tool and do not rebase before comment collection.

If it contains multiple PRs and the repository uses a stack-tracking tool:

1. Check that the tool is installed. If it is absent, report the installation command and use the plain-Git cascade only when branch ancestry and previous tips can be established safely.
2. Inspect its tracked branch list and compare it with the discovered ordered PR heads. If they differ, stop and report both lists without changing the stack.
3. Initialize tracking only when the tool reports that tracking is absent. Use the discovered trunk only when it differs from the repository default.
4. Never push, submit, or synchronize the stack during this workflow.

# 5. Collect comments

Collect unresolved Copilot review threads and suppressed comments for the selected PRs in bottom-to-top order. Use the host's GitHub integration or read-only GitHub CLI/API facility. Save the raw result to `.git/copilot-comments.json`; do not edit it.

The collected data must retain, for every thread:

- PR number and review commit;
- comment URL, path, line, original line, body, and replies;
- whether the thread is unresolved or suppressed; and
- enough source context for the fixer to locate outdated comments.

If every selected PR has zero unresolved threads and zero suppressed comments, report `no unresolved Copilot comments`, restore `ORIGINAL_BRANCH` if necessary, and finish.

# 6. Process branches bottom to top

Use the shared worktree sequentially. Do not process branches in parallel.

For each selected PR in bottom-to-top stack order:

1. Run `git switch <head>` and record `BEFORE=$(git rev-parse HEAD)`.
2. Invoke one `copilot-comment-fixer` agent, or run the equivalent fixer procedure in the current session when the host has no subagent facility. Supply:
   - PR number;
   - head and base branches;
   - stack trunk;
   - direction sources and context sources;
   - absolute `.git/copilot-comments.json` path;
   - ordered PR numbers and head branches above this PR; and
   - an instruction to process only this PR's entry in the JSON.
3. Require the fixer to discover and cache applicable formatter, lint, build, and test commands from repository guidance and configuration. It must use the narrowest supported commands, avoid invented generic commands, and run scoped formatter/linter checks plus `git diff --cached --check` before each commit.
4. Require the fixer to decide every comment before editing, apply the triage rubric, and group comments by shared root cause and target commit. One non-empty focused fixup commit may satisfy multiple `fix` dispositions in one group; unrelated groups remain separate.
5. Require history preservation: a fix correcting code introduced by this PR uses `git absorb --base <base> --force-author --one-fixup-per-commit` to create a non-empty `fixup!` commit against the introducing PR commit. A genuinely separate change uses one ordinary focused commit. The fixer must run the absorb dry run with `--verbose`, inspect the proposed target, and decline to commit when no safe target exists. It must not rebase after absorbing.
6. Require every `fix` disposition to reference a non-empty commit and every result to include validation status. An already satisfied change is `decline` with reason `already satisfied; no change required`, `commit: null`, and no commit. Empty commits are prohibited.

After the fixer returns:

1. Parse its structured JSON. If it is missing or invalid, record every comment for this PR as `question` with reason `agent failed: <first line of failure>` and continue to the next selected PR.
2. Require `validation.status`. Validate every `fix` commit, including fixup commits, with:

   ```text
   git diff-tree --quiet --no-commit-id -r <commit>^ <commit>
   ```

   A missing or empty fix commit is a contract failure.
3. If validation fails, restore the original branch and stop with `validation failed: <failures>`.
4. Before any cascade, run `git diff --check <base>...HEAD`. On whitespace errors, restore the original branch and stop with `formatting check failed: <first line>`.
5. Run `git rev-parse HEAD` again. If it equals `BEFORE`, do not rebase.
6. If it changed and this PR is not the top of the discovered stack, cascade the change:
   - With stack tracking, use the tool's rebase-upstack operation without including trunk. If the combined no-trunk/upstack flags are rejected, retry with the tool's no-trunk form.
   - Without stack tracking, rebase each upper branch in order with `git rebase --onto <lower-head> <lower-head>@{1} <upper-head>`.
   - On conflict, abort the active rebase, capture conflicted files, restore the original branch, and stop. Report the fix commits and:

     ```text
     resolve with: git switch <head-above>; git rebase <head>
     ```

Continue to the next selected PR only after its fixer and all required cascade rebases finish successfully. Never fetch during this workflow.

# 7. Restore the original branch

Run:

```text
git switch "$ORIGINAL_BRANCH"
```

If the original branch was rebased as part of an upstack cascade, its moved tip is expected. If restoration fails, report the failure after retaining all per-PR dispositions.

# 8. Report

Report one table per selected PR:

```text
disposition | path:line | commit (short SHA) | reason
```

Mark suppressed paths with `(suppressed)` after `path:line`. Use `—` for a missing commit. Include fixer verification when it clarifies the reason. A grouped commit may appear on multiple rows when it covers multiple comments.

For every branch that gained commits, include:

```text
commits to review: git log origin/<head>..<head>
```

For a multi-PR stack, end with `push with: <the repository's stack push command>` as a user action only. For a one-PR stack, end with `push with: git push origin <head>` as a user action only. Mention `.git/copilot-comments.json` as the raw input.

This workflow never performs a push command, never replies to review comments, and never resolves threads.
