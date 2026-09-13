import {
  artifactJson,
  inspectGit,
  loadManifest,
  requireCleanGit,
  runGit,
  validatePatchProposal,
  validateVerificationArtifact,
  verifyCommitEvidence,
} from "./run-state.mjs";


function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error("unexpected argument: " + argument);
    }
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --" + name);
    }
    if (options[name] !== undefined) {
      throw new Error("duplicate option --" + name);
    }
    options[name] = value;
    index += 1;
  }
  return options;
}

function requireOption(options, name) {
  if (!options[name]) {
    throw new Error("--" + name + " is required");
  }
  return options[name];
}

function asSet(values) {
  return new Set(values);
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function commitPaths(root, commit) {
  const output = runGit(
    ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit],
    root
  ).stdout;
  return output.split("\0").filter(Boolean);
}

function verifyApprovedPaths(root, proposal, verification) {
  const proposals = new Map(proposal.groups.map((group) => [group.id, group]));
  const seenCommits = new Set();
  for (const group of verification.groups) {
    const approved = proposals.get(group.id);
    if (!approved) {
      throw new Error("verification group is not in the approved patch proposal: " + group.id);
    }
    const approvedPaths = approved.paths ?? approved.affectedPaths ?? [];
    if (!Array.isArray(approvedPaths)) {
      throw new Error("approved group paths must be an array: " + group.id);
    }
    for (const commit of group.commits) {
      if (seenCommits.has(commit)) {
        throw new Error("commit appears in more than one verification group: " + commit);
      }
      seenCommits.add(commit);
      if (approvedPaths.length === 0) {
        continue;
      }
      const changedPaths = commitPaths(root, commit);
      for (const changedPath of changedPaths) {
        if (!approvedPaths.includes(changedPath)) {
          throw new Error("commit changed an unapproved path: " + changedPath);
        }
      }
    }
  }
}

function verifyRun(options) {
  const manifestOption = requireOption(options, "manifest");
  const loaded = loadManifest(manifestOption);
  const manifest = loaded.value;
  const expectedState = options.state ?? "reported";
  if (!["verified", "reported"].includes(expectedState)) {
    throw new Error("--state must be verified or reported");
  }
  if (manifest.state !== expectedState) {
    throw new Error("manifest state is " + manifest.state + ", expected " + expectedState);
  }

  const git = inspectGit(requireOption(options, "repo"));
  requireCleanGit(git);
  if (!manifest.git || manifest.git.root !== git.root || manifest.git.branch !== git.branch) {
    throw new Error("Git repository or branch does not match the manifest");
  }

  const verification = artifactJson(manifest, loaded.path, "verification");
  validateVerificationArtifact(verification);
  if (verification.validation.status !== "pass") {
    throw new Error("verification artifact does not report validation status pass");
  }
  if (verification.afterHead !== git.head) {
    throw new Error("verification afterHead does not match current Git HEAD");
  }
  const evidence = verifyCommitEvidence(git.root, verification);
  if (verification.groups.some((group) => group.outcome === "fixed") && evidence.commits.length === 0) {
    throw new Error("fixed verification groups contain no commit evidence");
  }

  const proposal = artifactJson(manifest, loaded.path, "patch-proposal");
  validatePatchProposal(proposal);
  const proposalRefs = asSet(proposal.comments.map((comment) => comment.ref));
  const verificationRefs = asSet(verification.comments.map((comment) => comment.ref));
  if (!sameSet(proposalRefs, verificationRefs)) {
    throw new Error("verification does not account for exactly the proposed comments");
  }
  verifyApprovedPaths(git.root, proposal, verification);

  const diffCheck = runGit(
    ["diff", "--check", verification.beforeHead + ".." + verification.afterHead],
    git.root
  );
  if (diffCheck.status !== 0) {
    throw new Error("final range failed git diff --check");
  }

  if (manifest.state === "reported") {
    artifactJson(manifest, loaded.path, "report");
  }
  return {
    valid: true,
    independent: true,
    runId: manifest.runId,
    state: manifest.state,
    branch: git.branch,
    beforeHead: verification.beforeHead,
    afterHead: verification.afterHead,
    commits: evidence.commits,
    checkedComments: verification.comments.length,
  };
}

try {
  console.log(JSON.stringify(verifyRun(parseArgs(process.argv.slice(2))), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
