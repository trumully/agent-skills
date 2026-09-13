import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const graphQlQuery = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      headRefName
      headRefOid
      baseRefName
      baseRefOid
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
          comments(first:100){
            pageInfo{ hasNextPage endCursor }
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

const threadCommentsQuery = `query($id:ID!,$after:String){
  node(id:$id){
    ... on PullRequestReviewThread{
      comments(first:100, after:$after){
        pageInfo{ hasNextPage endCursor }
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

function parseJson(text, description) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`Could not parse ${description}: ${error.message}`);
  }
}

function hashText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function commentIdentity(path, line, bodyHash) {
  return `${path}:${line ?? "null"}:${bodyHash}`;
}

function parsePaginatedArray(text, description) {
  const pages = parseJson(text, description);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    fail(`Expected paginated arrays for ${description}`);
  }
  return pages.flat();
}

function getOpenPullRequests(repository) {
  const pullRequests = parsePaginatedArray(
    runGh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository.owner}/${repository.name}/pulls?state=open&per_page=100`,
    ]),
    "open pull requests"
  );

  return pullRequests.map((pullRequest) => {
    const normalized = {
      number: pullRequest.number,
      headRefName: pullRequest.head?.ref,
      baseRefName: pullRequest.base?.ref,
      url: pullRequest.html_url,
    };
    if (!normalized.number || !normalized.headRefName || !normalized.baseRefName) {
      fail("Open pull-request response omitted stack fields");
    }
    return normalized;
  });
}

function findStack(prNumber) {
  const repository = getRepository();
  const pullRequests = getOpenPullRequests(repository);
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

function getThreadComments(thread) {
  const comments = [...thread.comments.nodes];
  let after = thread.comments.pageInfo.hasNextPage
    ? thread.comments.pageInfo.endCursor
    : null;

  if (thread.comments.pageInfo.hasNextPage && !after) {
    fail(`Review-comment pagination for thread ${thread.id} returned no cursor`);
  }

  while (after !== null) {
    const response = parseJson(
      runGh(
        ["api", "graphql", "--input", "-"],
        JSON.stringify({
          query: threadCommentsQuery,
          variables: { id: thread.id, after },
        })
      ),
      `replies for review thread ${thread.id}`
    );
    if (response.errors?.length) {
      fail(`GraphQL review-comment query for thread ${thread.id} failed: ${response.errors[0].message}`);
    }

    const nextPage = response.data?.node?.comments;
    if (!nextPage) {
      fail(`Could not load comments for review thread ${thread.id}`);
    }
    comments.push(...nextPage.nodes);
    if (nextPage.pageInfo.hasNextPage && !nextPage.pageInfo.endCursor) {
      fail(`Review-comment pagination for thread ${thread.id} returned no cursor`);
    }
    after = nextPage.pageInfo.hasNextPage ? nextPage.pageInfo.endCursor : null;
  }

  return comments;
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
      const comments = getThreadComments(thread);
      const firstComment = comments[0];
      if (
        thread.isResolved === false &&
        firstComment &&
        ["copilot-pull-request-reviewer", "Copilot"].includes(firstComment.author?.login)
      ) {
        const bodyHash = hashText(firstComment.body);
        threads.push({
          id: thread.id,
          commentId: firstComment.databaseId,
          url: firstComment.url,
          path: thread.path,
          line: thread.line,
          originalLine: thread.originalLine,
          isOutdated: thread.isOutdated,
          body: firstComment.body,
          bodyHash,
          identity: commentIdentity(thread.path, thread.line, bodyHash),
          createdAt: firstComment.createdAt,
          replies: comments.slice(1).map((comment) => ({
            id: comment.databaseId,
            url: comment.url,
            author: comment.author?.login ?? null,
            body: comment.body,
            bodyHash: hashText(comment.body),
            createdAt: comment.createdAt,
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

function getSuppressedComments(repository, prNumber, liveCommentIdentities) {
  const reviews = parsePaginatedArray(
    runGh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository.owner}/${repository.name}/pulls/${prNumber}/reviews?per_page=100`,
    ]),
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
    const bodyHash = hashText(body);
    const line = Number(match[2]);
    if (!liveCommentIdentities.has(commentIdentity(match[1], line, bodyHash))) {
      const reviewCommit = latestReview.commit_id ?? null;
      suppressed.push({
        id: `suppressed:${reviewCommit ?? "unknown"}:${match[1]}:${line}:${bodyHash}`,
        reviewId: latestReview.id ?? null,
        reviewCommit,
        path: match[1],
        line,
        body,
        bodyHash,
        identity: commentIdentity(match[1], line, bodyHash),
        snippet: match[4]?.trimEnd() ?? "",
      });
    }
  }

  return suppressed;
}

function collectComments(prNumbers, outFile) {
  const repository = getRepository();
  const capturedAt = new Date().toISOString();
  const pullRequests = [];

  for (const prNumber of prNumbers) {
    const { pullRequest: metadata, threads } = getReviewThreads(repository, prNumber);
    const suppressed = getSuppressedComments(
      repository,
      prNumber,
      new Set(threads.map((thread) => thread.identity))
    );
    const pullRequest = {
      number: prNumber,
      head: metadata.headRefName,
      headSha: metadata.headRefOid,
      base: metadata.baseRefName,
      baseSha: metadata.baseRefOid,
      url: getPullRequestUrl(prNumber),
      threads,
      suppressed,
    };
    pullRequests.push(pullRequest);
    console.log(
      `#${prNumber} ${pullRequest.head}: ${threads.length} unresolved threads, ${suppressed.length} suppressed`
    );
  }

  writeFileSync(
    outFile,
    `${JSON.stringify({ schemaVersion: 1, capturedAt, repository, prs: pullRequests }, null, 2)}\n`,
    "utf8"
  );
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
  const prValues = outIndex === 0 ? arguments_.slice(2) : [];
  if (!outFile || prValues.length === 0) {
    fail("Usage: copilot-comments.mjs comments --out <file> <pr-number>...");
  }
  collectComments(prValues.map(parsePrNumber), outFile);
} else {
  fail("Usage: copilot-comments.mjs stack <pr-number> | comments --out <file> <pr-number>...");
}
