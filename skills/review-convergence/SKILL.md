---
name: review-convergence
description: Coordinate Copilot findings, batched local fixes, scoped verification, and human handoff for a regular PR or native GitHub stack. Use after Copilot review, CI failure, or human-requested changes; preserve SHA-pinned evidence and allow at most one conditional re-review without implicit remote or history operations.
---

# Review convergence

Read the [shared SDLC review contract](../sdlc-review-contract.md) before assessing or mutating a change. It defines topology, source authority, evidence freshness, dispositions, operation boundaries, and the review bound. Follow it throughout this workflow.

## 1. Establish the handoff

Accept a PR or native stack target, user-designated specification/design sources, existing local understanding/review/verification evidence, and any prior change context. Resolve repository facts with read-only queries; ask only for unavailable intent or authorization.

Normalize the target under the shared contract. Record full local/remote head and immediate-base SHAs and keep selected PRs separate from authorized edit owners. Missing local refs block execution, not read-only remote assessment. Missing spec, review, behavior coverage, or approval evidence becomes a named blocker; reuse available local capabilities to obtain it rather than installing another skill.

Resume the review ledger and prior dispositions. If a snapshot or source changed, invalidate affected decisions before using them. Completion: scope, topology, sources, evidence gaps, and remaining review allowance are explicit.

## 2. Collect and propose dispositions

Use [fix-copilot-comments](../fix-copilot-comments/SKILL.md), sections 1-3, for immutable comment collection, source roles, investigation, ownership, plans, and execution preconditions. Its existing [collector](../fix-copilot-comments/scripts/copilot-comments.mjs) is the only collector. Validate topology through native metadata as required by the shared contract; do not rely on the collector's heuristic stack fallback.

Collect every layer for context, without expanding edit scope. Supplement missing review provenance/replies with read-only queries as specified by the contract. Empty unresolved comments do not prove a completed Copilot review. If no initial review exists, report the exact head needing an explicit review request and stop that lane.

Apply the existing disposition rubric to every finding, including suppressed comments and prior decisions. Group shared root causes once by owning PR and commit target. Record agent-proposed dispositions, evidence, required scoped checks, and affected descendants in the existing plan. Pause ambiguous/high-risk groups for human decisions; independent authorized low-risk groups may proceed. Do not turn advisory smells into mandatory fixes or approve your own high-risk exception.

Completion: every collected finding is accounted for, and every executable group has supported ownership, approved scope, a current target, and a verification plan.

## 3. Execute one branch-local batch

This composition reuses the existing workflow's collector, planning, branch-local execution, validation, and reporting, NOT its section 4 manual Git cascade or section 5 autosquash. The actual companion file is [copilot-comment-executor](../../agents/copilot-comment-executor.md); use this path rather than the older skill's `copilot-comment-fixer.md` reference.

When local editing/committing is authorized and the owning branch is already checked out with all preconditions satisfied, execute its approved groups once through that executor, or follow the same contract inline. One writer owns the worktree. If the correct branch is not checked out, report the required branch preparation rather than letting an executor switch it.

For an already implemented, approved patch requiring a fixup, use [stage-fixup](../stage-fixup/SKILL.md) with the full target SHA, approved paths/patch, expected HEAD, and scoped checks. Do not call it again for a commit the executor already created. If commits are forbidden, stop before invoking either committing path; a review request cannot override that restriction.

Validate the executor's result using the existing fix workflow's section 4 result checks and section 6 reporting rules. Account for every approved group, actual commit, partial failure, and final worktree state. Run the plan's scoped checks against final inputs; include behavioral coverage separately from builds and Git checks. Missing or failed required verification blocks progression.

After a lower-layer change, mark affected descendants synchronization-pending and stop before descendant execution. Report the native rebase/push operations requiring separate explicit authorization. Resume only after native synchronization, refreshed SHAs, target remapping, and affected-layer verification. Do not perform a manual cascade.

## 4. Decide the next review action

Reassess findings at the resulting heads. Read CI results with their PR-head/tested-commit mapping and authoritative required-check set. Route failures according to the shared contract; neither a pending check nor a planned rerun is success.

Apply the contract's one-conditional-re-review rule to the whole batch per affected PR, not to each comment. Report `request initial review`, `request conditional re-review`, `wait for existing review`, or `no further Copilot request`, with head, reason, and ledger evidence. Requests remain external explicit operations. At the bound, hand new findings or uncovered deltas to the human; do not loop until comments disappear.

Human change requests re-enter the affected implementation/design lane without resetting the review ledger. Preserve prior declines unless new evidence or a human decision changes them.

## 5. Return the handoff

Return a compact report and the shared change context, optionally saved beside the existing run artifacts:

```text
status: CONVERGED | BLOCKED
scope: <selected PRs and ordered native layers>
refs: <per-layer local head, remote head, immediate base>
findings: <ID | owner | disposition | pending/completed | evidence>
verification: <scoped local results, behavior coverage, CI results/gaps>
reviews: <initial/re-review IDs and actual SHAs; remaining allowance>
blockers: <missing evidence, decisions, synchronization, failures>
next: <specific human decision or separately authorized operation>
artifacts: <immutable snapshot, plan/version, executor results>
```

Use CONVERGED only when findings are completely accounted for, required corrections are verified, evidence is current under the contract, required checks pass, and no blocking question, synchronization gap, or unaccepted review delta remains. Final human approval may still be pending: state that explicitly and hand off to [merge-readiness](../merge-readiness/SKILL.md). CONVERGED is not READY and never authorizes a remote operation.
