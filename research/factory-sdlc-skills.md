# Factory-style SDLC skills

## Scope

This note evaluates the requested workflow: specification, design, implementation, local understanding and review, Copilot review, triage, correction, human review, and approval. It also considers regular and stacked pull requests.

## Factory model findings

The reference paper describes an AI-driven SDLC in which implementation compresses from weeks to minutes or hours while requirements, architecture, and verification remain human-paced. It identifies specification quality as the new bottleneck and says that specifications become evaluation criteria. (Reference PDF, pp. 19–22.)

Its factory model consists of:

- specifications and context;
- agents that translate specifications into implementation;
- tests and quality gates;
- feedback loops that route failures back to agents; and
- guardrails that constrain agent behavior.

The developer designs the system and quality control rather than assembling every code artifact manually. The paper explicitly retains human judgment for architecture, maintainability, strategic alignment, and verification. (Reference PDF, pp. 23–25, 43–48.)

The paper's quality flywheel is benchmark/evaluation, root-cause diagnosis, prompt or tool improvement, regression verification, and production monitoring. It also describes a `think -> act -> observe` retry loop, with hooks and observability for audit and cost/latency tracking. (Reference PDF, pp. 23, 30.)

The paper distinguishes a conductor mode, where the developer directs each change, from an orchestrator mode, where the developer assigns goals and reviews results periodically. It warns that directing every keystroke becomes a bottleneck. (Reference PDF, pp. 33, 36.)

Source: [The New SDLC With Vibe Coding](https://drive.google.com/file/d/1IR7CddF_2FyQo_PdfBNTaEA50EGiVt2r/view).

## Existing repository capability

This repository already has several factory components:

- [`skills/fix-copilot-comments/SKILL.md`](../skills/fix-copilot-comments/SKILL.md) collects and triages unresolved or suppressed Copilot comments, understands a complete open stack, and defines `fix`, `decline`, `defer`, and `question` dispositions. It deliberately does not push, synchronize stacks, write to GitHub, reply to comments, or resolve threads.
- [`skills/fix-copilot-comments/scripts/copilot-comments.mjs`](../skills/fix-copilot-comments/scripts/copilot-comments.mjs) discovers stack topology through `ghstack` when available or GitHub pull-request metadata, and collects review threads and suppressed Copilot comments.
- [`skills/stage-fixup/SKILL.md`](../skills/stage-fixup/SKILL.md) creates focused local fixup commits and keeps remote operations separate.
- [`agents/copilot-comment-executor.md`](../agents/copilot-comment-executor.md) provides the branch-local execution role.
- [`research/agent-skills-measurement.md`](./agent-skills-measurement.md) provides a basis for measuring skill conformance, activation, quality, reliability, cost, and side effects.

The main missing components are the pre-PR specification/design/understanding gates, a review-pass state machine, CI-failure routing, and a final review/merge-readiness packet.

## Mature building blocks

Prefer thin adapters over new implementations:

- [GitHub Spec Kit](https://github.com/github/spec-kit) already provides agent skills for constitution, specification, planning, tasks, implementation, and convergence. Its documented feature flow is `specify -> plan -> tasks -> implement -> converge`, with implement/converge repeated until convergence. This is a strong starting point for the pre-PR lane.
- [GitHub Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review) supports automatic or manually requested reviews, Lite/Balanced effort levels, repository custom instructions, and relevant agent skills from the pull-request head branch. Unless configured to review every push, Copilot reviews a pull request once; subsequent reviews can be requested manually. Copilot review consumes AI credits, and its approval is not a substitute for human approval by default.
- [GitHub Actions events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) provide `pull_request` events such as `opened`, `synchronize`, and `reopened`, plus review and comment events. They also provide `merge_group` for merge-queue checks.
- [GitHub merge queues](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) validate queued changes against the current base and earlier queued changes. Required Actions checks must include the `merge_group` trigger.
- [ghstack](https://github.com/ezyang/ghstack) submits each commit in a local stack as a separate GitHub pull request and updates the stack as a unit. Its README documents the constraint that ghstack-created pull requests should be landed with `ghstack land`, not the ordinary GitHub UI.
- [Git Town](https://www.git-town.com/) is a general Git workflow tool with support for common branching models and stacked changes.
- [Graphite stacking](https://www.stacking.dev/) and [Graphite CI optimizations](https://graphite.com/docs/stacking-and-ci) provide a hosted stack workflow and optional rules for reducing redundant CI runs. Graphite documents that stacked PRs can add CI runs during rebases and that its optimizer skips CI only under configured conditions, not for merge-queue validation.

## Recommended design

Normalize every target into an ordered topology: a regular pull request is a one-item stack; a stacked target is an ordered list of `{pr, branch, base, headSha}` entries. Every review decision and check result must be pinned to a head SHA. A lower-branch fix may require explicit descendant synchronization, but a comment collected for one pull request must not silently authorize edits to another.

Add these narrow skills, in priority order:

1. **Spec quality gate** — use Spec Kit artifacts; enforce goals, non-goals, acceptance criteria, edge cases, invariants, and unresolved questions. Human approval remains required.
2. **Design decision gate** — produce or update an ADR/design artifact covering interfaces, dependencies, migrations, rollback, and trade-offs. Human approval remains required.
3. **Repository understanding** — read-only map of relevant files, conventions, call paths, invariants, and validation commands. Output a short understanding packet the author can verify.
4. **Local verification and review** — trace acceptance criteria to implementation and checks; run repository-defined tests, linters, type checks, security checks, and targeted smoke scenarios. Do not treat “tests passed” as understanding.
5. **PR/stack packet** — generate the PR body, stack map, dependency order, risk summary, changed-surface summary, and verification evidence for either one PR or a stack.
6. **Copilot review gate** — request or observe one review for a pinned head SHA, preserve the raw review snapshot, and record effort level and timing. Do not make “zero Copilot comments” the success condition.
7. **Review convergence** — reuse the existing `fix-copilot-comments` workflow and `stage-fixup` skill; add only the orchestration that batches fixes, reruns local verification, and decides whether a re-review is warranted.
8. **CI failure triage** — classify a failed check as code, test, environment, flaky, or infrastructure; attach logs and the exact SHA; route code failures to an agent and avoid blind reruns.
9. **Human review packet** — present the spec/design, understanding packet, diff/stack map, Copilot dispositions, local evidence, CI status, and open questions in one place.
10. **Merge readiness** — validate branch topology, required checks, approval state, merge-queue readiness, and explicit stack landing rules. Keep pushing, synchronizing, replying, and merging behind explicit commands.
11. **Factory evaluation** — use the existing skill-measurement guidance to measure activation, outcome quality, latency, token/CI cost, reliability, and unsafe side effects before expanding automation.

## Review-loop recommendation

Use one Copilot review after local verification and before human review. After addressing comments, request at most one batched re-review when substantive code changed, a security/data-integrity issue was fixed, or the first review was against a stale head. Otherwise, rerun local verification and proceed to human review.

The terminal condition is not “no comments.” It is: every comment has an evidence-backed disposition, required fixes are implemented, local and CI checks pass for the current head, and the human reviewer has enough context to approve. Additional Copilot passes should be explicit exceptions because each pass can cost AI credits and introduce new suggestions.

## Sources

- Factory PDF: <https://drive.google.com/file/d/1IR7CddF_2FyQo_PdfBNTaEA50EGiVt2r/view>
- GitHub Copilot code review: <https://docs.github.com/en/copilot/concepts/agents/code-review>
- GitHub Actions events: <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows>
- GitHub merge queues: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue>
- GitHub Spec Kit: <https://github.com/github/spec-kit>
- ghstack: <https://github.com/ezyang/ghstack>
- Git Town: <https://www.git-town.com/>
- Stacking workflow: <https://www.stacking.dev/>
- Graphite CI optimizations: <https://graphite.com/docs/stacking-and-ci>
## Native GitHub stacking update

The repository uses GitHub native stacked pull requests with the `gh stack` GitHub CLI extension. This supersedes the earlier recommendation to choose ghstack, Git Town, or Graphite as the stack manager; those are alternatives, not required dependencies here.

GitHub provides the stack lifecycle, including dependency order, branch tracking, rebasing, pushing, pull-request linkage, layer navigation, cascading review fixes, stack-aware merging, and programmatic stack metadata. The feature is documented as public preview, so the local adapter should isolate the GitHub metadata shape.

For automation, use native stack metadata or `gh stack` rather than implementing custom stack discovery. Keep the normalized internal record `{pr, branch, base, headSha}` because regular pull requests have no stack object and because reviews, findings, checks, and packets must remain pinned to a specific head SHA. A fix for a lower layer belongs on that branch, followed by `gh stack rebase` and `gh stack push` so higher layers receive it.

GitHub Actions runs pull-request workflows for every layer in a stack. Use `github.event.pull_request.stack` to gate expensive jobs at the lowest unmerged layer or the top layer, while retaining fast checks on every layer. Keep merge-queue validation authoritative and do not skip required checks for `merge_group`.

Additional primary sources:

- GitHub stacked pull requests: <https://docs.github.com/en/pull-requests/get-started/about-stacked-prs>
- Reviewing stacked pull requests: <https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-stacked-pull-requests>
- Optimizing CI for stacked pull requests: <https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/optimizing-ci-for-stacked-pull-requests>
