---
name: merge-readiness
description: Assess whether a regular PR or native GitHub stack is ready for human-authorized merge using current SHA-pinned review, verification, CI, ownership, and approval evidence. Return READY or NOT READY without changing files, Git state, checks, reviews, or GitHub state.
---

# Merge readiness

Read the [shared SDLC review contract](../sdlc-review-contract.md). Apply its evidence and topology rules; do not infer readiness from a prior CONVERGED or READY report.

This skill is strictly read-only. It may read local artifacts and query Git/GitHub. It never writes a manifest or snapshot, runs builds/tests, edits/stages/commits, fetches, switches branches, pushes, rebases, reruns CI, requests reviews, comments, resolves threads, approves, enters a merge queue, or merges. Report missing evidence instead of generating it through mutation. Return the report in the response.

## 1. Identify current inputs

Accept a PR or native stack and available change context. Resolve the complete native topology, selected PRs, remote heads, actual immediate bases, and local refs when supplied as implementation evidence. Confirm singleton status rather than inferring it from a failed stack lookup.

Read specification/design, understanding, local review, behavioral verification, finding plans/results, and review ledger by reference. Use read-only GitHub queries for current PR state, human/Copilot reviews and threads, required rules/checks, mergeability, and stack state. Paginate evidence where necessary. Unknown permissions, rules, topology, or provenance are blockers, not empty successful results.

Completion: every selected layer has current identities and an explicit list of available or missing gate evidence.

## 2. Evaluate every gate per layer

| Gate | Required evidence |
| --- | --- |
| Scope and intent | Approved spec/design references and acceptance criteria; the implementation and findings have supported layer ownership. |
| Immediate-base review | Local review and behavioral verification cover the current head against the current immediate base, with exact commands/results and changed behavior accounted for. |
| Synchronization | Native topology and actual PR bases agree; each affected descendant integrates its current parent. No pending cascade, conflicts, or local/remote divergence for the proposed change. |
| Copilot | Completed initial review with actual reviewed SHA and complete findings; at most one conditional re-review. Final-head coverage or explicit current-head human review of the uncovered delta, if policy permits. |
| Dispositions | Every finding has current evidence. Required fixes are implemented and verified; no unresolved question/blocking finding. Advisory declines need no fix commit. Deferrals meet the shared contract. Required conversation resolution is independently satisfied. |
| Checks | Authoritative required-check set is known. Every required check has a current, completed, rule-accepted result with PR-head/tested-commit provenance. Missing checks fail this gate even when every observed check is green. |
| Human approval | Actual, non-dismissed human approval of the current head, required reviewer/owner counts satisfied, and no outstanding changes-requested decision. A bot review or agent-proposed disposition is not human approval. |
| GitHub merge state | PR is open, non-draft, without unresolved merge conflicts; current rules allow the intended native landing order. Queue-required checks are assessed for their actual candidate when available. |

Report each layer separately, then the selected scope. A passing upper layer does not make a blocked prerequisite ready. For a stack, assess readiness for native bottom-up landing, not independent out-of-order merges. An unselected open ancestor is a dependency blocker unless a permitted landing plan includes it with its own passing assessment. Report a stack READY only when all included layers and prerequisites pass for that order.

If a merge queue is required, distinguish queue eligibility from actual merge readiness. Without the required current merge-group evidence, return NOT READY for merge and name queue entry as the separate next operation; do not call PR-head checks queue validation.

## 3. Recheck freshness and report

Re-read remote heads, bases, topology, and applicable review/check state before returning. If anything material moved, invalidate affected gates and report NOT READY rather than silently certifying the old snapshot. A base-only change matters even when the PR head is unchanged.

Return:

```text
READY | NOT READY
observedAt: <time>
scope: <PRs; singleton or native stack; bottom-up landing order>
refs: <per-layer remote head and immediate-base SHAs>
gates: <PR | gate | PASS/BLOCKED | evidence reference or exact gap>
findings: <remaining fixes/questions/deferrals; supported advisory declines>
reviewCoverage: <Copilot SHA, re-review use, any human-reviewed delta>
humanApproval: <reviewer, current-head review reference, outstanding requests>
next: <none for assessment, or specific missing evidence/explicit operation>
```

READY requires every gate to pass. Pending, missing, stale, inaccessible, or contradictory required evidence produces NOT READY with the actual reason. Do not downgrade an advisory decline into a blocker merely because its comment still exists unless conversation-resolution rules require action. READY is a timestamped read-only assessment; the human retains merge authority.
