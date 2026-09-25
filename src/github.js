// Puts line comments on the PR being read, through the GitHub API. Requests
// go via the background worker, which holds the token.
(function (root) {
  const { parsePatch } = root.SpecFocusLines;
  const FILES_PER_PAGE = 100;
  const files = new Map();

  /**
   * The PR file a rendered rich diff belongs to, or null when the markdown
   * isn't a file on a PR's Files changed tab.
   */
  function pullFileOf(body, location) {
    const pull = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\//.exec(location.pathname);
    const holder = body.closest('[data-tagsearch-path], [data-file-path]');
    const path = holder?.dataset.tagsearchPath ?? holder?.dataset.filePath;
    if (!pull || !path) return null;
    return { owner: pull[1], repo: pull[2], number: Number(pull[3]), path };
  }

  async function hasToken() {
    const { token } = await chrome.storage.local.get('token');
    return Boolean(token);
  }

  async function rest(path, { method = 'GET', body } = {}) {
    const response = await chrome.runtime.sendMessage({ type: 'github', path, method, body });
    if (response.error) throw new Error(response.error);
    if (response.status >= 300) throw new Error(problem(response));
    return response.data;
  }

  async function graphql(query, variables) {
    const { data, errors } = await rest('/graphql', { method: 'POST', body: { query, variables } });
    if (errors?.length) throw new Error(errors.map((e) => e.message).join(' '));
    return data;
  }

  function problem({ status, data }) {
    if (status === 401) return "GitHub didn't accept your token. Update it in the Spec Focus options.";
    if (status === 403 || status === 404) return "Your token can't comment on this PR. Check its repository access.";
    const details = (data?.errors ?? []).map((e) => e.message ?? e.code ?? e).filter((e) => typeof e === 'string');
    return [data?.message ?? `GitHub answered ${status}.`, ...details].join(' ');
  }

  /** The PR's head and the file's patch rows, fetched once per page visit. */
  function loadFile(file) {
    const key = `${file.owner}/${file.repo}#${file.number}:${file.path}`;
    if (!files.has(key)) {
      files.set(
        key,
        fetchFile(file).catch((error) => {
          files.delete(key);
          throw error;
        }),
      );
    }
    return files.get(key);
  }

  async function fetchFile({ owner, repo, number, path }) {
    const base = `/repos/${owner}/${repo}/pulls/${number}`;
    const pull = await rest(base);
    for (let page = 1; ; page++) {
      const changed = await rest(`${base}/files?per_page=${FILES_PER_PAGE}&page=${page}`);
      const file = changed.find((f) => f.filename === path);
      // GitHub leaves out the patch of very large diffs; those only take file comments.
      if (file) return { headSha: pull.head.sha, pullId: pull.node_id, rows: file.patch ? parsePatch(file.patch) : [] };
      if (changed.length < FILES_PER_PAGE) throw new Error(`${path} isn't among this PR's files.`);
    }
  }

  /**
   * @param {ReturnType<typeof pullFileOf>} file
   * @param {{ side: 'LEFT' | 'RIGHT', start: number, end: number } | null} lines null for a file comment
   * @param {string} body
   * @param {{ single: boolean }} options single posts now; otherwise it joins
   *   the viewer's pending review, as "Start a review" does on GitHub.
   */
  async function addComment(file, lines, body, { single }) {
    const { headSha, pullId } = await loadFile(file);
    const range = lines && lines.start !== lines.end;
    if (single) {
      const where = lines
        ? { line: lines.end, side: lines.side, ...(range && { start_line: lines.start, start_side: lines.side }) }
        : { subject_type: 'file' };
      await rest(`/repos/${file.owner}/${file.repo}/pulls/${file.number}/comments`, {
        method: 'POST',
        body: { body, commit_id: headSha, path: file.path, ...where },
      });
      return;
    }
    const where = lines
      ? {
          subjectType: 'LINE',
          line: lines.end,
          side: lines.side,
          ...(range && { startLine: lines.start, startSide: lines.side }),
        }
      : { subjectType: 'FILE' };
    await graphql(
      `
        mutation ($input: AddPullRequestReviewThreadInput!) {
          addPullRequestReviewThread(input: $input) {
            thread {
              id
            }
          }
        }
      `,
      { input: { pullRequestReviewId: await pendingReview(pullId), path: file.path, body, ...where } },
    );
  }

  // Looked up every time: the reader may have submitted the review on GitHub
  // since the last comment.
  async function pendingReview(pullId) {
    const { node } = await graphql(
      `
        query ($id: ID!) {
          node(id: $id) {
            ... on PullRequest {
              reviews(states: PENDING, first: 10) {
                nodes {
                  id
                  viewerDidAuthor
                }
              }
            }
          }
        }
      `,
      { id: pullId },
    );
    const mine = node.reviews.nodes.find((review) => review.viewerDidAuthor);
    if (mine) return mine.id;
    const { addPullRequestReview } = await graphql(
      `
        mutation ($id: ID!) {
          addPullRequestReview(input: { pullRequestId: $id }) {
            pullRequestReview {
              id
            }
          }
        }
      `,
      { id: pullId },
    );
    return addPullRequestReview.pullRequestReview.id;
  }

  root.SpecFocusGitHub = { pullFileOf, hasToken, loadFile, addComment };
})(globalThis);
