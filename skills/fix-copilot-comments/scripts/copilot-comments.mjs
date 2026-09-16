import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const graphQlQuery = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      headRefName
      headRefOid
      reviewThreads(first:100, after:$after){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          diffSide
          comments(first:50){
            nodes{
              databaseId
              url
              author{ login }
              body
              createdAt
            }
          }
        }
      }
    }
  }
}`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runGh(args, input) {
  const options = { encoding: "utf8", input, shell: false };
  let result = spawnSync("gh", args, options);

  if (result.error?.code === "ENOENT") {
    result = spawnSync("gh.exe", args, options);
  }

  if (result.error) {
    fail(result.error.message);
  }

  if (result.status !== 0) {
    console.error(result.stderr || `gh exited with status ${result.status}`);
    process.exit(1);
  }

  return result.stdout;
}
function tryRunGh(args) {
  const options = { encoding: "utf8", shell: false };
  let result = spawnSync("gh", args, options);

  if (result.error?.code === "ENOENT") {
    result = spawnSync("gh.exe", args, options);
  }

  if (result.error || result.status !== 0) {
    return null;
  }

  return result.stdout;
}

function parseJson(text, description) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`Could not parse ${description}: ${error.message}`);
  }
}

function getOpenPullRequests() {
  return parseJson(
    runGh([
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,headRefName,baseRefName,url",
    ]),
    "open pull requests"
  );
}

function findStackFromPullRequests(prNumber) {
  const pullRequests = getOpenPullRequests();
  const selected = pullRequests.find((pullRequest) => pullRequest.number === prNumber);
  if (!selected) {
    fail(`PR ${prNumber} is not open`);
  }

  const below = [];
  const visitedHeads = new Set([selected.headRefName]);
  let current = selected;
  while (true) {
    const parent = pullRequests.find(
      (pullRequest) => pullRequest.headRefName === current.baseRefName
    );
    if (!parent) {
      break;
    }
    if (visitedHeads.has(parent.headRefName)) {
      fail(`cycle in stack at ${parent.headRefName}`);
    }
    visitedHeads.add(parent.headRefName);
    below.unshift(parent);
    current = parent;
  }

  const above = [];
  current = selected;
  while (true) {
    const children = pullRequests.filter(
      (pullRequest) => pullRequest.baseRefName === current.headRefName
    );
    if (children.length > 1) {
      fail(
        `ambiguous stack above ${current.headRefName}: ${children
          .map((pullRequest) => `#${pullRequest.number}`)
          .join(", ")}`
      );
    }
    if (children.length === 0) {
      break;
    }

    const child = children[0];
    if (visitedHeads.has(child.headRefName)) {
      fail(`cycle in stack at ${child.headRefName}`);
    }
    visitedHeads.add(child.headRefName);
    above.push(child);
    current = child;
  }

  const orderedPullRequests = [...below, selected, ...above];
  return {
    trunk: below.length === 0 ? selected.baseRefName : below[0].baseRefName,
    prs: orderedPullRequests.map((pullRequest) => ({
      number: pullRequest.number,
      head: pullRequest.headRefName,
      base: pullRequest.baseRefName,
      url: pullRequest.url,
    })),
  };
}

function findStackWithGhStack(prNumber) {
  const output = tryRunGh(["stack", "view", "--json"]);
  if (output === null) {
    return null;
  }

  let stack;
  try {
    stack = JSON.parse(output);
  } catch {
    return null;
  }

  if (!stack || typeof stack.trunk !== "string" || !Array.isArray(stack.branches)) {
    return null;
  }

  const branches = stack.branches.filter(
    (branch) => branch && typeof branch.name === "string" && branch.pr && Number.isInteger(branch.pr.number)
  );
  const selected = branches.find((branch) => branch.pr.number === prNumber);
  const hasNonOpenBranch = branches.some(
    (branch) => branch.pr.state !== undefined && branch.pr.state !== "OPEN"
  );
  if (!selected || hasNonOpenBranch) {
    return null;
  }

  return {
    trunk: stack.trunk,
    prs: branches.map((branch, index) => ({
      number: branch.pr.number,
      head: branch.name,
      base: index === 0 ? stack.trunk : branches[index - 1].name,
      url: branch.pr.url,
    })),
  };
}

function findStack(prNumber) {
  return findStackWithGhStack(prNumber) ?? findStackFromPullRequests(prNumber);
}

function getRepository() {
  const fields = runGh([
    "repo",
    "view",
    "--json",
    "owner,name",
    "--jq",
    ".owner.login + \" \" + .name",
  ])
    .trim()
    .split(/\s+/);

  if (fields.length !== 2) {
    fail("Could not determine repository owner and name");
  }

  return { owner: fields[0], name: fields[1] };
}

function getPullRequestUrl(prNumber) {
  return runGh(["pr", "view", String(prNumber), "--json", "url", "--jq", ".url"]).trim();
}

function getReviewThreads(repository, prNumber) {
  const threads = [];
  let pullRequestMetadata;
  let after = null;

  do {
    const response = parseJson(
      runGh(
        ["api", "graphql", "--input", "-"],
        JSON.stringify({
          query: graphQlQuery,
          variables: {
            owner: repository.owner,
            name: repository.name,
            number: prNumber,
            after,
          },
        })
      ),
      `review threads for PR ${prNumber}`
    );
    if (response.errors?.length) {
      fail(`GraphQL review-thread query for PR ${prNumber} failed: ${response.errors[0].message}`);
    }

    const pullRequest = response.data?.repository?.pullRequest;
    if (!pullRequest) {
      fail(`Could not find PR ${prNumber}`);
    }
    pullRequestMetadata ??= pullRequest;

    const reviewThreads = pullRequest.reviewThreads;
    for (const thread of reviewThreads.nodes) {
      const comments = thread.comments.nodes;
      const firstComment = comments[0];
      if (
        thread.isResolved === false &&
        firstComment &&
        ["copilot-pull-request-reviewer", "Copilot"].includes(firstComment.author?.login)
      ) {
        threads.push({
          id: thread.id,
          url: firstComment.url,
          path: thread.path,
          line: thread.line,
          originalLine: thread.originalLine,
          isOutdated: thread.isOutdated,
          body: firstComment.body,
          replies: comments.slice(1).map((comment) => ({
            author: comment.author?.login ?? null,
            body: comment.body,
          })),
        });
      }
    }

    if (reviewThreads.pageInfo.hasNextPage && !reviewThreads.pageInfo.endCursor) {
      fail(`Review thread pagination for PR ${prNumber} returned no cursor`);
    }
    after = reviewThreads.pageInfo.hasNextPage ? reviewThreads.pageInfo.endCursor : null;
  } while (after !== null);

  return { pullRequest: pullRequestMetadata, threads };
}

function getSuppressedComments(repository, prNumber, threadBodies) {
  const reviews = parseJson(
    runGh(["api", `repos/${repository.owner}/${repository.name}/pulls/${prNumber}/reviews`]),
    `reviews for PR ${prNumber}`
  );
  const latestReview = reviews
    .filter((review) => review.user?.login === "copilot-pull-request-reviewer[bot]")
    .sort(
      (left, right) =>
        (Date.parse(right.submitted_at ?? "") || 0) -
        (Date.parse(left.submitted_at ?? "") || 0)
    )[0];

  if (!latestReview?.body) {
    return [];
  }

  const section = latestReview.body.match(/^### Suppressed comments \(\d+\)\s*$/m);
  if (!section || section.index === undefined) {
    return [];
  }

  const suppressedSection = latestReview.body.slice(section.index + section[0].length);
  const entryPattern =
    /^\*\*(.+?):(\d+)\*\*\r?\n\* ([\s\S]*?)(?:\r?\n```[^\n]*\r?\n([\s\S]*?)\r?\n```)?(?=\r?\n\*\*|\r?\n- \*\*|\r?\n<\/details>|\s*$)/gm;
  const suppressed = [];

  for (const match of suppressedSection.matchAll(entryPattern)) {
    const body = match[3].trimEnd();
    if (!threadBodies.has(body)) {
      suppressed.push({
        reviewCommit: latestReview.commit_id,
        path: match[1],
        line: Number(match[2]),
        body,
        snippet: match[4]?.trimEnd() ?? "",
      });
    }
  }

  return suppressed;
}

function collectComments(prNumbers, outFile) {
  const repository = getRepository();
  const pullRequests = [];

  for (const prNumber of prNumbers) {
    const { pullRequest: metadata, threads } = getReviewThreads(repository, prNumber);
    const suppressed = getSuppressedComments(
      repository,
      prNumber,
      new Set(threads.map((thread) => thread.body))
    );
    const pullRequest = {
      number: prNumber,
      head: metadata.headRefName,
      headSha: metadata.headRefOid,
      url: getPullRequestUrl(prNumber),
      threads,
      suppressed,
    };
    pullRequests.push(pullRequest);
    console.log(
      `#${prNumber} ${pullRequest.head}: ${threads.length} unresolved threads, ${suppressed.length} suppressed`
    );
  }

  writeFileSync(outFile, `${JSON.stringify({ prs: pullRequests }, null, 2)}\n`, "utf8");
}


function parsePrNumber(value) {
  if (!/^\d+$/.test(value)) {
    fail(`Invalid PR number: ${value}`);
  }
  return Number(value);
}

const [command, ...arguments_] = process.argv.slice(2);
if (command === "stack" && arguments_.length === 1) {
  console.log(JSON.stringify(findStack(parsePrNumber(arguments_[0]))));
} else if (command === "comments") {
  const outIndex = arguments_.indexOf("--out");
  const outFile = outIndex === 0 ? arguments_[1] : undefined;
  const prValues =
    outIndex === 0 ? arguments_.slice(2) : [];
  if (!outFile || prValues.length === 0) {
    fail("Usage: copilot-comments.mjs comments --out <file> <pr-number>...");
  }
  collectComments(prValues.map(parsePrNumber), outFile);
} else {
  fail("Usage: copilot-comments.mjs stack <pr-number> | comments --out <file> <pr-number>...");
}
