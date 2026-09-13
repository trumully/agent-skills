import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_VERSION = 1;
const STATES = [
  "new",
  "captured",
  "investigated",
  "proposed",
  "validated",
  "applied",
  "verified",
  "reported",
  "needs_human",
  "blocked",
  "failed",
];
const TRANSITIONS = {
  new: new Set(["captured", "blocked", "failed"]),
  captured: new Set(["investigated", "needs_human", "blocked", "failed"]),
  investigated: new Set(["proposed", "needs_human", "blocked", "failed"]),
  proposed: new Set(["validated", "needs_human", "blocked", "failed"]),
  validated: new Set(["applied", "needs_human", "blocked", "failed"]),
  applied: new Set(["verified", "needs_human", "blocked", "failed"]),
  verified: new Set(["reported", "needs_human", "blocked", "failed"]),
  needs_human: new Set(["investigated", "proposed", "blocked", "failed"]),
  reported: new Set(),
  blocked: new Set(),
  failed: new Set(),
};
const REQUIRED_ARTIFACTS = {
  captured: ["case-snapshot"],
  investigated: ["triage"],
  proposed: ["patch-proposal"],
  validated: ["patch-proposal"],
  applied: ["commit"],
  verified: ["verification"],
  reported: ["report"],
  needs_human: ["exception"],
  blocked: ["exception"],
  failed: ["exception"],
};
const ARTIFACT_TYPES = new Set([
  "case-snapshot",
  "triage",
  "patch-proposal",
  "commit",
  "verification",
  "report",
  "exception",
]);
const EVENT_STATUSES = new Set(["started", "passed", "failed", "blocked"]);


function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseArgs(argv) {
  const values = { _: [] };
  const repeated = new Set(["pr", "artifact"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      values._.push(argument);
      continue;
    }

    const name = argument.slice(2);
    if (!name) {
      throw new Error("empty option name");
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${name}`);
    }
    index += 1;
    if (repeated.has(name)) {
      values[name] ??= [];
      values[name].push(value);
    } else if (values[name] !== undefined) {
      throw new Error(`duplicate option --${name}`);
    } else {
      values[name] = value;
    }
  }

  return values;
}

function requireOption(options, name) {
  return requireString(options[name], `--${name}`);
}

function parsePullRequests(options) {
  const values = options.pr ?? [];
  if (values.length === 0) {
    throw new Error("at least one --pr is required");
  }
  return values.map((value) => requireInteger(Number(value), "--pr"));
}

function parseArtifactSpec(spec) {
  const separator = spec.indexOf("=");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(`artifact must use type=path: ${spec}`);
  }
  const type = spec.slice(0, separator);
  const artifactPath = spec.slice(separator + 1);
  if (!ARTIFACT_TYPES.has(type)) {
    throw new Error(`unsupported artifact type: ${type}`);
  }
  return { type, path: artifactPath };
}

function now() {
  return new Date().toISOString();
}

function parseRevision(value) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error("revision must be a non-negative integer");
  }
  return revision;
}

function runGit(args, cwd, allowFailure = false) {
  const options = { cwd, encoding: "utf8", shell: false };
  let result = spawnSync("git", args, options);
  if (result.error?.code === "ENOENT") {
    result = spawnSync("git.exe", args, options);
  }
  if (result.error) {
    throw new Error("git could not start: " + result.error.message);
  }
  const output = {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  if (output.status !== 0 && !allowFailure) {
    throw new Error("git command failed: git " + args.join(" ") + "\n" + output.stderr.trim());
  }
  return output;
}

function gitText(args, cwd) {
  return runGit(args, cwd).stdout.trim();
}

function inspectGit(repoPath) {
  const requestedRoot = resolve(repoPath);
  const root = gitText(["rev-parse", "--show-toplevel"], requestedRoot);
  const branch = gitText(["branch", "--show-current"], root);
  const head = gitText(["rev-parse", "--verify", "HEAD^{commit}"], root);
  const status = runGit(["status", "--porcelain=v1", "-z"], root).stdout;
  const activeOperations = [];
  for (const name of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    const gitPath = gitText(["rev-parse", "--git-path", name], root);
    const absolutePath = isAbsolute(gitPath) ? gitPath : resolve(root, gitPath);
    if (existsSync(absolutePath)) {
      activeOperations.push(name);
    }
  }
  return { root, branch, head, status, activeOperations };
}

function verifyGitRevision(revision, root) {
  const result = runGit(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", revision + "^{commit}"],
    root,
    true
  );
  if (result.status !== 0) {
    throw new Error("not a valid commit revision: " + revision);
  }
  return result.stdout.trim();
}

function isAncestor(ancestor, descendant, root) {
  return runGit(["merge-base", "--is-ancestor", ancestor, descendant], root, true).status === 0;
}

function requireCleanGit(git) {
  if (!git.branch) {
    throw new Error("Git safety gate requires a checked-out branch");
  }
  if (git.status.length > 0) {
    throw new Error("Git safety gate requires a clean worktree");
  }
  if (git.activeOperations.length > 0) {
    throw new Error("Git safety gate found an active operation: " + git.activeOperations.join(", "));
  }
}

function artifactJson(manifest, manifestPath, type) {
  const record = manifest.artifacts[type];
  if (!record) {
    throw new Error("missing artifact " + type);
  }
  return readJson(resolve(dirname(manifestPath), record.path), type);
}

function commitEvidence(value) {
  const commits = [];
  for (const group of value.groups) {
    for (const commit of group.commits) {
      if (!commits.includes(commit)) {
        commits.push(commit);
      }
    }
  }
  return commits;
}

function verifyCommitEvidence(root, value) {
  const before = verifyGitRevision(value.beforeHead, root);
  const after = verifyGitRevision(value.afterHead, root);
  if (!isAncestor(before, after, root)) {
    throw new Error("verification afterHead does not descend from beforeHead");
  }
  const commits = commitEvidence(value);
  for (const commit of commits) {
    const canonical = verifyGitRevision(commit, root);
    if (!isAncestor(canonical, after, root)) {
      throw new Error("reported commit is not reachable from afterHead: " + commit);
    }
    const changedPaths = runGit(
      ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", canonical],
      root
    ).stdout.trim();
    if (!changedPaths) {
      throw new Error("reported commit has an empty patch: " + commit);
    }
  }
  return { before, after, commits };
}

function validateGitForTransition(manifest, manifestPath, destination, options) {
  if (!["validated", "applied", "verified"].includes(destination)) {
    return null;
  }
  const repoPath = requireOption(options, "repo");
  const git = inspectGit(repoPath);
  requireCleanGit(git);
  const expectedHead = requireOption(options, "head");
  const canonicalExpected = verifyGitRevision(expectedHead, git.root);
  if (canonicalExpected !== git.head) {
    throw new Error("Git HEAD does not match --head: expected " + canonicalExpected + ", actual " + git.head);
  }
  if (manifest.git && (manifest.git.root !== git.root || manifest.git.branch !== git.branch)) {
    throw new Error("Git repository or branch differs from the manifest");
  }
  manifest.git ??= { root: git.root, branch: git.branch, initialHead: git.head };

  if (destination === "applied") {
    const expectedBefore = verifyGitRevision(requireOption(options, "expected-head"), git.root);
    if (!isAncestor(expectedBefore, git.head, git.root)) {
      throw new Error("current HEAD does not descend from --expected-head");
    }
    const result = artifactJson(manifest, manifestPath, "commit");
    if (commitEvidence(result).length === 0) {
      throw new Error("applied transition requires at least one non-empty commit");
    }
    verifyCommitEvidence(git.root, result);
  }
  if (destination === "verified") {
    const result = artifactJson(manifest, manifestPath, "verification");
    if (result.afterHead !== git.head) {
      throw new Error("verification afterHead does not match current Git HEAD");
    }
    verifyCommitEvidence(git.root, result);
  }
  return git;
}

function hashFile(filePath) {
  const contents = readFileSync(filePath);
  return {
    sha256: createHash("sha256").update(contents).digest("hex"),
    bytes: contents.byteLength,
  };
}

function readJson(filePath, description) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${description}: ${error.message}`);
  }
}

function writeJsonAtomic(filePath, value) {
  const absolutePath = resolve(filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, absolutePath);
}

function withManifestLock(manifestPath, action) {
  const absolutePath = resolve(manifestPath);
  const lockPath = absolutePath + ".lock";
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("manifest lock exists; inspect and remove " + lockPath + " only after confirming no writer is active");
    }
    throw error;
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function validateRepository(repository) {
  requireString(repository, "repository");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("repository must use owner/name form");
  }
}

function validateCaseSnapshot(snapshot, manifest) {
  if (!isObject(snapshot)) {
    throw new Error("case-snapshot must be a JSON object");
  }
  if (snapshot.schemaVersion !== MANIFEST_VERSION) {
    throw new Error(`case-snapshot schemaVersion must be ${MANIFEST_VERSION}`);
  }
  requireString(snapshot.capturedAt, "case-snapshot.capturedAt");
  if (!isObject(snapshot.repository)) {
    throw new Error("case-snapshot.repository must be an object");
  }
  const repository = `${snapshot.repository.owner}/${snapshot.repository.name}`;
  if (repository !== manifest.repository) {
    throw new Error(`case-snapshot repository ${repository} does not match ${manifest.repository}`);
  }
  if (!Array.isArray(snapshot.prs) || snapshot.prs.length === 0) {
    throw new Error("case-snapshot.prs must be a non-empty array");
  }
  const snapshotPrs = new Set(snapshot.prs.map((pullRequest) => pullRequest.number));
  for (const pullRequest of manifest.targetPullRequests) {
    if (!snapshotPrs.has(pullRequest)) {
      throw new Error(`case-snapshot is missing pull request ${pullRequest}`);
    }
  }
}

const DISPOSITIONS = new Set(["fix", "decline", "defer", "question"]);
const GROUP_OUTCOMES = new Set(["fixed", "unchanged", "blocked", "question"]);
const CHECK_KINDS = new Set(["format", "lint", "build", "test", "behavior", "git"]);

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(name + " must be an array");
  }
  return value;
}

function validateCommentEntries(comments, name) {
  const refs = new Set();
  for (const [index, comment] of comments.entries()) {
    if (!isObject(comment)) {
      throw new Error(name + "[" + index + "] must be an object");
    }
    requireString(comment.ref, name + "[" + index + "].ref");
    requireString(comment.path, name + "[" + index + "].path");
    if (comment.line !== null && (!Number.isInteger(comment.line) || comment.line <= 0)) {
      throw new Error(name + "[" + index + "].line must be a positive integer or null");
    }
    if (!DISPOSITIONS.has(comment.disposition)) {
      throw new Error(name + "[" + index + "] has an invalid disposition");
    }
    requireString(comment.reason, name + "[" + index + "].reason");
    if (refs.has(comment.ref)) {
      throw new Error(name + " contains duplicate comment ref " + comment.ref);
    }
    refs.add(comment.ref);
    if (comment.disposition === "fix" && typeof comment.groupId !== "string") {
      throw new Error(name + "[" + index + "] fix disposition requires groupId");
    }
    if (comment.disposition !== "fix" && comment.groupId !== null) {
      throw new Error(name + "[" + index + "] non-fix disposition must use groupId null");
    }
  }
  return refs;
}

function validateGroups(groups, commentRefs, name, requireProposalFields) {
  const groupIds = new Set();
  for (const [index, group] of groups.entries()) {
    if (!isObject(group)) {
      throw new Error(name + "[" + index + "] must be an object");
    }
    requireString(group.id, name + "[" + index + "].id");
    if (groupIds.has(group.id)) {
      throw new Error(name + " contains duplicate group " + group.id);
    }
    groupIds.add(group.id);
    const refs = requireArray(group.commentRefs, name + "[" + index + "].commentRefs");
    for (const ref of refs) {
      requireString(ref, name + "[" + index + "].commentRefs entry");
      if (!commentRefs.has(ref)) {
        throw new Error(name + "[" + index + "] references unknown comment " + ref);
      }
    }
    if (requireProposalFields || group.commitKind !== undefined) {
      if (!["fixup", "new"].includes(group.commitKind)) {
        throw new Error(name + "[" + index + "].commitKind must be fixup or new");
      }
      if (group.commitKind === "fixup") {
        requireString(group.targetSha, name + "[" + index + "].targetSha");
      }
      if (group.commitKind === "new") {
        requireString(group.separateWorkRationale, name + "[" + index + "].separateWorkRationale");
      }
    }
  }
  return groupIds;
}

function validateChecks(checks, name) {
  for (const [index, check] of checks.entries()) {
    if (!isObject(check)) {
      throw new Error(name + "[" + index + "] must be an object");
    }
    requireString(check.id, name + "[" + index + "].id");
    requireString(check.command, name + "[" + index + "].command");
    if (check.kind !== undefined && !CHECK_KINDS.has(check.kind)) {
      throw new Error(name + "[" + index + "].kind is invalid");
    }
    if (check.required !== undefined && typeof check.required !== "boolean") {
      throw new Error(name + "[" + index + "].required must be boolean");
    }
  }
}

function validateTriageArtifact(value) {
  if (!isObject(value)) {
    throw new Error("triage artifact must be an object");
  }
  const comments = requireArray(value.comments, "triage.comments");
  const commentRefs = validateCommentEntries(comments, "triage.comments");
  const groups = requireArray(value.groups, "triage.groups");
  validateGroups(groups, commentRefs, "triage.groups", false);
  validateChecks(requireArray(value.checks, "triage.checks"), "triage.checks");
}

function validatePatchProposal(value) {
  if (!isObject(value)) {
    throw new Error("patch-proposal artifact must be an object");
  }
  const comments = requireArray(value.comments, "patch-proposal.comments");
  const commentRefs = validateCommentEntries(comments, "patch-proposal.comments");
  const groups = requireArray(value.groups, "patch-proposal.groups");
  validateGroups(groups, commentRefs, "patch-proposal.groups", true);
  validateChecks(requireArray(value.checks, "patch-proposal.checks"), "patch-proposal.checks");
}

function validateVerificationArtifact(value) {
  if (!isObject(value)) {
    throw new Error("verification artifact must be an object");
  }
  requireInteger(value.pr, "verification.pr");
  requireString(value.branch, "verification.branch");
  requireString(value.beforeHead, "verification.beforeHead");
  requireString(value.afterHead, "verification.afterHead");
  const comments = requireArray(value.comments, "verification.comments");
  const commentRefs = validateCommentEntries(comments, "verification.comments");
  const groups = requireArray(value.groups, "verification.groups");
  const groupIds = validateGroups(groups, commentRefs, "verification.groups", false);
  for (const [index, group] of groups.entries()) {
    if (!GROUP_OUTCOMES.has(group.outcome)) {
      throw new Error("verification.groups[" + index + "].outcome is invalid");
    }
    const commits = requireArray(group.commits, "verification.groups[" + index + "].commits");
    const checks = requireArray(group.checks, "verification.groups[" + index + "].checks");
    requireString(group.reason, "verification.groups[" + index + "].reason");
    checks.forEach((check, checkIndex) => requireString(check, "verification.groups[" + index + "].checks[" + checkIndex + "]"));
    commits.forEach((commit, commitIndex) => requireString(commit, "verification.groups[" + index + "].commits[" + commitIndex + "]"));
    if (group.outcome === "fixed" && commits.length === 0) {
      throw new Error("verification fixed group " + group.id + " must contain a commit");
    }
  }
  for (const [index, comment] of comments.entries()) {
    if (comment.disposition === "fix" && (!comment.groupId || !groupIds.has(comment.groupId))) {
      throw new Error("verification.comments[" + index + "] fix has no valid group");
    }
  }
  const validation = value.validation;
  if (!isObject(validation) || !["pass", "fail", "blocked"].includes(validation.status)) {
    throw new Error("verification.validation.status is invalid");
  }
  requireArray(validation.checks, "verification.validation.checks");
  if (validation.failures !== null && typeof validation.failures !== "string") {
    throw new Error("verification.validation.failures must be a string or null");
  }
  const state = value.state;
  if (!isObject(state) || !["clean", "dirty", "conflict"].includes(state.worktree)) {
    throw new Error("verification.state.worktree is invalid");
  }
  requireArray(state.unexpectedChanges, "verification.state.unexpectedChanges");
}

function validateExceptionArtifact(value) {
  if (!isObject(value)) {
    throw new Error("exception artifact must be an object");
  }
  for (const field of ["decision", "risk", "evidence", "recommendation", "uncertainty"]) {
    requireString(value[field], "exception." + field);
  }
  if (value.options !== undefined) {
    requireArray(value.options, "exception.options");
  }
}

function validateReportArtifact(value) {
  if (!isObject(value)) {
    throw new Error("report artifact must be an object");
  }
  requireString(value.status, "report.status");
  requireArray(value.comments, "report.comments");
  requireArray(value.checks, "report.checks");
}

function validateArtifactContent(type, artifactPath, manifest) {
  const value = readJson(artifactPath, type);
  if (type === "case-snapshot") {
    validateCaseSnapshot(value, manifest);
  } else if (type === "triage") {
    validateTriageArtifact(value);
  } else if (type === "patch-proposal") {
    validatePatchProposal(value);
  } else if (type === "commit" || type === "verification") {
    validateVerificationArtifact(value);
  } else if (type === "exception") {
    validateExceptionArtifact(value);
  } else if (type === "report") {
    validateReportArtifact(value);
  }
}

function validateArtifactRecord(type, record, manifestPath, manifest) {
  if (!isObject(record)) {
    throw new Error(`artifact ${type} must be an object`);
  }
  requireString(record.path, `artifact ${type}.path`);
  requireString(record.sha256, `artifact ${type}.sha256`);
  if (!/^\d+$/.test(String(record.bytes))) {
    throw new Error(`artifact ${type}.bytes must be a non-negative integer`);
  }
  requireString(record.recordedAt, `artifact ${type}.recordedAt`);

  const artifactPath = resolve(dirname(manifestPath), record.path);
  if (!existsSync(artifactPath)) {
    throw new Error(`artifact ${type} is missing: ${artifactPath}`);
  }
  const actual = hashFile(artifactPath);
  if (actual.sha256 !== record.sha256 || actual.bytes !== Number(record.bytes)) {
    throw new Error(`artifact ${type} changed after recording: ${artifactPath}`);
  }

  validateArtifactContent(type, artifactPath, manifest);
}

function validateTransitionRecord(transition, index, previousState, manifestPath, manifest) {
  if (!isObject(transition)) {
    throw new Error(`transition ${index} must be an object`);
  }
  if (transition.from !== previousState) {
    throw new Error(`transition ${index} starts at ${transition.from}, expected ${previousState}`);
  }
  if (!STATES.includes(transition.to)) {
    throw new Error(`transition ${index} has unknown destination ${transition.to}`);
  }
  if (index > 0 && !TRANSITIONS[transition.from]?.has(transition.to)) {
    throw new Error(`transition ${transition.from} -> ${transition.to} is not allowed`);
  }
  requireString(transition.at, `transition ${index}.at`);
  requireString(transition.actor, `transition ${index}.actor`);
  requireString(transition.reason, `transition ${index}.reason`);
  if (transition.head !== undefined) {
    requireString(transition.head, `transition ${index}.head`);
  }
  if (!Array.isArray(transition.artifacts)) {
    throw new Error(`transition ${index}.artifacts must be an array`);
  }
  for (const artifact of transition.artifacts) {
    if (!ARTIFACT_TYPES.has(artifact) || !manifest.artifacts[artifact]) {
      throw new Error(`transition ${index} references an unrecorded artifact: ${artifact}`);
    }
  }
  for (const required of REQUIRED_ARTIFACTS[transition.to] ?? []) {
    if (!transition.artifacts.includes(required) && !manifest.artifacts[required]) {
      throw new Error(`transition ${transition.to} requires artifact ${required}`);
    }
  }
}

function validateManifest(manifest, manifestPath) {
  if (!isObject(manifest)) {
    throw new Error("manifest must be a JSON object");
  }
  if (manifest.schemaVersion !== MANIFEST_VERSION) {
    throw new Error(`manifest schemaVersion must be ${MANIFEST_VERSION}`);
  }
  requireString(manifest.runId, "runId");
  validateRepository(manifest.repository);
  if (!Array.isArray(manifest.targetPullRequests) || manifest.targetPullRequests.length === 0) {
    throw new Error("targetPullRequests must be a non-empty array");
  }
  manifest.targetPullRequests.forEach((pullRequest, index) =>
    requireInteger(pullRequest, `targetPullRequests[${index}]`)
  );
  if (!STATES.includes(manifest.state)) {
    throw new Error(`unknown manifest state: ${manifest.state}`);
  }
  requireString(manifest.createdAt, "createdAt");
  requireString(manifest.updatedAt, "updatedAt");
  if (!Number.isInteger(manifest.revision) || manifest.revision < 0) {
    throw new Error("revision must be a non-negative integer");
  }
  if (manifest.git !== undefined) {
    if (!isObject(manifest.git)) {
      throw new Error("git metadata must be an object");
    }
    requireString(manifest.git.root, "git.root");
    requireString(manifest.git.branch, "git.branch");
    requireString(manifest.git.initialHead, "git.initialHead");
  }
  if (manifest.metadata !== undefined && !isObject(manifest.metadata)) {
    throw new Error("metadata must be an object");
  }
  if (!isObject(manifest.artifacts)) {
    throw new Error("artifacts must be an object");
  }
  for (const [type, record] of Object.entries(manifest.artifacts)) {
    if (!ARTIFACT_TYPES.has(type)) {
      throw new Error(`unknown artifact type: ${type}`);
    }
    validateArtifactRecord(type, record, manifestPath, manifest);
  }
  if (!Array.isArray(manifest.transitions) || manifest.transitions.length === 0) {
    throw new Error("transitions must be a non-empty array");
  }
  let previousState = null;
  manifest.transitions.forEach((transition, index) => {
    validateTransitionRecord(transition, index, previousState, manifestPath, manifest);
    previousState = transition.to;
  });
  if (previousState !== manifest.state) {
    throw new Error(`manifest state ${manifest.state} does not match transition log ${previousState}`);
  }
  if (!Array.isArray(manifest.events)) {
    throw new Error("events must be an array");
  }
  const eventIds = new Set();
  for (const [index, event] of manifest.events.entries()) {
    if (!isObject(event)) {
      throw new Error(`event ${index} must be an object`);
    }
    requireString(event.id, `event ${index}.id`);
    if (eventIds.has(event.id)) {
      throw new Error(`duplicate event id: ${event.id}`);
    }
    eventIds.add(event.id);
    requireString(event.at, `event ${index}.at`);
    requireString(event.stage, `event ${index}.stage`);
    requireString(event.operation, `event ${index}.operation`);
    if (!EVENT_STATUSES.has(event.status)) {
      throw new Error(`event ${index} has unknown status ${event.status}`);
    }
    if (!Array.isArray(event.artifacts)) {
      throw new Error(`event ${index}.artifacts must be an array`);
    }
    for (const artifact of event.artifacts) {
      if (!manifest.artifacts[artifact]) {
        throw new Error(`event ${index} references an unrecorded artifact: ${artifact}`);
      }
    }
  }
  return manifest;
}

function loadManifest(manifestPath) {
  const absolutePath = resolve(manifestPath);
  if (!existsSync(absolutePath)) {
    throw new Error(`manifest does not exist: ${absolutePath}`);
  }
  return { path: absolutePath, value: validateManifest(readJson(absolutePath, "manifest"), absolutePath) };
}

function recordArtifacts(manifest, manifestPath, specs) {
  const recorded = [];
  for (const spec of specs) {
    const absolutePath = resolve(spec.path);
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      throw new Error(`artifact does not exist: ${absolutePath}`);
    }
    const relativePath = relative(dirname(manifestPath), absolutePath) || ".";
    const file = hashFile(absolutePath);
    validateArtifactContent(spec.type, absolutePath, manifest);
    const existing = manifest.artifacts[spec.type];
    if (existing && (existing.path !== relativePath || existing.sha256 !== file.sha256 || Number(existing.bytes) !== file.bytes)) {
      throw new Error(`artifact ${spec.type} is immutable and already records different content`);
    }
    manifest.artifacts[spec.type] ??= {
      path: relativePath,
      sha256: file.sha256,
      bytes: file.bytes,
      recordedAt: now(),
    };
    recorded.push(spec.type);
  }
  return recorded;
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function commandInit(options) {
  const manifestPath = requireOption(options, "out");
  return withManifestLock(manifestPath, () => commandInitUnlocked(options));
}

function commandInitUnlocked(options) {
  const manifestPath = requireOption(options, "out");
  const absolutePath = resolve(manifestPath);
  if (existsSync(absolutePath)) {
    if (options.resume !== "true") {
      throw new Error(`manifest already exists: ${absolutePath}; use --resume true to inspect it`);
    }
    const loaded = loadManifest(absolutePath);
    console.log(JSON.stringify({ manifest: loaded.value, resumed: true }, null, 2));
    return;
  }

  const repository = requireOption(options, "repository");
  validateRepository(repository);
  const targetPullRequests = parsePullRequests(options);
  const metadata = options["metadata-file"]
    ? readJson(resolve(options["metadata-file"]), "run metadata")
    : {};
  if (!isObject(metadata)) {
    throw new Error("run metadata must be a JSON object");
  }
  const timestamp = now();
  const manifest = {
    schemaVersion: MANIFEST_VERSION,
    runId: options["run-id"] ?? randomUUID(),
    repository,
    targetPullRequests,
    metadata,
    revision: 0,
    ...(options.repo ? (() => { const git = inspectGit(options.repo); return { git: { root: git.root, branch: git.branch, initialHead: git.head } }; })() : {}),
    state: "new",
    createdAt: timestamp,
    updatedAt: timestamp,
    artifacts: {},
    transitions: [
      {
        from: null,
        to: "new",
        at: timestamp,
        actor: options.actor ?? "run-state",
        reason: "run initialized",
        artifacts: [],
      },
    ],
    events: [],
  };
  validateManifest(manifest, absolutePath);
  writeJsonAtomic(absolutePath, manifest);
  console.log(JSON.stringify({ manifest, resumed: false }, null, 2));
}

function commandTransition(options) {
  const manifestPath = requireOption(options, "manifest");
  return withManifestLock(manifestPath, () => commandTransitionUnlocked(options));
}

function commandTransitionUnlocked(options) {
  const manifestOption = requireOption(options, "manifest");
  const loaded = loadManifest(manifestOption);
  const manifest = loaded.value;
  const expectedRevision = parseRevision(requireOption(options, "expected-revision"));
  if (manifest.revision !== expectedRevision) {
    throw new Error("manifest revision mismatch: expected " + expectedRevision + ", actual " + manifest.revision);
  }
  const destination = requireOption(options, "to");
  if (!STATES.includes(destination)) {
    throw new Error(`unknown destination state: ${destination}`);
  }
  const reason = requireOption(options, "reason");
  const artifactSpecs = (options.artifact ?? []).map(parseArtifactSpec);
  const artifactTypes = recordArtifacts(manifest, loaded.path, artifactSpecs);
  if (["validated", "applied", "verified"].includes(destination) && !options.head) {
    throw new Error(`transition to ${destination} requires --head <sha>`);
  }
  const required = REQUIRED_ARTIFACTS[destination] ?? [];
  for (const artifact of required) {
    if (!artifactTypes.includes(artifact) && !manifest.artifacts[artifact]) {
      throw new Error(`transition to ${destination} requires --artifact ${artifact}=<path>`);
    }
  }
  validateGitForTransition(manifest, loaded.path, destination, options);

  if (manifest.state === destination) {
    const previous = manifest.transitions.at(-1);
    const requestedArtifacts = [...new Set([...previous.artifacts, ...artifactTypes])];
    if (sameList(requestedArtifacts, previous.artifacts)) {
      validateManifest(manifest, loaded.path);
      console.log(JSON.stringify({ manifest, idempotent: true }, null, 2));
      return;
    }
    throw new Error(`manifest is already in state ${destination} with different evidence`);
  }
  if (!TRANSITIONS[manifest.state]?.has(destination)) {
    throw new Error(`transition ${manifest.state} -> ${destination} is not allowed`);
  }
  const timestamp = now();
  manifest.transitions.push({
    from: manifest.state,
    to: destination,
    at: timestamp,
    actor: options.actor ?? "run-state",
    reason,
    artifacts: [...new Set([...Object.keys(manifest.artifacts).filter((type) => required.includes(type)), ...artifactTypes])],
    ...(options.head ? { head: options.head } : {}),
  });
  manifest.state = destination;
  manifest.revision += 1;
  manifest.updatedAt = timestamp;
  validateManifest(manifest, loaded.path);
  writeJsonAtomic(loaded.path, manifest);
  console.log(JSON.stringify({ manifest, idempotent: false }, null, 2));
}

function commandEvent(options) {
  const manifestPath = requireOption(options, "manifest");
  return withManifestLock(manifestPath, () => commandEventUnlocked(options));
}

function commandEventUnlocked(options) {
  const manifestOption = requireOption(options, "manifest");
  const loaded = loadManifest(manifestOption);
  const manifest = loaded.value;
  const expectedRevision = parseRevision(requireOption(options, "expected-revision"));
  if (manifest.revision !== expectedRevision) {
    throw new Error("manifest revision mismatch: expected " + expectedRevision + ", actual " + manifest.revision);
  }
  const status = requireOption(options, "status");
  if (!EVENT_STATUSES.has(status)) {
    throw new Error(`event status must be one of ${[...EVENT_STATUSES].join(", ")}`);
  }
  const artifactSpecs = (options.artifact ?? []).map(parseArtifactSpec);
  const artifactTypes = recordArtifacts(manifest, loaded.path, artifactSpecs);
  const event = {
    id: randomUUID(),
    at: now(),
    stage: requireOption(options, "stage"),
    operation: requireOption(options, "operation"),
    status,
    detail: options.detail ?? null,
    artifacts: artifactTypes,
  };
  manifest.events.push(event);
  manifest.revision += 1;
  manifest.updatedAt = event.at;
  validateManifest(manifest, loaded.path);
  writeJsonAtomic(loaded.path, manifest);
  console.log(JSON.stringify({ event, manifest }, null, 2));
}

function commandValidate(options) {
  const loaded = loadManifest(requireOption(options, "manifest"));
  validateManifest(loaded.value, loaded.path);
  console.log(
    JSON.stringify(
      {
        valid: true,
        runId: loaded.value.runId,
        state: loaded.value.state,
        artifactTypes: Object.keys(loaded.value.artifacts),
        transitionCount: loaded.value.transitions.length,
        eventCount: loaded.value.events.length,
      },
      null,
      2
    )
  );
}

function printUsage() {
  console.error(`Usage:
  run-state.mjs init --out <manifest> --repository <owner/name> --pr <number> [--pr <number>] [--run-id <id>] [--metadata-file <path>]
  run-state.mjs transition --manifest <manifest> --to <state> --expected-revision <n> --reason <text> [--repo <path>] [--head <sha>] [--expected-head <sha>] [--artifact type=path]
  run-state.mjs event --manifest <manifest> --stage <name> --operation <name> --status <status> --expected-revision <n> [--artifact type=path]
  run-state.mjs validate --manifest <manifest>`);
}

function main(argv) {
  const options = parseArgs(argv);
  const [command] = options._;
  if (command === "init") {
    commandInit(options);
  } else if (command === "transition") {
    commandTransition(options);
  } else if (command === "event") {
    commandEvent(options);
  } else if (command === "validate") {
    commandValidate(options);
  } else {
    printUsage();
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export {
  artifactJson,
  commitEvidence,
  inspectGit,
  isAncestor,
  loadManifest,
  requireCleanGit,
  runGit,
  validateManifest,
  validatePatchProposal,
  validateVerificationArtifact,
  verifyCommitEvidence,
  verifyGitRevision,
};
