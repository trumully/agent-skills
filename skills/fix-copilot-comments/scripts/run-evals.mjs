import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const stateTool = join(scriptDir, "run-state.mjs");
const verifier = join(scriptDir, "verify-run.mjs");
const suitePath = join(scriptDir, "..", "evals", "control-plane.json");


function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runNode(file, args, cwd) {
  return spawnSync(process.execPath, [file, ...args], {
    cwd,
    encoding: "utf8",
    shell: false,
  });
}

function runState(args, cwd) {
  const result = runNode(stateTool, args, cwd);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "run-state failed");
  }
  return JSON.parse(result.stdout);
}

function rejectState(args, cwd, expectedText) {
  const result = runNode(stateTool, args, cwd);
  if (result.status === 0) {
    throw new Error("expected run-state rejection");
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes(expectedText)) {
    throw new Error("rejection did not mention " + expectedText + ": " + output);
  }
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", shell: false }).trim();
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed: ${error.stderr ?? error.message}`);
  }
}

function createWorkspace() {
  const directory = mkdtempSync(join(tmpdir(), "copilot-control-eval-"));
  const repo = join(directory, "repo");
  mkdirSync(repo, { recursive: true });
  git(["init"], repo);
  git(["config", "user.email", "eval@example.invalid"], repo);
  git(["config", "user.name", "Control Plane Eval"], repo);
  writeFileSync(join(repo, "README.txt"), "initial\n", "utf8");
  git(["add", "README.txt"], repo);
  git(["commit", "-m", "initial"], repo);
  return { directory, repo };
}

function createBaseArtifacts(workspace, withComment = false) {
  const { directory, repo } = workspace;
  const context = join(directory, "context.json");
  const snapshot = join(directory, "comments.json");
  const plan = join(directory, "plan.json");
  const result = join(directory, "result.json");
  const report = join(directory, "report.json");
  const comment = {
    ref: "thread-1",
    path: "src/eval.js",
    line: 1,
    disposition: "fix",
    groupId: "group-1",
    reason: "fixture correctness issue",
  };
  const planValue = withComment
    ? {
        comments: [comment],
        groups: [{
          id: "group-1",
          commentRefs: [comment.ref],
          commitKind: "new",
          separateWorkRationale: "isolated fixture change",
          paths: [comment.path],
        }],
        checks: [],
      }
    : { comments: [], groups: [], checks: [] };
  writeJson(context, { sourceIds: ["fixture"], refs: { head: "initial" } });
  writeJson(snapshot, {
    schemaVersion: 1,
    capturedAt: "2026-09-13T00:00:00.000Z",
    repository: { owner: "octo", name: "repo" },
    prs: [{
      number: 1,
      head: "main",
      headSha: git(["rev-parse", "HEAD"], repo),
      base: "main",
      baseSha: git(["rev-parse", "HEAD"], repo),
      url: "https://github.com/octo/repo/pull/1",
      threads: [],
      suppressed: [],
    }],
  });
  writeJson(plan, planValue);
  writeJson(result, {
    pr: 1,
    branch: "main",
    beforeHead: "pending",
    afterHead: "pending",
    groups: withComment ? [{
      id: "group-1",
      outcome: "fixed",
      commentRefs: [comment.ref],
      commits: [],
      checks: [],
      reason: "fixture fix",
    }] : [],
    comments: withComment ? [comment] : [],
    validation: { status: "pass", checks: [], failures: null },
    state: { worktree: "clean", unexpectedChanges: [] },
  });
  writeJson(report, { status: "reported", comments: withComment ? [comment] : [], checks: [] });
  return { directory, repo, context, snapshot, plan, result, report };
}

function initRun(files, repo) {
  const manifest = join(files.directory, "run.json");
  const initialized = runState([
    "init",
    "--out", manifest,
    "--repository", "octo/repo",
    "--pr", "1",
    "--repo", repo,
    "--metadata-file", files.context,
    "--run-id", "control-plane-eval",
  ], files.directory);
  return { manifest, revision: initialized.manifest.revision };
}

function transition(files, state, revision, extra = []) {
  const output = runState([
    "transition",
    "--manifest", files.manifest,
    "--to", state,
    "--reason", state + " fixture transition",
    "--expected-revision", String(revision),
    ...extra,
  ], files.directory);
  return output.manifest.revision;
}

function runValidLifecycle() {
  const workspace = createWorkspace();
  try {
    const files = createBaseArtifacts(workspace, true);
    const run = initRun(files, workspace.repo);
    files.manifest = run.manifest;
    let revision = transition(files, "captured", run.revision, ["--artifact", "case-snapshot=" + files.snapshot]);
    revision = transition(files, "investigated", revision, ["--artifact", "triage=" + files.plan]);
    revision = transition(files, "proposed", revision, ["--artifact", "patch-proposal=" + files.plan]);
    const beforeHead = git(["rev-parse", "HEAD"], workspace.repo);
    revision = transition(files, "validated", revision, ["--repo", workspace.repo, "--head", beforeHead]);
    mkdirSync(join(workspace.repo, "src"), { recursive: true });
    writeFileSync(join(workspace.repo, "src", "eval.js"), "export const fixed = true;\n", "utf8");
    git(["add", "src/eval.js"], workspace.repo);
    git(["commit", "-m", "fixture fix"], workspace.repo);
    const afterHead = git(["rev-parse", "HEAD"], workspace.repo);
    const result = JSON.parse(readFileSync(files.result, "utf8"));
    result.beforeHead = beforeHead;
    result.afterHead = afterHead;
    result.groups[0].commits = [afterHead];
    writeJson(files.result, result);
    revision = transition(files, "applied", revision, ["--repo", workspace.repo, "--head", afterHead, "--expected-head", beforeHead, "--artifact", "commit=" + files.result]);
    revision = transition(files, "verified", revision, ["--repo", workspace.repo, "--head", afterHead, "--artifact", "verification=" + files.result]);
    transition(files, "reported", revision, ["--artifact", "report=" + files.report]);
    const verification = runNode(verifier, ["--manifest", files.manifest, "--repo", workspace.repo, "--state", "reported"], files.directory);
    if (verification.status !== 0) {
      throw new Error(verification.stderr.trim() || "independent verifier rejected valid lifecycle");
    }
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
}

function runInvalidTriage() {
  const workspace = createWorkspace();
  try {
    const files = createBaseArtifacts(workspace);
    const run = initRun(files, workspace.repo);
    files.manifest = run.manifest;
    const badPlan = JSON.parse(readFileSync(files.plan, "utf8"));
    badPlan.comments = [{ ref: "bad", path: "src/eval.js", line: 1, disposition: "fix", groupId: null, reason: "bad" }];
    writeJson(files.plan, badPlan);
    const revision = transition(files, "captured", run.revision, ["--artifact", "case-snapshot=" + files.snapshot]);
    rejectState([
      "transition", "--manifest", files.manifest, "--to", "investigated", "--reason", "bad triage",
      "--expected-revision", String(revision), "--artifact", "triage=" + files.plan,
    ], files.directory, "requires groupId");
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
}

function runStaleArtifact() {
  const workspace = createWorkspace();
  try {
    const files = createBaseArtifacts(workspace);
    const run = initRun(files, workspace.repo);
    files.manifest = run.manifest;
    transition(files, "captured", run.revision, ["--artifact", "case-snapshot=" + files.snapshot]);
    writeFileSync(files.snapshot, `${readFileSync(files.snapshot, "utf8")}\n`, "utf8");
    rejectState(["validate", "--manifest", files.manifest], files.directory, "changed after recording");
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
}

function runGitHeadMismatch() {
  const workspace = createWorkspace();
  try {
    const files = createBaseArtifacts(workspace);
    const run = initRun(files, workspace.repo);
    files.manifest = run.manifest;
    let revision = transition(files, "captured", run.revision, ["--artifact", "case-snapshot=" + files.snapshot]);
    revision = transition(files, "investigated", revision, ["--artifact", "triage=" + files.plan]);
    revision = transition(files, "proposed", revision, ["--artifact", "patch-proposal=" + files.plan]);
    rejectState([
      "transition", "--manifest", files.manifest, "--to", "validated", "--reason", "wrong head",
      "--expected-revision", String(revision), "--repo", workspace.repo, "--head", "NOT_A_GIT_SHA",
    ], files.directory, "not a valid commit revision");
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
}

function runLockContention() {
  const workspace = createWorkspace();
  try {
    const files = createBaseArtifacts(workspace);
    const run = initRun(files, workspace.repo);
    files.manifest = run.manifest;
    writeFileSync(files.manifest + ".lock", "held\n", "utf8");
    rejectState([
      "event", "--manifest", files.manifest, "--stage", "eval", "--operation", "lock", "--status", "started",
      "--expected-revision", String(run.revision),
    ], files.directory, "manifest lock exists");
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
}

function runRevisionConflict() {
  const workspace = createWorkspace();
  try {
    const files = createBaseArtifacts(workspace);
    const run = initRun(files, workspace.repo);
    files.manifest = run.manifest;
    runState([
      "event", "--manifest", files.manifest, "--stage", "eval", "--operation", "first", "--status", "passed",
      "--expected-revision", String(run.revision),
    ], files.directory);
    rejectState([
      "event", "--manifest", files.manifest, "--stage", "eval", "--operation", "stale", "--status", "passed",
      "--expected-revision", String(run.revision),
    ], files.directory, "revision mismatch");
  } finally {
    rmSync(workspace.directory, { recursive: true, force: true });
  }
}

const CASE_HANDLERS = {
  "valid-lifecycle": runValidLifecycle,
  "invalid-triage-schema": runInvalidTriage,
  "stale-artifact": runStaleArtifact,
  "git-head-mismatch": runGitHeadMismatch,
  "manifest-lock": runLockContention,
  "revision-conflict": runRevisionConflict,
};

function main() {
  const suite = JSON.parse(readFileSync(suitePath, "utf8"));
  if (suite.schemaVersion !== 1 || !Array.isArray(suite.cases)) {
    throw new Error("invalid control-plane evaluation suite");
  }
  const results = [];
  for (const testCase of suite.cases) {
    const handler = CASE_HANDLERS[testCase.id];
    if (!handler) {
      results.push({ id: testCase.id, status: "fail", error: "missing handler" });
      continue;
    }
    try {
      handler();
      results.push({ id: testCase.id, expected: testCase.expected, status: "pass" });
    } catch (error) {
      results.push({ id: testCase.id, expected: testCase.expected, status: "fail", error: error.message });
    }
  }
  const passed = results.filter((result) => result.status === "pass").length;
  const output = {
    suite: suite.suite,
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    results,
  };
  console.log(JSON.stringify(output, null, 2));
  if (output.failed > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
