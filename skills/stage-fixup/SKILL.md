---
name: stage-fixup
description: Use when the user asks to create local Git fixup commits, stage the current diff as a fixup, attach review changes to an existing commit, or use git absorb. Require approved paths and either an explicit target commit or automatic attribution from the current diff; stop for missing or ambiguous scope. Do not autosquash or perform remote operations.
---

# Stage a fixup commit

Use this skill for a change that is already implemented in the current worktree and must be attached to one or more existing commits. The caller must supply approved paths or an approved patch, and either a full 40-character target commit SHA or permission to infer targets from the current diff. Supply the expected current `HEAD` when the change came from an approved plan.

The skill uses deterministic `git commit --fixup=<target-sha>` when a target is supplied. When the request asks for fixups from the current diff without a target, it may use `git absorb` to infer targets. Absorb attribution is heuristic, so target ownership remains review-required; use an explicit target when ownership matters. If `git absorb` is unavailable, request an explicit target and never create a normal commit as a fallback.

## 1. Establish the preconditions

1. Resolve the repository root with `git rev-parse --show-toplevel` and retain the absolute path for every subsequent command.
2. Confirm the current branch with `git branch --show-current` and current head with `git rev-parse HEAD`. A detached head, a supplied `expectedHead` that does not match, an active merge, rebase, cherry-pick, revert, or conflict is blocked.
3. Confirm the index is clean with `git diff --cached --quiet`. Preserve any existing staged work for its owner; do not absorb or unstage it.
4. When a target SHA is supplied, resolve it with `git rev-parse --verify <target-sha>^{commit}`, require the resolved SHA to equal the supplied full SHA, and confirm it is reachable from the current branch with `git merge-base --is-ancestor <target-sha> HEAD`.
5. Inspect `git status --porcelain=v1 -uall` and the worktree diff. Every non-ignored changed path must be in the approved path set. If a file mixes this fix with unrelated edits, stop and request an isolated patch or hunk set before staging.
6. In automatic mode, probe availability with `git absorb --version`. If the command is unavailable, return `blocked` with the required target SHA and leave Git untouched.

A failed precondition leaves Git untouched and returns `blocked` with the observed branch, head, target, mode, and conflicting paths.

## 2. Stage only the approved change

Stage complete approved paths only when the entire path belongs to this fix:

```sh
git add -- <approved-path>...
```

For mixed files, apply an approved patch to the index instead of staging the whole file. Stop when the hunk boundary cannot be established safely.

Inspect the index before committing:

```sh
git diff --cached --name-status
git diff --cached --check
git diff --cached
```

The staged paths must be non-empty, belong only to the approved path set, and contain the intended fix. `git diff --cached --check` must pass. A clean staged diff is an `unchanged` result, not a commit opportunity.

Use the index as the commit boundary. Do not stage with `git add -A`, `git add .`, or an inferred repository-wide path.

## 3. Create fixup commits

Capture the current head immediately before committing:

```sh
git rev-parse HEAD
```

Record the output as `beforeHead`.

For an explicit target, create one fixup commit:

```sh
git commit --fixup=<target-sha>
```

For automatic attribution, run `git absorb` without `--and-rebase`. `git absorb` considers only the staged index and may create multiple `fixup!` commits, one for each target it can infer. Its mapping is heuristic; inspect the generated commit subjects and patches before any history compaction. It may leave unabsorbed hunks in the index; preserve them and report the run as blocked until their ownership is explicit.

## 4. Verify the result

For explicit-target mode, verify that a subsequent `git rev-parse HEAD` produces a new commit SHA whose parent is `beforeHead`, the subject begins with `fixup!`, the changed paths are approved, the target remains an ancestor, and the index and worktree are clean.

For automatic mode, inspect `git log --reverse --format=%H%x09%s <beforeHead>..HEAD`. Every new commit must have a `fixup!` subject, every changed path must be approved, and the index must be clean. Any remaining staged hunk, non-fixup commit, unapproved path, or command failure is `blocked` or `fail`; preserve all actual commits and changes. Mechanical success does not prove that absorb selected the correct target.

Run only checks supplied by the approved plan. A successful commit does not prove behavioral correctness; report behavior checks separately.

## 5. Report

Return a compact result containing:

```text
status: pass | blocked | fail
mode: explicit-target | absorb
branch: <branch>
beforeHead: <sha>
afterHead: <sha>
targetSha: <sha | none>
mapping: explicit | inferred-review-required
commits: <new fixup SHAs>
paths: <approved changed paths>
checks: <observed Git and plan checks>
```

Use `pass` only when every verification for the selected mode succeeds. Preserve the actual worktree and index on a commit or check failure; report the failure instead of running recovery commands that were not approved.

## History and remote operations

This skill creates temporary local fixup commits. It does not autosquash, rebase, fetch, push, force-push, reply to review comments, or resolve threads. Run history compaction only through a separate explicit operation after all fixups and branch checks are complete.
